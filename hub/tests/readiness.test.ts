import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeNet from "node:net";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
// oxlint-disable-next-line t3code/namespace-node-imports -- Node event exports require named imports under this standalone tsconfig.
import { once } from "node:events";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeChildProcess from "node:child_process";
import { Protocol } from "../src/protocol.ts";
import { connectWhenReady } from "../src/readiness.ts";

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hub-readiness-"));
  const socketPath = NodePath.join(directory, "supervisor.sock");
  const controller = new AbortController();
  const server = NodeNet.createServer((socket) => socket.on("error", () => {}).resume());
  return {
    socketPath,
    controller,
    server,
    listen: async () => {
      server.listen(socketPath);
      await once(server, "listening");
    },
    close: async () => {
      controller.abort();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

NodeTest.test("an already listening supervisor connects without any timer advance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.listen();
    const socket = await connectWhenReady(f.socketPath, f.controller.signal);
    socket.destroy();
  } finally {
    await f.close();
  }
});

NodeTest.test(
  "a slow supervisor wakes the connector on readiness beyond the old 30-second limit",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture();
    try {
      const pending = connectWhenReady(f.socketPath, f.controller.signal);
      // Drain the failed connection before moving the virtual clock; no wall-clock sleep.
      await NodeTimersPromises.setImmediate();
      await NodeTimersPromises.setImmediate();
      t.mock.timers.tick(60000);
      await f.listen();
      // Socket creation wakes the connector; no additional polling timer is advanced.
      const socket = await pending;
      socket.destroy();
    } finally {
      await f.close();
    }
  },
);

NodeTest.test("revocation interrupts a missing supervisor immediately", async () => {
  const f = fixture();
  try {
    const pending = connectWhenReady(f.socketPath, f.controller.signal);
    f.controller.abort();
    await NodeAssert.rejects(pending, /abort/i);
  } finally {
    await f.close();
  }
});

NodeTest.test(
  "unexpected socket errors fail immediately instead of being treated as slow startup",
  async () => {
    const f = fixture();
    try {
      NodeFS.writeFileSync(f.socketPath, "not a directory");
      await NodeAssert.rejects(
        connectWhenReady(NodePath.join(f.socketPath, "child"), f.controller.signal),
        {
          code: "ENOTDIR",
        },
      );
    } finally {
      await f.close();
    }
  },
);

for (const startService of [true, false]) {
  NodeTest.test(
    startService
      ? "the SSH connector buffers hello until the supervisor is ready and forwards its receipt"
      : "SSH EOF stops readiness waiting even if the supervisor never starts",
    async () => {
      const f = fixture();
      const remote = new URL("../src/remote.ts", import.meta.url).href;
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { remoteConnect } from ${JSON.stringify(remote)};
      try { await remoteConnect(process.argv[1]); }
      catch (error) { if (error.name !== 'AbortError') process.exitCode = 1; }
    `,
          f.socketPath,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stderr.resume();
      const exited = once(child, "exit");
      const client = new Protocol(child.stdout, child.stdin);
      const identity = once(client, "identity");
      const receiving = client.start();
      const pending = client.request("hello", {}, f.controller.signal);
      // Attach the expected rejection handler before closing the transport.
      const result = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let serving: Promise<void> | undefined;
      try {
        await identity;
        if (startService) {
          f.server.once("connection", (socket) => {
            const protocol = new Protocol(socket, socket);
            protocol.handler = async (type) => {
              NodeAssert.equal(type, "hello");
              return { ready: true };
            };
            serving = protocol.start();
          });
          await f.listen();
          NodeAssert.deepEqual(await result, { value: { ready: true } });
        }
        client.close();
        NodeAssert.equal((await exited)[0], 0);
        if (!startService)
          NodeAssert.match(String(((await result) as { error: unknown }).error), /closed/);
      } finally {
        client.close();
        child.kill();
        await exited;
        await Promise.all([receiving, serving]);
        await f.close();
      }
    },
  );
}
