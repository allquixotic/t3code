// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export class HubError extends Error {}
export const requireThat: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new HubError(message);
};
export const id = () => randomBytes(32).toString("hex");
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const equal = (a: string | Buffer, b: string | Buffer) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const record = (value: unknown): Record<string, unknown> => {
  requireThat(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Object required",
  );
  return value as Record<string, unknown>;
};
export const text = (value: unknown): string => {
  requireThat(typeof value === "string", "String required");
  return value;
};
export const integer = (value: unknown): number => {
  requireThat(Number.isSafeInteger(value), "Integer required");
  return value as number;
};
export function fields(value: unknown, allowed: string[]) {
  const out = record(value);
  requireThat(
    Object.keys(out).every((k) => allowed.includes(k)),
    "Unexpected field",
  );
  return out;
}
export const message = (error: unknown) =>
  error instanceof HubError
    ? error.message
    : "Operation failed; inspect protected service diagnostics";
export const audit = (path: string) => (event: string, details: Record<string, unknown>) => {
  try {
    appendFileSync(
      path,
      JSON.stringify({ time: new Date().toISOString(), event, ...details }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    throw new HubError("Audit unavailable");
  }
};
export async function collect(input: AsyncIterable<Uint8Array>, limit = 2 << 20) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of input) {
    size += part.length;
    requireThat(size <= limit, "Response exceeds limit");
    chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks);
}
export async function jsonBody(request: http.IncomingMessage) {
  requireThat(
    request.headers["content-type"]?.startsWith("application/json"),
    "JSON Content-Type required",
  );
  try {
    return JSON.parse((await collect(request)).toString()) as unknown;
  } catch {
    throw new HubError("Invalid JSON request");
  }
}
export function json(response: http.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
export interface CallOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  socketPath?: string;
  cookies?: Map<string, string>;
  maxBytes?: number;
}
/** No redirects, environment proxies, response headers, or upstream error bodies escape this boundary. */
export async function call(
  method: string,
  endpoint: string,
  body?: unknown,
  options: CallOptions = {},
): Promise<unknown> {
  const result = await requestBytes(
    method,
    endpoint,
    body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
    options,
  );
  requireThat(
    result.status >= 200 && result.status < 300,
    `Upstream refused request (HTTP ${result.status})`,
  );
  if (!result.body.length) return undefined;
  try {
    return JSON.parse(result.body.toString()) as unknown;
  } catch {
    throw new HubError("Invalid upstream JSON");
  }
}
export function requestBytes(
  method: string,
  endpoint: string,
  body?: Buffer,
  options: CallOptions = {},
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    requireThat(url.protocol === "https:" || url.protocol === "http:", "Invalid upstream protocol");
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        socketPath: options.socketPath,
        signal: options.signal,
        headers: {
          accept: "application/json",
          ...(body
            ? { "content-type": "application/json", "content-length": String(body.length) }
            : {}),
          ...(options.cookies?.size
            ? { cookie: [...options.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
          ...options.headers,
        },
        timeout: 30_000,
      },
      (response) => {
        if (options.cookies)
          for (const cookie of response.headers["set-cookie"] ?? []) {
            const pair = cookie.split(";", 1)[0]!;
            const index = pair.indexOf("=");
            if (index > 0) options.cookies.set(pair.slice(0, index), pair.slice(index + 1));
          }
        collect(response, options.maxBytes ?? 1 << 20).then(
          (data) => resolve({ status: response.statusCode ?? 502, body: data }),
          reject,
        );
      },
    );
    request.on("timeout", () => request.destroy(new HubError("Upstream timed out")));
    request.on("error", () => reject(new HubError("Upstream unavailable")));
    request.end(body);
  });
}
export interface ProcessResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  interrupted: boolean;
}
export function run(
  binary: string,
  args: string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
  input?: Buffer,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(binary, args, {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent", ...env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      truncated = false;
    const append = (old: Buffer, next: Buffer) => {
      if (old.length + next.length > 1 << 20) truncated = true;
      return Buffer.concat([old, next.subarray(0, Math.max(0, (1 << 20) - old.length))]);
    };
    child.stdout.on("data", (data: Buffer) => {
      stdout = append(stdout, data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = append(stderr, data);
    });
    const stop = () => {
      if (child.pid)
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
    };
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", () => {
      signal.removeEventListener("abort", stop);
      reject(new HubError("Could not start operation"));
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", stop);
      resolve({
        exit_code: code ?? -1,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated,
        interrupted: signal.aborted,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    if (signal.aborted) stop();
  });
}
