// @effect-diagnostics nodeBuiltinImport:off - bounded archive installation adapter.
import {
  createReadStream,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  lstatSync,
  chmodSync,
  symlinkSync,
  linkSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname, relative, isAbsolute, win32, sep } from "node:path";
import { createGunzip } from "node:zlib";
import { requireThat } from "./io.ts";

const field = (bytes: Buffer) => bytes.toString("utf8").split("\0", 1)[0]!;
const number = (bytes: Buffer) => {
  const value = field(bytes).trim();
  requireThat(/^[0-7]*$/.test(value), "Unsupported archive number");
  const result = parseInt(value || "0", 8);
  requireThat(Number.isSafeInteger(result), "Archive number overflow");
  return result;
};
/** Extract only regular files, directories and contained links into a fresh protected staging tree. */
export async function extractTar(
  file: string,
  destination: string,
  signal: AbortSignal,
  gzip = false,
) {
  signal.throwIfAborted();
  const root = realpathSync(destination),
    deferred: { path: string; target: string; hard: boolean }[] = [];
  let entries = 0,
    total = 0,
    pax: Record<string, string> = {},
    longName: string | undefined,
    longLink: string | undefined;
  const fileStream = createReadStream(file, { signal });
  const input = gzip ? fileStream.pipe(createGunzip()) : fileStream;
  if (input !== fileStream) fileStream.on("error", (error) => input.destroy(error));
  const iterator = input[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  async function take(size: number): Promise<Buffer> {
    const pieces: Buffer[] = [];
    let remaining = size;
    while (remaining) {
      signal.throwIfAborted();
      if (!buffered.length) {
        const item = await iterator.next();
        requireThat(!item.done, "Truncated archive");
        buffered = Buffer.from(item.value);
      }
      const count = Math.min(remaining, buffered.length);
      pieces.push(buffered.subarray(0, count));
      buffered = buffered.subarray(count);
      remaining -= count;
    }
    return pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, size);
  }
  const within = (name: string) => {
    requireThat(
      !name.includes("\0") &&
        !name.includes("\\") &&
        !name.includes(":") &&
        !isAbsolute(name) &&
        !win32.isAbsolute(name),
      "Archive path must be relative",
    );
    const path = resolve(root, name),
      rel = relative(root, path);
    requireThat(
      rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel),
      "Archive path escapes installation",
    );
    if (process.platform === "win32")
      requireThat(
        name
          .split("/")
          .every(
            (part) =>
              part === "." ||
              part === ".." ||
              (!/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)),
          ),
        "Unsafe Windows archive path",
      );
    return path;
  };
  function parents(path: string) {
    if (path === root) return;
    parents(dirname(path));
    try {
      const info = lstatSync(path);
      requireThat(
        info.isDirectory() && !info.isSymbolicLink(),
        "Archive parent is not a directory",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(path, { mode: 0o755 });
    }
  }
  try {
    for (;;) {
      const header = await take(512);
      if (header.every((byte) => byte === 0)) {
        requireThat(
          (await take(512)).every((byte) => byte === 0),
          "Invalid archive terminator",
        );
        break;
      }
      requireThat(++entries <= 100000, "Archive has too many entries");
      const expected = number(header.subarray(148, 156));
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
      requireThat(checksum === expected, "Archive header checksum mismatch");
      const size = number(header.subarray(124, 136)),
        mode = number(header.subarray(100, 108));
      total += size;
      requireThat(
        size <= 1024 ** 3 && total <= 4 * 1024 ** 3,
        "Archive exceeds installation limit",
      );
      const type = String.fromCharCode(header[156] || 48);
      if (["x", "g", "L", "K"].includes(type)) {
        requireThat(size <= 1 << 20, "Archive metadata exceeds limit");
        const value = await take(size);
        if (type === "L") longName = field(value);
        else if (type === "K") longLink = field(value);
        else {
          let offset = 0;
          const parsed: Record<string, string> = {};
          while (offset < value.length) {
            const space = value.indexOf(32, offset),
              length = Number(value.subarray(offset, space).toString());
            requireThat(
              space > offset &&
                Number.isSafeInteger(length) &&
                length > space - offset + 2 &&
                offset + length <= value.length,
              "Malformed PAX metadata",
            );
            const entry = value.subarray(space + 1, offset + length - 1).toString(),
              equal = entry.indexOf("=");
            requireThat(equal > 0 && value[offset + length - 1] === 10, "Malformed PAX entry");
            parsed[entry.slice(0, equal)] = entry.slice(equal + 1);
            offset += length;
          }
          if (type === "g")
            requireThat(
              !parsed.path && !parsed.linkpath && !parsed.size,
              "Global PAX path/size unsupported",
            );
          else pax = parsed;
        }
        await take((512 - (size % 512)) % 512);
        continue;
      }
      const prefix =
          field(header.subarray(257, 263)) === "ustar" ? field(header.subarray(345, 500)) : "",
        raw = field(header.subarray(0, 100));
      const name = pax.path ?? longName ?? (prefix ? prefix + "/" + raw : raw),
        target = pax.linkpath ?? longLink ?? field(header.subarray(157, 257));
      requireThat(pax.size === undefined || Number(pax.size) === size, "PAX size disagreement");
      pax = {};
      longName = undefined;
      longLink = undefined;
      const path = within(name);
      if (type === "5") {
        requireThat(size === 0, "Directory has archive body");
        parents(path);
      } else if (type === "0") {
        requireThat(path !== root, "Archive file replaces installation root");
        parents(dirname(path));
        const fd = openSync(path, "wx", mode & 0o111 ? 0o755 : 0o644);
        try {
          for (let left = size; left > 0;) {
            const bytes = await take(Math.min(left, 65536));
            let offset = 0;
            while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
            left -= bytes.length;
          }
        } finally {
          closeSync(fd);
        }
        chmodSync(path, mode & 0o111 ? 0o755 : 0o644);
      } else if (type === "1" || type === "2") {
        requireThat(size === 0 && path !== root, "Invalid archive link");
        parents(dirname(path));
        const normalized =
          type === "1"
            ? within(target)
            : within(
                relative(root, resolve(dirname(path), target))
                  .split(sep)
                  .join("/"),
              );
        requireThat(
          !isAbsolute(target) && !win32.isAbsolute(target) && !target.includes("\\"),
          "Archive link must be relative",
        );
        deferred.push({ path, target: type === "1" ? normalized : target, hard: type === "1" });
      } else throw new Error("Unsupported archive entry type");
      await take((512 - (size % 512)) % 512);
    }
    // No file write ever follows an archive-created symlink.
    for (const item of deferred.filter((item) => item.hard)) {
      requireThat(
        lstatSync(item.target).isFile() && !lstatSync(item.target).isSymbolicLink(),
        "Invalid archive hard link",
      );
      linkSync(item.target, item.path);
    }
    for (const item of deferred.filter((item) => !item.hard)) symlinkSync(item.target, item.path);
    for (const item of deferred) {
      const actual = realpathSync(item.path);
      requireThat(
        actual === root || actual.startsWith(root + sep),
        "Archive link escapes installation",
      );
    }
    // Consume padding and the gzip trailer so truncated/corrupt compressed streams fail.
    let padding = 0;
    for (;;) {
      padding += buffered.length;
      requireThat(
        padding <= 16 * 1024 ** 2 && buffered.every((byte) => byte === 0),
        "Invalid archive padding",
      );
      const item = await iterator.next();
      if (item.done) break;
      buffered = Buffer.from(item.value);
    }
    signal.throwIfAborted();
  } finally {
    input.destroy();
    fileStream.destroy();
  }
}
