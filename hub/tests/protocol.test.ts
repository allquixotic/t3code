import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Protocol, Channel } from "../src/protocol.ts";

test("channel writes are bounded and wait for remote acknowledgement", async () => {
  const upstream = new PassThrough(),
    downstream = new PassThrough();
  const client = new Protocol(downstream, upstream),
    server = new Protocol(upstream, downstream);
  const sizes: number[] = [];
  let bytes = 0;
  server.handler = async (type, payload) => {
    assert.equal(type, "write");
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
    assert.equal(bytes, 512 * 1024);
    assert.equal(sizes.length, 8);
    assert.ok(sizes.every((size) => size === 65536));
    client.close();
    channel.destroy();
    await assert.rejects(client.send({ type: "heartbeat" }), /closed/);
  } finally {
    client.close();
    server.close();
    channel.destroy();
    await Promise.all([serving, receiving]);
  }
});
test("transport loss rejects outstanding operations", async () => {
  const client = new Protocol(new PassThrough(), new PassThrough());
  const pending = client.request("install-finish", {});
  client.close();
  await assert.rejects(pending, /closed/);
});
