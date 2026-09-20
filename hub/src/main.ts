// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import http from "node:http";
import { hostname, userInfo } from "node:os";
import { readFileSync, unlinkSync, lstatSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { Broker } from "./broker.ts";
import { Authelia } from "./authelia.ts";
import { Bao } from "./credentials.ts";
import { loadConfig, parseConfig } from "./config.ts";
import {
  UnlockClient,
  Unlocker,
  loadStoredSigner,
  policyDigest,
  type UnlockConfig,
} from "./unlocker.ts";
import { webHandler, workerHandler, listenUnix, connectionSignal } from "./http.ts";
import { agentProxy } from "./agent-proxy.ts";
import { harden, peerUid } from "./peercred.ts";
import { EnvironmentManager } from "./environments.ts";
import { attachWorkerTunnels } from "./gateway.ts";
import {
  audit,
  call,
  record,
  text,
  integer,
  fields,
  requireThat,
  json,
  jsonBody,
  message,
  run,
} from "./io.ts";

export function assertHubHost() {
  requireThat(
    hostname().split(".")[0] === "t3code",
    "Hub builds and maintenance must run on t3code",
  );
}
const socketPath = () => process.env.HUB_BROKER_SOCKET ?? "/run/hub-broker/worker.sock";
const api = (method: string, path: string, body?: unknown) =>
  call(method, "http://hub-broker" + path, body, {
    socketPath: socketPath(),
    signal: AbortSignal.timeout(3700000),
  });
async function pinnedAuthelia(version: string) {
  const probe = await run("/usr/local/bin/authelia", ["--version"], AbortSignal.timeout(3000));
  requireThat(
    probe.exit_code === 0 && probe.stdout.trim() === `authelia version ${version}`,
    "Installed Authelia differs from pinned adapter",
  );
}
async function serve(configPath: string) {
  assertHubHost();
  const config = loadConfig(configPath);
  requireThat(
    userInfo().username === "hub-broker" && process.getuid!() !== config.worker_uid,
    "Broker must run as its protected service account",
  );
  harden();
  await pinnedAuthelia(config.authelia_version);
  const bao = new Bao(config),
    broker = new Broker(
      config,
      config.unlock_socket ? new UnlockClient(config) : new Authelia(config),
      bao,
      audit(config.audit_file),
    );
  const environments = new EnvironmentManager(broker);
  const worker = http.createServer(workerHandler(broker, bao, environments));
  attachWorkerTunnels(worker, environments);
  const web = http.createServer(webHandler(broker));
  for (const server of [worker, web]) {
    server.headersTimeout = 5000;
    server.requestTimeout = 40000;
    server.keepAliveTimeout = 30000;
    server.maxHeadersCount = 100;
  }
  await listenUnix(worker, config.worker_socket);
  const url = new URL(`http://${config.web_listen}`);
  await new Promise<void>((resolve, reject) => {
    web.once("error", reject);
    web.listen(Number(url.port), url.hostname.replace(/^\[|\]$/g, ""), resolve);
  });
  let ticking = false,
    monitoring = false;
  const reap = setInterval(() => {
    if (ticking) return;
    ticking = true;
    try {
      broker.reap();
      void environments
        .tick()
        .catch(() => environments.close())
        .finally(() => {
          ticking = false;
        });
    } catch {
      ticking = false;
      broker.close();
      environments.close();
    }
  }, 250);
  const monitor = setInterval(() => {
    if (monitoring) return;
    monitoring = true;
    void broker.monitorSigner().finally(() => {
      monitoring = false;
    });
  }, 2000);
  const stop = () => {
    clearInterval(reap);
    clearInterval(monitor);
    broker.close();
    environments.close();
    worker.closeAllConnections();
    web.closeAllConnections();
    worker.close();
    web.close();
    try {
      unlinkSync(config.worker_socket);
    } catch {
      /* socket removed */
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  worker.on("error", stop);
  web.on("error", stop);
}
async function serveUnlocker(configPath: string) {
  assertHubHost();
  requireThat(
    userInfo().username === "hub-unlocker",
    "Unlocker must run as its protected service account",
  );
  harden();
  const info = lstatSync(configPath);
  requireThat(
    info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0,
    "Administrator-owned unlock policy required",
  );
  const raw = fields(JSON.parse(readFileSync(configPath, "utf8")), [
    "policy",
    "broker_uid",
    "socket",
    "agent_socket",
    "key_file",
    "audit_file",
  ]);
  const config = { ...raw, policy: parseConfig(raw.policy) } as unknown as UnlockConfig;
  requireThat(
    config.broker_uid > 0 &&
      config.broker_uid !== config.policy.worker_uid &&
      config.broker_uid !== process.getuid!() &&
      !Object.keys(config.policy.providers).length &&
      !config.policy.unlock_socket,
    "Invalid unlock service separation",
  );
  await pinnedAuthelia(config.policy.authelia_version);
  const service = new Unlocker(
    config,
    new Authelia(config.policy),
    audit(config.audit_file),
    (seconds, signal) => loadStoredSigner(config, seconds, signal),
  );
  const server = http.createServer(async (request, response) => {
    try {
      requireThat(
        peerUid(request.socket) === config.broker_uid && !request.headers.origin,
        "Unlock service caller denied",
      );
      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, {
          version: "1.0.0-ts",
          policy_digest: policyDigest(config.policy),
          signer_ttl_seconds: 28800,
        });
        return;
      }
      requireThat(request.method === "POST", "Route not found");
      const body = record(await jsonBody(request)),
        signal = connectionSignal(request, response);
      if (request.url === "/begin")
        json(
          response,
          200,
          await service.begin(
            fields(body, ["request_id", "hosts", "ttl_seconds", "policy_digest"]),
            signal,
          ),
        );
      else if (request.url === "/finish") {
        fields(body, ["id", "response"]);
        json(response, 200, await service.finish(text(body.id), body.response, signal));
      } else if (request.url === "/cancel") {
        fields(body, ["id"]);
        await service.cancel(text(body.id));
        json(response, 200, { status: "closed" });
      } else json(response, 404, { error: "Route not found" });
    } catch (error) {
      json(response, 403, { error: message(error) });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 40000;
  await listenUnix(server, config.socket);
  const proxy = agentProxy(config.agent_socket, config.policy.signer_socket, config.broker_uid);
  const stop = () => {
    void service.close();
    proxy.close();
    server.closeAllConnections();
    server.close();
    for (const path of [config.socket, config.agent_socket])
      try {
        unlinkSync(path);
      } catch {
        /* socket removed */
      }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.on("error", stop);
  proxy.server.on("error", stop);
}
const definitions = [
  ["hub_access_catalog", "List broker-approved capabilities", {}, []],
  [
    "hub_access_list",
    "List this Unix user's retained requests; not authorization to reuse them",
    { state: "string", capability: "string" },
    [],
  ],
  ["hub_access_doctor", "Read broker diagnostics without provider credential use", {}, []],
  [
    "hub_access_request",
    "Request timed passkey approval",
    { capabilities: "array", purpose: "string", ttl_seconds: "integer" },
    ["capabilities", "purpose"],
  ],
  ["hub_access_status", "Check actual grant state", { id: "string" }, ["id"]],
  ["hub_access_revoke", "Revoke only the selected grant", { id: "string" }, ["id"]],
  [
    "hub_ssh_exec",
    "Execute on a grant-approved SSH host",
    { grant: "string", host: "string", command: "string", timeout_seconds: "integer" },
    ["grant", "host", "command"],
  ],
  [
    "hub_provider_request",
    "Call a configured provider without exposing credentials",
    {
      grant: "string",
      provider: "string",
      method: "string",
      path: "string",
      query: "object",
      body: "object",
    },
    ["grant", "provider", "method", "path"],
  ],
] as const;
async function tool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "hub_access_catalog":
      return api("GET", "/v1/catalog");
    case "hub_access_doctor":
      return api("GET", "/v1/diagnostics");
    case "hub_access_list":
      return api(
        "GET",
        "/v1/requests?" + new URLSearchParams(Object.entries(args).map(([k, v]) => [k, text(v)])),
      );
    case "hub_access_request":
      return api("POST", "/v1/requests", args);
    case "hub_access_status":
      return api("GET", `/v1/requests/${encodeURIComponent(text(args.id))}`);
    case "hub_access_revoke":
      return api("POST", `/v1/requests/${encodeURIComponent(text(args.id))}/revoke`, {});
    case "hub_ssh_exec":
      return api("POST", "/v1/ssh/exec", args);
    case "hub_provider_request":
      return api("POST", "/v1/provider/request", args);
    default:
      throw new Error("Unknown tool");
  }
}
async function mcp() {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.length > 2 << 20) continue;
    let request: Record<string, unknown>;
    try {
      request = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (request.id === undefined) continue;
    void (async () => {
      let result: unknown;
      try {
        if (request.method === "initialize")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "hub-access", version: "1.0.0-ts" },
          };
        else if (request.method === "tools/list")
          result = {
            tools: definitions.map(([name, description, props, required]) => ({
              name,
              description,
              annotations: {
                readOnlyHint: [
                  "hub_access_catalog",
                  "hub_access_list",
                  "hub_access_doctor",
                  "hub_access_status",
                ].includes(name),
                openWorldHint: true,
              },
              inputSchema: {
                type: "object",
                properties: Object.fromEntries(
                  Object.entries(props).map(([k, v]) => [
                    k,
                    k === "body"
                      ? {}
                      : k === "query"
                        ? { type: "object", additionalProperties: { type: "string" } }
                        : v === "array"
                          ? { type: v, items: { type: "string" } }
                          : { type: v },
                  ]),
                ),
                required,
                additionalProperties: false,
              },
            })),
          };
        else if (request.method === "ping") result = {};
        else {
          const params = record(request.params);
          const out = await tool(text(params.name), record(params.arguments ?? {}));
          result = { content: [{ type: "text", text: JSON.stringify(out) }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: "text", text: message(error) }] };
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    })();
  }
}
function duration(value: string) {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  requireThat(match, "Duration requires s, m, or h");
  return Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]!]!;
}
export async function main(args = process.argv.slice(2)) {
  const invoked = process.env.HUB_INVOKED_AS ?? basename(process.argv[1] ?? "hub-access");
  if (invoked === "hub-ssh-status") args = [args.length ? "status" : "grants", ...args];
  if (invoked === "hub-ssh") args = ["ssh-exec", ...args];
  if (invoked === "hub-ssh-revoke") args = ["revoke", ...args];
  if (invoked === "hub-ssh-grant") {
    requireThat(args.length === 2, "Usage: hub-ssh-grant DURATION HOST");
    args = [
      "request",
      "--ttl",
      args[0]!,
      "--cap",
      `ssh:${args[1]}`,
      "--purpose",
      `Work on ${args[1]}`,
    ];
  }
  const [command, ...rest] = args;
  const options: Record<string, string> = {},
    caps: string[] = [],
    positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key.startsWith("--")) {
      requireThat(rest[i + 1] !== undefined, "Option value required");
      const value = rest[++i]!;
      if (key === "--cap") caps.push(value);
      else options[key.slice(2)] = value;
    } else positional.push(key);
  }
  if (command === "serve") return serve(options.config ?? "/etc/hub-broker/config.json");
  if (command === "unlocker" || command === "serve-unlocker")
    return serveUnlocker(options.config ?? "/etc/hub-unlocker/config.json");
  if (command === "mcp") return mcp();
  let result: unknown;
  if (command === "catalog") result = await api("GET", "/v1/catalog");
  else if (command === "doctor") result = await api("GET", "/v1/diagnostics");
  else if (command === "grants")
    result = await api("GET", "/v1/requests?" + new URLSearchParams(options));
  else if (command === "status" || command === "revoke") {
    requireThat(
      positional.length === 1 && /^[a-f0-9]{64}$/.test(positional[0]!),
      "Exactly one broker request ID required",
    );
    result = await api(
      command === "status" ? "GET" : "POST",
      `/v1/requests/${positional[0]}${command === "revoke" ? "/revoke" : ""}`,
      command === "revoke" ? {} : undefined,
    );
  } else if (command === "request")
    result = await api("POST", "/v1/requests", {
      purpose: options.purpose,
      capabilities: caps,
      ttl_seconds: options.ttl ? duration(options.ttl) : 1800,
    });
  else if (command === "ssh-exec")
    result = await api("POST", "/v1/ssh/exec", {
      grant: options.grant,
      host: options.host,
      command: options.command,
      ...(options.timeout ? { timeout_seconds: Number(options.timeout) } : {}),
    });
  else if (command === "http")
    result = await api("POST", "/v1/provider/request", {
      grant: options.grant,
      provider: options.provider,
      method: options.method ?? "GET",
      path: options.path,
      ...(options["body-file"]
        ? {
            body: JSON.parse(
              readFileSync(options["body-file"] === "-" ? 0 : options["body-file"], "utf8"),
            ),
          }
        : {}),
    });
  else if (command === "check") {
    loadConfig(options.config!);
    result = { valid: true };
  } else
    throw new Error(
      "Usage: hub-access serve|unlocker|mcp|catalog|doctor|grants|request|status|revoke|ssh-exec|http|check",
    );
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (
  process.argv[1] &&
  /(?:main\.(?:ts|js)|hub-access\.mjs|hub-access|hub-ssh(?:-grant|-status|-revoke)?)$/.test(
    process.argv[1],
  )
)
  void main().catch((error) => {
    process.stderr.write(message(error) + "\n");
    process.exitCode = 1;
  });
