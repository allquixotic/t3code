// @effect-diagnostics nodeBuiltinImport:off - fixed unprivileged remote skill receiver.
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { collect } from "../../../../hub/src/io.ts";
import { installSkills, SKILLS_LIMIT } from "../../../../hub/src/skills.ts";

export const hubSkillsCommand = Command.make("__hub-skills").pipe(
  Command.unlisted,
  Command.withHandler(() =>
    Effect.promise(async () => {
      await installSkills(await collect(process.stdin, SKILLS_LIMIT), NodeOS.homedir());
    }),
  ),
);
