import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachHubGateway, attachWorkerTunnels } from "../src/gateway.ts";
import type { EnvironmentManager } from "../src/environments.ts";

// Real Unix peer credentials and a real CONNECT tunnel; no remote host or credentials involved.
test(
  "gateway carries HTTP and upgrades, strips hub cookies, and rejects access after lock",
  { timeout: 10000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "hub-gateway-")),
      socketPath = join(directory, "worker.sock");
    const sockets = new Set<net.Socket>();
    let active = true;
    const remote = http.createServer((request, response) => {
      response.setHeader("set-cookie", "remote=must-not-escape");
      response.end(
        JSON.stringify({
          url: request.url,
          cookie: request.headers.cookie,
          authorization: request.headers.authorization,
        }),
      );
    });
    remote.on("upgrade", (request, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      socket.on("data", (bytes) => socket.write(bytes));
    });
    const worker = http.createServer();
    const manager = {
      broker: { config: { worker_uid: process.getuid!() } },
      open: async (alias: string) => {
        if (!active || alias !== "remote") throw new Error("locked");
        const socket = net.createConnection({
          host: "127.0.0.1",
          port: (remote.address() as net.AddressInfo).port,
        });
        await once(socket, "connect");
        return socket;
      },
    } as unknown as EnvironmentManager;
    attachWorkerTunnels(worker, manager);
    const gateway = attachHubGateway(
      http.createServer((_request, response) => response.end("hub")),
      socketPath,
    );
    for (const server of [remote, worker, gateway])
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
    remote.listen(0, "127.0.0.1");
    worker.listen(socketPath);
    gateway.listen(0, "127.0.0.1");
    await Promise.all([remote, worker, gateway].map((server) => once(server, "listening")));
    const port = (gateway.address() as net.AddressInfo).port;
    try {
      const result = await fetch(`http://127.0.0.1:${port}/hub/environments/remote/api/test?q=1`, {
        headers: { cookie: "hub-session=private", authorization: "Bearer test-only" },
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(result.status, 200);
      assert.equal(result.headers.get("set-cookie"), null);
      assert.deepEqual(await result.json(), {
        url: "/api/test?q=1",
        authorization: "Bearer test-only",
      });
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/ordinary`)).text(), "hub");
      const upgraded = await new Promise<net.Socket>((resolve, reject) => {
        const request = http.request({
          host: "127.0.0.1",
          port,
          path: "/hub/environments/remote/ws",
          headers: { connection: "Upgrade", upgrade: "websocket" },
        });
        request.on("upgrade", (_response, socket) => resolve(socket));
        request.on("error", reject);
        request.end();
      });
      const echoed = once(upgraded, "data");
      upgraded.write("hello");
      assert.equal((await echoed)[0].toString(), "hello");
      upgraded.destroy();
      active = false;
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/hub/environments/remote/api/test`)).status,
        423,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [remote, worker, gateway].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
