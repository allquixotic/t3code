// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import net from "node:net";
import { chmodSync } from "node:fs";
import { peerUid } from "./peercred.ts";
import { requireThat } from "./io.ts";

export async function* packets(
  input: AsyncIterable<Uint8Array>,
  max = 1 << 20,
): AsyncGenerator<Buffer> {
  let buffered = Buffer.alloc(0);
  for await (const bytes of input) {
    buffered = Buffer.concat([buffered, bytes]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE();
      requireThat(length > 0 && length <= max, "Invalid frame length");
      if (buffered.length < length + 4) break;
      yield Buffer.from(buffered.subarray(4, length + 4));
      buffered = buffered.subarray(length + 4);
    }
  }
  requireThat(buffered.length === 0, "Truncated frame");
}
export const frame = (payload: Buffer) => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
};
export function agentRequestAllowed(packet: Buffer) {
  if (packet[0] === 11) return packet.length === 1;
  if (packet[0] === 13) return true;
  if (packet[0] !== 27 || packet.length < 5) return false;
  const length = packet.readUInt32BE(1);
  return (
    length <= packet.length - 5 &&
    packet.subarray(5, 5 + length).toString() === "session-bind@openssh.com"
  );
}
export function agentProxy(path: string, native: string, brokerUid: number) {
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    try {
      requireThat(
        clients.size < 128 && [0, brokerUid].includes(peerUid(socket)),
        "Signer caller denied",
      );
    } catch {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.setTimeout(30000, () => socket.destroy());
    const upstream = net.createConnection(native);
    upstream.setTimeout(10000, () => upstream.destroy());
    const stop = () => {
      clients.delete(socket);
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", stop);
    socket.on("close", stop);
    upstream.on("error", stop);
    void (async () => {
      const replies = packets(upstream)[Symbol.asyncIterator]();
      for await (const packet of packets(socket)) {
        if (!agentRequestAllowed(packet)) {
          socket.write(frame(Buffer.from([5])));
          continue;
        }
        upstream.write(frame(packet));
        const reply = await replies.next();
        if (reply.done) return;
        socket.write(frame(reply.value));
      }
    })()
      .catch(() => {})
      .finally(stop);
  });
  server.listen(path, () => chmodSync(path, 0o660));
  return {
    server,
    close: () => {
      for (const client of clients) client.destroy();
      server.close();
    },
  };
}
