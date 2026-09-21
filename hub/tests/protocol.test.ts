import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeStream from "node:stream";
// oxlint-disable-next-line t3code/namespace-node-imports -- Node event exports require named imports under this standalone tsconfig.
import { getEventListeners } from "node:events";
import { Protocol, Channel } from "../src/protocol.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

NodeTest.test("channel writes are bounded and wait for remote acknowledgement", async () => {
  const upstream = new NodeStream.PassThrough(),
    downstream = new NodeStream.PassThrough();
  const client = new Protocol(downstream, upstream),
    server = new Protocol(upstream, downstream);
  const sizes: number[] = [];
  let bytes = 0;
  server.handler = async (type, payload) => {
    NodeAssert.equal(type, "write");
    const value = payload as { data: string };
    const data = Buffer.from(value.data, "base64");
    sizes.push(data.length);
    bytes += data.length;
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { written: data.length };
  };
  const serving = server.start(),
    receiving = client.start();
  const channel = new Channel(client, 1);
  try {
    await new Promise<void>((resolve, reject) =>
      channel.write(Buffer.alloc(512 * 1024, 42), (error) => (error ? reject(error) : resolve())),
    );
    NodeAssert.equal(bytes, 512 * 1024);
    NodeAssert.equal(sizes.length, 8);
    NodeAssert.ok(sizes.every((size) => size === 65536));
    client.close();
    channel.destroy();
    await NodeAssert.rejects(client.send({ type: "heartbeat" }), /closed/);
  } finally {
    client.close();
    server.close();
    channel.destroy();
    await Promise.all([serving, receiving]);
  }
});
NodeTest.test("transport loss rejects outstanding operations", async () => {
  const client = new Protocol(new NodeStream.PassThrough(), new NodeStream.PassThrough());
  const pending = client.request("install-finish", {});
  client.close();
  await NodeAssert.rejects(pending, /closed/);
});

for (const type of ["hello", "install-finish", "skills-finish", "start"]) {
  NodeTest.test(
    `${type} waits for its receipt beyond the old setup limit and returns without a timer tick`,
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const upstream = new NodeStream.PassThrough(),
        downstream = new NodeStream.PassThrough();
      const client = new Protocol(downstream, upstream),
        server = new Protocol(upstream, downstream);
      const started = deferred<void>(),
        completed = deferred<unknown>();
      const controller = new AbortController();
      server.handler = async (request) => {
        if (request === "heartbeat") return { alive: true };
        NodeAssert.equal(request, type);
        started.resolve();
        return completed.promise;
      };
      const serving = server.start(),
        receiving = client.start();
      try {
        const pending = client.request(type, {}, controller.signal);
        await started.promise;
        t.mock.timers.tick(10 * 60 * 1000);
        // Independent liveness traffic must still work during a slow installation.
        NodeAssert.deepEqual(await client.request("heartbeat", {}), { alive: true });
        completed.resolve({ revision: "verified" });
        NodeAssert.deepEqual(await pending, { revision: "verified" });
        NodeAssert.equal(getEventListeners(controller.signal, "abort").length, 0);
        // A completed request must not close the transport when its old signal ends.
        controller.abort();
        NodeAssert.deepEqual(await client.request("heartbeat", {}), { alive: true });
      } finally {
        completed.resolve({});
        client.close();
        server.close();
        await Promise.all([serving, receiving]);
      }
    },
  );
}

NodeTest.test(
  "revocation or expiry cancels setup immediately and cleans up its signal listener",
  async () => {
    const client = new Protocol(new NodeStream.PassThrough(), new NodeStream.PassThrough());
    const controller = new AbortController();
    const pending = client.request("install-finish", {}, controller.signal);
    controller.abort();
    await NodeAssert.rejects(pending, /cancelled/);
    NodeAssert.equal(getEventListeners(controller.signal, "abort").length, 0);
    NodeAssert.throws(() => client.request("heartbeat", {}), /unavailable/);
  },
);

NodeTest.test("a setup request cannot start under an already ended signal", () => {
  const client = new Protocol(new NodeStream.PassThrough(), new NodeStream.PassThrough());
  try {
    NodeAssert.throws(() => client.request("start", {}, AbortSignal.abort()), /abort/i);
    NodeAssert.equal(client.output.writableLength, 0);
  } finally {
    client.close();
  }
});

NodeTest.test("transport loss rejects setup without waiting for the access deadline", async () => {
  const client = new Protocol(new NodeStream.PassThrough(), new NodeStream.PassThrough());
  const controller = new AbortController();
  const pending = client.request("install-finish", {}, controller.signal);
  client.close();
  await NodeAssert.rejects(pending, /closed/);
  NodeAssert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

NodeTest.test("ordinary control requests retain their liveness timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new Protocol(new NodeStream.PassThrough(), new NodeStream.PassThrough());
  const pending = client.request("heartbeat", {}, 5000);
  t.mock.timers.tick(5000);
  await NodeAssert.rejects(pending, /timed out/);
});
