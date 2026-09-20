import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repositoryCommand, publicationScript } from "../scripts/publication-shell.ts";

function fixture(body: string) {
  const directory = mkdtempSync(join(tmpdir(), "hub-publication-test-"));
  writeFileSync(join(directory, "gh"), "#!/bin/sh\n" + body, { mode: 0o700 });
  return {
    run: (script: string) =>
      spawnSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        env: { PATH: directory + ":/usr/bin:/bin", PUBLISH_FIXTURE: directory },
      }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("creating a missing fork returns only its verified name, excluding failed lookup JSON", () => {
  const f = fixture(`
if [ "$1 $2" = "repo fork" ]; then
  test "$3" = pingdotgg/t3code && test "$4" = --clone=false && test "$#" = 4 || exit 2
  touch "$PUBLISH_FIXTURE/created"
  printf '%s\\n' https://github.com/allquixotic/t3code
elif [ -f "$PUBLISH_FIXTURE/created" ]; then
  printf '%s\\n' allquixotic/t3code
else
  printf '%s\\n' '{"message":"Not Found","status":"404"}'
  exit 1
fi
`);
  try {
    const result = f.run(repositoryCommand);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "allquixotic/t3code\n");
  } finally {
    f.cleanup();
  }
});
test("an existing repository does not attempt fork creation and creation failures propagate", () => {
  const existing = fixture('test "$1" = api || exit 99\nprintf "%s\\n" allquixotic/t3code\n');
  const denied = fixture('printf "%s\\n" denied >&2\nexit 1\n');
  try {
    const a = existing.run(repositoryCommand);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout, "allquixotic/t3code\n");
    const b = denied.run(repositoryCommand);
    assert.equal(b.status, 1);
    assert.equal(b.stdout, "");
    assert.match(b.stderr, /denied/);
  } finally {
    existing.cleanup();
    denied.cleanup();
  }
});
test("a failed identity guard names its step and retains publication staging", () => {
  const f = fixture('printf "%s\\n" unexpected-account\n');
  try {
    const script = publicationScript("/unused", "a".repeat(40))
      .replace(/^PATH=.*$/m, "# Test fixture supplies PATH")
      .replace('test "$(id -un)" = sean', ":");
    const result = f.run(script);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Publication failed during GitHub account verification.*Staging retained/,
    );
  } finally {
    f.cleanup();
  }
});
