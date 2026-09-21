/* oxlint-disable t3code/no-global-process-runtime -- Standalone remote connector outside the Effect host. */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - remote readiness, bounded by its approved SSH transport.
import * as NodeNet from "node:net";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
// oxlint-disable-next-line t3code/namespace-node-imports -- Named Node event export required by the standalone emitter.
import { once } from "node:events";

function readinessChange(path: string, signal: AbortSignal) {
  let watcher: NodeFS.FSWatcher | undefined;
  let wake!: () => void;
  const changed = new Promise<void>((resolve) => {
    wake = resolve;
  });
  // Named pipes have no directory notification; this also covers bind/listen races.
  const timer = setTimeout(wake, 100);
  signal.addEventListener("abort", wake, { once: true });
  if (process.platform !== "win32") {
    let directory = NodePath.dirname(path);
    for (;;) {
      try {
        watcher = NodeFS.watch(directory, wake);
        watcher.on("error", wake);
        break;
      } catch (error) {
        const parent = NodePath.dirname(directory);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === directory) break;
        directory = parent;
      }
    }
  }
  return {
    changed,
    close: () => {
      clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", wake);
    },
  };
}

/** Retry only an unavailable service socket. A successful connection returns immediately. */
export async function connectWhenReady(path: string, signal: AbortSignal): Promise<NodeNet.Socket> {
  for (;;) {
    signal.throwIfAborted();
    // Subscribe before probing, so a service appearing during a failed probe wakes us.
    const change = readinessChange(path, signal);
    const socket = NodeNet.createConnection({ path, signal });
    try {
      await once(socket, "connect", { signal });
      return socket;
    } catch (error) {
      socket.destroy();
      signal.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      await change.changed;
    } finally {
      change.close();
    }
  }
}
