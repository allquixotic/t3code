import http from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { attachHubGateway } from "../src/gateway.ts";
import { call } from "../src/io.ts";
import { hubOnly } from "./maintain.ts";
import type { EnvironmentStatus } from "../src/types.ts";
import { shellQuote } from "../src/ssh.ts";

hubOnly();
const [action, alias, mode = "revoke"] = process.argv.slice(2);
if (!alias || !/^[A-Za-z0-9_.-]+$/.test(alias))
  throw new Error("Supply one enrolled environment alias");
const socketPath = "/run/hub-broker/worker.sock";
const api = (method: string, suffix: string, body?: unknown) =>
  call(method, `http://hub/v1/environments/${alias}${suffix}`, body, {
    socketPath,
    signal: AbortSignal.timeout(15000),
  }) as Promise<EnvironmentStatus>;
if (action === "request") {
  const seconds = process.argv[4] === undefined ? 300 : Number(process.argv[4]);
  if (![60, 300].includes(seconds))
    throw new Error("Diagnostic request duration must be 60 or 300 seconds");
  const status = await api("POST", "/connect", { requested_seconds: seconds });
  console.log(
    JSON.stringify({ alias: status.alias, phase: status.phase, approval_url: status.approval_url }),
  );
} else if (action === "exercise") {
  if (!["revoke", "expiry"].includes(mode)) throw new Error("Choose revoke or expiry");
  const expectedUser = process.argv[5] ?? "sean";
  const expectedHome = process.argv[6] ?? "/home/sean";
  const expectedHostname = process.argv[7] ?? alias;
  if (!/^[A-Za-z0-9_.-]+$/.test(expectedUser) || !expectedHome.startsWith("/"))
    throw new Error("Supply the verified remote account and absolute home directory");
  let status = await api("GET", "");
  const readyDeadline = Date.now() + 180000;
  while (
    ["pending", "connecting", "updating"].includes(status.phase) &&
    Date.now() < readyDeadline
  ) {
    await delay(1000);
    status = await api("GET", "");
  }
  if (status.phase !== "active" || !status.pairing_code || !status.expires_at)
    throw new Error(
      `Environment is ${status.phase}: ${status.error ?? "approve a timed connection first"}`,
    );
  if (mode === "expiry" && Date.parse(status.expires_at) - Date.now() > 180000)
    throw new Error(
      "Choose a 1-minute approval for the bounded expiry test; this script never shortens or extends grants",
    );
  let pairingCode = status.pairing_code;
  const sshGrant = process.env.T3_HUB_VERIFY_SSH_GRANT;
  if (sshGrant) {
    if (!/^[a-f0-9]{64}$/.test(sshGrant) || !/^[a-f0-9]{40}$/.test(status.revision ?? ""))
      throw new Error("Supply a scoped SSH grant and an installed native revision");
    const grant = (await call("GET", `http://hub/v1/requests/${sshGrant}`, undefined, {
      socketPath,
    })) as { state: string; grant_expires_at?: string; capabilities: string[] };
    if (
      grant.state !== "active" ||
      Date.parse(grant.grant_expires_at ?? "") <= Date.now() ||
      !grant.capabilities.includes(`ssh:${alias}`)
    )
      throw new Error("Diagnostic SSH grant is not active for this host");
    // The browser may have consumed the startup code. Issue this test its own one-time code
    // through the normal T3 CLI, while both SSH and the environment lease are authorized.
    const command = `cd ${shellQuote(expectedHome)} && test "$(hostname)" = ${shellQuote(expectedHostname)} && test "$(id -un)" = ${shellQuote(expectedUser)} && test "$(pwd)" = ${shellQuote(expectedHome)} && /var/lib/t3-hub/releases/${status.revision}/t3 pair --base-dir /var/lib/t3-hub/state --ttl 1m --label 'Hub native verification'`;
    const result = (await call(
      "POST",
      "http://hub/v1/ssh/exec",
      { grant: sshGrant, host: alias, command, timeout_seconds: 20 },
      { socketPath, signal: AbortSignal.timeout(25000) },
    )) as { exit_code: number; stdout: string; truncated: boolean; interrupted: boolean };
    const found = /(?:^|\n)Token:\s*([^\s]+)\s*(?:\n|$)/.exec(result.stdout);
    if (result.exit_code !== 0 || result.truncated || result.interrupted || !found)
      throw new Error("Separate diagnostic pairing failed; credential-bearing output withheld");
    pairingCode = found[1]!;
  }
  const gateway = attachHubGateway(
    http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    }),
    socketPath,
  );
  const connections = new Set<Socket>();
  gateway.on("connection", (connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  if (!address || typeof address === "string")
    throw new Error("Local verification gateway unavailable");
  const base = `http://127.0.0.1:${address.port}/hub/environments/${alias}`;
  let ws: WebSocket | undefined;
  try {
    const tokenResponse = await fetch(base + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: pairingCode,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        client_label: "Hub enrollment verification",
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!tokenResponse.ok)
      throw new Error(
        `Native pairing failed (${tokenResponse.status}); credential-bearing response withheld`,
      );
    const token = ((await tokenResponse.json()) as { access_token: string }).access_token;
    const ticketResponse = await fetch(base + "/api/auth/websocket-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!ticketResponse.ok)
      throw new Error(`Native websocket ticket failed (${ticketResponse.status})`);
    const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;
    ws = new WebSocket(
      base.replace(/^http:/, "ws:") + "/ws?wsTicket=" + encodeURIComponent(ticket),
    );
    const socket = ws;
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Native websocket connection failed")),
        { once: true },
      );
    });
    let counter = 0,
      output = "";
    const pending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let identityResolve: (value: string[]) => void;
    const identity = new Promise<string[]>((resolve) => {
      identityResolve = resolve;
    });
    socket.addEventListener("message", (event) => {
      const decoded = JSON.parse(String(event.data));
      for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
        if (message._tag === "Ping") {
          socket.send(JSON.stringify({ _tag: "Pong" }));
          continue;
        }
        const requestId = String(message.requestId);
        if (message._tag === "Exit") {
          const waiter = pending.get(requestId);
          pending.delete(requestId);
          if (message.exit?._tag === "Success") waiter?.resolve(message.exit.value);
          else waiter?.reject(new Error("Native RPC failed; response withheld"));
        } else if (message._tag === "Chunk") {
          for (const value of message.values ?? [])
            if (value.type === "output" && typeof value.data === "string") {
              output = (output + value.data).slice(-65536);
              const found =
                /(?:^|\r?\n)HUB_SMOKE_BEGIN\r?\n([^\r\n]+)\r?\n([^\r\n]+)\r?\n([^\r\n]+)\r?\nHUB_SMOKE_END/.exec(
                  output,
                );
              if (found) identityResolve(found.slice(1, 4));
            }
          socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
        }
      }
    });
    const send = (tag: string, payload: unknown) => {
      const id = String(++counter);
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      return id;
    };
    const rpc = (tag: string, payload: unknown) =>
      Promise.race([
        new Promise<unknown>((resolve, reject) => {
          const id = send(tag, payload);
          pending.set(id, { resolve, reject });
        }),
        delay(15000, undefined, { ref: false }).then(() => {
          throw new Error(`Native RPC ${tag} timed out`);
        }),
      ]);
    send("subscribeTerminalEvents", {});
    const terminal = { threadId: "hub-enrollment-" + randomUUID(), terminalId: "term-1" };
    await rpc("terminal.open", { ...terminal, cwd: expectedHome, cols: 80, rows: 24 });
    await rpc("terminal.write", {
      ...terminal,
      data: "printf '\\nHUB_SMOKE_BEGIN\\n'; hostname; id -un; pwd; printf 'HUB_SMOKE_END\\n'\n",
    });
    const observed = await Promise.race([
      identity,
      delay(15000, undefined, { ref: false }).then(() => {
        throw new Error("Native terminal identity verification timed out; output withheld");
      }),
    ]);
    if (
      observed[0]?.split(".")[0] !== expectedHostname.split(".")[0] ||
      observed[1] !== expectedUser ||
      observed[2] !== expectedHome
    )
      throw new Error("Native terminal identity mismatch");
    console.log(
      JSON.stringify({
        native_terminal: "verified",
        hostname: observed[0],
        user: observed[1],
        cwd: observed[2],
        revision: status.revision,
      }),
    );
    if (mode === "revoke") await api("POST", "/disconnect");
    else
      console.log(`Waiting for the approved deadline ${status.expires_at}; no renewal will occur.`);
    await Promise.race([
      closed,
      delay(Math.max(1000, Date.parse(status.expires_at) - Date.now() + 15000), undefined, {
        ref: false,
      }).then(() => {
        throw new Error("Existing websocket survived the grant deadline");
      }),
    ]);
    if (mode === "expiry" && Date.now() < Date.parse(status.expires_at) - 2000)
      throw new Error("Connection ended before the approved deadline; not an expiry proof");
    // systemd's whole-second runtime limit may close the socket just before the
    // broker's millisecond deadline. Check the final gate at that exact deadline.
    if (mode === "expiry") await delay(Math.max(0, Date.parse(status.expires_at) - Date.now()));
    const final = await api("GET", "");
    const locked = await fetch(base + "/", { signal: AbortSignal.timeout(10000) });
    if (locked.status !== 423 || final.phase !== "locked")
      throw new Error(`Expiry/revoke check failed: HTTP ${locked.status}, phase ${final.phase}`);
    console.log(
      `PASS: native terminal ran on ${alias}; ${mode} closed its existing websocket and rejected new access (HTTP 423).`,
    );
  } catch (error) {
    // Report the diagnostic's own errors before cleanup; never log credential-bearing responses.
    console.error(error instanceof Error ? error.message : "Native verification failed");
    throw error;
  } finally {
    // Do not deliberately close a newer connection if this test was interrupted.
    const current = await api("GET", "").catch(() => undefined);
    if (current?.expires_at === status.expires_at) await api("POST", "/disconnect").catch(() => {});
    ws?.close();
    for (const connection of connections) connection.destroy();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
} else
  throw new Error(
    "Usage: node hub/scripts/verify-live.ts request ALIAS [60|300] | exercise ALIAS revoke|expiry",
  );
