// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, lstatSync } from "node:fs";
import { protectedPath } from "../../../../hub/src/protected-path.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Argument, Flag } from "effect/unstable/cli";
import {
  parseRemoteConfig,
  remoteServer,
  remoteConnect,
  superviseRemote,
} from "../../../../hub/src/remote.ts";

function loadRemotePolicy(path: string) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    (process.platform !== "win32" && (info.uid !== 0 || (info.mode & 0o022) !== 0))
  )
    throw new Error("Administrator-owned remote policy required");
  const policy = parseRemoteConfig(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(readFileSync(path, "utf8")),
  );
  if (process.platform !== "win32") {
    protectedPath(path);
    protectedPath(policy.root_directory);
  }
  return policy;
}
export const hubAgentCommand = Command.make("__hub-agent", {
  action: Argument.string("action"),
  config: Flag.string("config").pipe(
    Flag.withDefault(
      process.platform === "win32"
        ? "C:\\ProgramData\\t3-hub\\remote.json"
        : "/etc/t3-hub/remote.json",
    ),
  ),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ action, config }) =>
    Effect.promise(async () => {
      const policy = loadRemotePolicy(config);
      if (action === "connect") {
        await remoteConnect(policy.socket);
        return;
      }
      if (action === "supervise") {
        await superviseRemote(policy, config);
        return;
      }
      if (action !== "serve") throw new Error("Unknown remote supervisor action");
      if (process.platform !== "win32" && process.getuid?.() !== 0)
        throw new Error("Remote supervisor requires its protected service identity");
      const service = remoteServer(policy);
      await new Promise<void>((resolve, reject) => {
        service.server.once("error", reject);
        service.server.once("upgraded", resolve);
        const stop = () => {
          void service.close().then(resolve, reject);
        };
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
      });
    }),
  ),
);
