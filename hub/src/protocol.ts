// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
// oxlint-disable-next-line t3code/namespace-node-imports -- Named Node event exports are required by the standalone emitter.
import { EventEmitter, once } from "node:events";
import * as NodeStream from "node:stream";
import { packets, frame } from "./agent-proxy.ts";
import { record, text, integer, requireThat, HubError } from "./io.ts";

export interface Packet {
  type: string;
  id?: number;
  payload?: unknown;
  error?: string;
}
/** A single authenticated SSH stream carries control messages and bounded TCP channels. */
export class Protocol extends EventEmitter {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
  >();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private queuedBytes = 0;
  handler?: (type: string, payload: unknown) => Promise<unknown>;
  readonly input: NodeStream.Readable;
  readonly output: NodeStream.Writable;
  constructor(input: NodeStream.Readable, output: NodeStream.Writable) {
    super();
    this.input = input;
    this.output = output;
  }
  async start() {
    try {
      for await (const bytes of packets(this.input)) {
        const packet = record(JSON.parse(bytes.toString()));
        const type = text(packet.type);
        if (type === "reply") {
          const pending = this.pending.get(integer(packet.id));
          requireThat(pending, "Unknown protocol response");
          this.pending.delete(integer(packet.id));
          pending.cleanup();
          if (packet.error) pending.reject(new HubError("Remote operation failed"));
          else pending.resolve(packet.payload);
        } else if (packet.id !== undefined) {
          const id = integer(packet.id);
          // Dispatch independent streams without blocking control heartbeats on builds or startup.
          void Promise.resolve()
            .then(() => {
              requireThat(this.handler, "No protocol handler");
              return this.handler(type, packet.payload);
            })
            .then(
              (payload) => this.send({ type: "reply", id, payload }),
              () => this.send({ type: "reply", id, error: "Remote operation failed" }),
            )
            .catch(() => this.close());
        } else this.emit(type, packet.payload);
      }
    } catch {
      /* Fail closed on malformed or interrupted transport. */
    } finally {
      this.close();
    }
  }
  async send(packet: Packet) {
    requireThat(!this.closed, "Connection closed");
    const bytes = Buffer.from(JSON.stringify(packet));
    requireThat(bytes.length <= 1 << 20, "Protocol frame too large");
    requireThat(this.queuedBytes + bytes.length <= 8 << 20, "Protocol backpressure exceeded");
    this.queuedBytes += bytes.length;
    const operation = this.writes
      .then(async () => {
        requireThat(!this.closed, "Connection closed");
        if (!this.output.write(frame(bytes))) await once(this.output, "drain");
      })
      .finally(() => {
        this.queuedBytes -= bytes.length;
      });
    this.writes = operation.catch(() => {
      this.close();
    });
    return operation;
  }
  request(
    type: string,
    payload: unknown,
    lifetime: number | AbortSignal = 30000,
  ): Promise<unknown> {
    requireThat(!this.closed && this.pending.size < 128, "Connection unavailable or overloaded");
    if (typeof lifetime !== "number") lifetime.throwIfAborted();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const stop = () => {
        reject(
          new HubError(
            typeof lifetime === "number"
              ? "Remote operation timed out"
              : "Remote operation cancelled",
          ),
        );
        this.close();
      };
      let cleanup: () => void;
      if (typeof lifetime === "number") {
        const timer = setTimeout(stop, lifetime);
        timer.unref();
        cleanup = () => clearTimeout(timer);
      } else {
        lifetime.addEventListener("abort", stop, { once: true });
        cleanup = () => lifetime.removeEventListener("abort", stop);
      }
      this.pending.set(id, { resolve, reject, cleanup });
      void this.send({ type, id, payload }).catch(() => this.close());
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new HubError("Remote connection closed"));
    }
    this.pending.clear();
    this.input.destroy();
    this.output.destroy();
    this.emit("closed");
  }
}
export class Channel extends NodeStream.Duplex {
  readonly protocol: Protocol;
  readonly channelId: number;
  constructor(protocol: Protocol, channelId: number) {
    super({ highWaterMark: 65536 });
    this.protocol = protocol;
    this.channelId = channelId;
  }
  override _read() {
    void this.protocol
      .send({ type: "resume", payload: this.channelId })
      .catch(() => this.destroy());
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    void (async () => {
      for (let i = 0; i < chunk.length; i += 65536)
        await this.protocol.request("write", {
          channel: this.channelId,
          data: chunk.subarray(i, i + 65536).toString("base64"),
        });
    })().then(
      () => callback(),
      () => callback(new HubError("Remote channel closed")),
    );
  }
  override _final(callback: (error?: Error | null) => void) {
    void this.protocol.send({ type: "end", payload: this.channelId }).then(
      () => callback(),
      () => callback(),
    );
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    void this.protocol.send({ type: "close", payload: this.channelId }).catch(() => {});
    callback(error);
  }
}
