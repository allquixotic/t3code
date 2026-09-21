// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - local user skill publisher; never opens a remote connection.
import * as NodeOS from "node:os";
import { collectSkills } from "./skills.ts";
import { requestBytes, requireThat } from "./io.ts";

export async function publishSkills(
  socketPath: string,
  signal: AbortSignal,
  home = NodeOS.homedir(),
) {
  const bytes = Buffer.from(JSON.stringify(await collectSkills(home)));
  const response = await requestBytes("PUT", "http://hub-worker/v1/skills", bytes, {
    socketPath,
    signal,
    maxBytes: 4096,
    headers: { "content-type": "application/json" },
  });
  requireThat(response.status === 200, "Hub skills could not be published");
}

export function startSkillsPublisher(socketPath: string, home = NodeOS.homedir()) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const poll = async () => {
    try {
      await publishSkills(
        socketPath,
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        home,
      );
    } catch {
      /* Connect retries synchronously and surfaces failure; no skill contents in logs. */
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => void poll(), 30000);
      timer.unref();
    }
  };
  void poll();
  return () => {
    controller.abort();
    if (timer) clearTimeout(timer);
  };
}
