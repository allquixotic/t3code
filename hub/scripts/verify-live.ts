import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { attachHubGateway } from "../src/gateway.ts";
import { call } from "../src/io.ts";
import { hubOnly } from "./maintain.ts";
import type { EnvironmentStatus } from "../src/types.ts";

hubOnly();
const [action, alias, mode = "revoke"] = process.argv.slice(2);
if (!alias || !/^[A-Za-z0-9_.-]+$/.test(alias))
  throw new Error("Supply one enrolled environment alias");
const socketPath = "/run/hub-broker/worker.sock";
const api = (method: string, suffix: string) =>
  call(method, `http://hub/v1/environments/${alias}${suffix}`, undefined, {
    socketPath,
    signal: AbortSignal.timeout(15000),
  }) as Promise<EnvironmentStatus>;
if (action === "request") {
  const status = await api("POST", "/connect");
  console.log(
    JSON.stringify({ alias: status.alias, phase: status.phase, approval_url: status.approval_url }),
  );
} else if (action === "exercise") {
  if (!["revoke", "expiry"].includes(mode)) throw new Error("Choose revoke or expiry");
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
  const gateway = attachHubGateway(
    http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    }),
    socketPath,
  );
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
        subject_token: status.pairing_code,
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
    await rpc("terminal.open", { ...terminal, cwd: "/home/sean", cols: 80, rows: 24 });
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
      observed[0]?.split(".")[0] !== alias ||
      observed[1] !== "sean" ||
      observed[2] !== "/home/sean"
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
    const locked = await fetch(base + "/", { signal: AbortSignal.timeout(10000) });
    const final = await api("GET", "");
    if (locked.status !== 423 || final.phase !== "locked")
      throw new Error("Expired/revoked environment still accessible");
    console.log(
      `PASS: native terminal ran on ${alias}; ${mode} closed its existing websocket and rejected new access (HTTP 423).`,
    );
  } finally {
    await api("POST", "/disconnect").catch(() => {});
    ws?.close();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
} else
  throw new Error(
    "Usage: node hub/scripts/verify-live.ts request ALIAS | exercise ALIAS revoke|expiry",
  );
