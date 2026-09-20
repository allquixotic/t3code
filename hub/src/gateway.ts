// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import http from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { peerUid } from "./peercred.ts";
import { requireThat } from "./io.ts";
import type { EnvironmentManager } from "./environments.ts";

export function attachWorkerTunnels(server: http.Server, environments: EnvironmentManager) {
  server.on("connect", (request, socket, head) => {
    void (async () => {
      requireThat(
        peerUid(request.socket) === environments.broker.config.worker_uid &&
          !request.headers.origin &&
          head.length === 0,
        "Tunnel caller denied",
      );
      const match = /^\/v1\/environments\/([A-Za-z0-9_.-]+)\/tunnel$/.exec(request.url ?? "");
      requireThat(match, "Tunnel scope denied");
      const channel = await environments.open(match[1]!);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.on("error", () => channel.destroy());
      channel.on("error", () => socket.destroy());
      socket.on("close", () => channel.destroy());
      channel.on("close", () => socket.destroy());
      socket.pipe(channel).pipe(socket);
    })().catch(() => {
      socket.end("HTTP/1.1 423 Locked\r\nContent-Length: 0\r\n\r\n");
    });
  });
}
function tunnel(socketPath: string, alias: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method: "CONNECT",
      path: `/v1/environments/${alias}/tunnel`,
      timeout: 10000,
    });
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) {
        socket.destroy();
        reject(new Error("Environment locked"));
      } else resolve(socket);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", reject);
    request.end();
  });
}
const excluded = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "cookie",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
async function proxy(
  socketPath: string,
  alias: string,
  path: string,
  request: http.IncomingMessage,
  response: http.ServerResponse | Duplex,
  head?: Buffer,
) {
  const socket = await tunnel(socketPath, alias);
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([key]) => !excluded.has(key)),
  );
  if (head) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  } else delete headers.upgrade;
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = () => socket;
  const outgoing = http.request({ method: request.method, path, headers, agent });
  const stop = () => {
    socket.destroy();
    outgoing.destroy();
    agent.destroy();
  };
  response.on("close", stop);
  outgoing.on("error", () => {
    if (response instanceof http.ServerResponse && !response.headersSent) {
      response.writeHead(423, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"error":"Environment locked or disconnected"}');
    } else response.destroy();
  });
  if (head) {
    outgoing.on("upgrade", (remote, upstream, initial) => {
      const lines = [`HTTP/1.1 ${remote.statusCode} ${remote.statusMessage}`];
      for (let i = 0; i < remote.rawHeaders.length; i += 2)
        if (remote.rawHeaders[i]!.toLowerCase() !== "set-cookie")
          lines.push(`${remote.rawHeaders[i]}: ${remote.rawHeaders[i + 1]}`);
      response.write(lines.join("\r\n") + "\r\n\r\n");
      if (initial.length) response.write(initial);
      if (head.length) upstream.write(head);
      upstream.on("error", () => response.destroy());
      response.on("error", () => upstream.destroy());
      response.pipe(upstream).pipe(response);
    });
    outgoing.on("response", (remote) => {
      remote.resume();
      response.destroy();
    });
    outgoing.end();
  } else {
    outgoing.on("response", (remote) => {
      const target = response as http.ServerResponse;
      const safeHeaders = { ...remote.headers };
      delete safeHeaders["set-cookie"];
      target.writeHead(remote.statusCode ?? 502, safeHeaders);
      remote.pipe(target);
    });
    request.pipe(outgoing);
  }
}
/** Intercept only the broker-managed prefix; normal T3 requests retain their original listeners. */
export function attachHubGateway(server: http.Server, socketPath: string | undefined): http.Server {
  if (!socketPath) return server;
  // Node only promotes HTTP upgrades when an upgrade listener is registered.
  server.on("upgrade", (_request, socket) => {
    if (server.listenerCount("upgrade") === 1) socket.destroy();
  });
  const emit = server.emit;
  server.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "request" || event === "upgrade") {
      const request = args[0] as http.IncomingMessage;
      const match = /^\/hub\/environments\/([A-Za-z0-9_.-]+)(\/[^\r\n]*)$/.exec(request.url ?? "");
      if (match) {
        const response = args[1] as http.ServerResponse | Duplex;
        void proxy(
          socketPath,
          match[1]!,
          match[2]!,
          request,
          response,
          event === "upgrade" ? (args[2] as Buffer) : undefined,
        ).catch(() => {
          if (response instanceof http.ServerResponse && !response.headersSent) {
            response.writeHead(423, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            response.end('{"error":"Environment locked or disconnected"}');
          } else response.destroy();
        });
        return true;
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  } as typeof server.emit;
  return server;
}
