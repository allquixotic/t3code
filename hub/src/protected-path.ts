// @effect-diagnostics nodeBuiltinImport:off - protected filesystem policy boundary.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { requireThat } from "./io.ts";
/** Protect the whole ancestry: a root-owned file in a worker-writable directory is not trusted. */
export function protectedPath(path: string) {
  const checked = new Set<string>();
  for (const initial of [resolve(path), realpathSync(path)]) {
    let current = initial;
    for (;;) {
      if (checked.has(current)) break;
      checked.add(current);
      const info = lstatSync(current);
      requireThat(
        info.uid === 0 && (info.isSymbolicLink() || (info.mode & 0o022) === 0),
        "Administrator-owned path required",
      );
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}
