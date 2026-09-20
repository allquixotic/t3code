import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { extractTar } from "../src/archive.ts";

function entry(name: string, body = "", type = "0", target = "", mode = 0o644) {
  const header = Buffer.alloc(512),
    bytes = Buffer.from(body);
  header.write(name, 0, 100);
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write(target, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
function fixture(...entries: Buffer[]) {
  const directory = mkdtempSync(join(tmpdir(), "hub-archive-test-")),
    destination = join(directory, "out"),
    file = join(directory, "archive.tar");
  mkdirSync(destination);
  writeFileSync(file, Buffer.concat([...entries, Buffer.alloc(1024)]));
  return {
    directory,
    destination,
    file,
    run: (gzip = false) => extractTar(file, destination, AbortSignal.timeout(5000), gzip),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("extracts nested files and contained links with safe permissions", async () => {
  const f = fixture(
    entry("./", "", "5"),
    entry("nested/bin/run", "hello", "0", "", 0o4777),
    entry("hard", "", "1", "nested/bin/run"),
    entry("nested/link", "", "2", "bin/run"),
  );
  try {
    await f.run();
    assert.equal(readFileSync(join(f.destination, "nested/link"), "utf8"), "hello");
    assert.equal(readFileSync(join(f.destination, "hard"), "utf8"), "hello");
    assert.equal(statSync(join(f.destination, "nested/bin/run")).mode & 0o7777, 0o755);
  } finally {
    f.cleanup();
  }
});
test("extracts gzip and PAX long names", async () => {
  const path = "nested/" + "a".repeat(160);
  const text = " path=" + path + "\n";
  let length = Buffer.byteLength(text) + 3;
  while (String(length).length + Buffer.byteLength(text) !== length)
    length = String(length).length + Buffer.byteLength(text);
  const f = fixture(entry("metadata", String(length) + text, "x"), entry("placeholder", "pax"));
  try {
    writeFileSync(f.file, gzipSync(readFileSync(f.file)));
    await f.run(true);
    assert.equal(readFileSync(join(f.destination, path), "utf8"), "pax");
  } finally {
    f.cleanup();
  }
});
test("rejects traversal, absolute, drive and alternate-stream paths", async () => {
  for (const path of [
    "../escape",
    "nested/../../escape",
    "/escape",
    "C:/escape",
    "nested\\escape",
    "file:stream",
  ]) {
    const f = fixture(entry(path, "bad"));
    try {
      await assert.rejects(f.run(), /Archive path/);
      assert.equal(existsSync(join(f.directory, "escape")), false);
    } finally {
      f.cleanup();
    }
  }
});
test("rejects symlink and hardlink escapes and never writes through symlink parents", async () => {
  for (const item of [
    entry("link", "", "2", "../escape"),
    entry("link", "", "1", "../escape"),
    entry("link", "", "2", "/etc/passwd"),
  ]) {
    const f = fixture(item);
    try {
      await assert.rejects(f.run(), /Archive/);
    } finally {
      f.cleanup();
    }
  }
  const f = fixture(entry("nested/escape", "bad"));
  try {
    symlinkSync(f.directory, join(f.destination, "nested"));
    await assert.rejects(f.run(), /parent is not a directory/);
    assert.equal(existsSync(join(f.directory, "escape")), false);
  } finally {
    f.cleanup();
  }
  const g = fixture(entry("nested", "", "2", "."), entry("nested/escape", "bad"));
  try {
    await assert.rejects(g.run(), /EEXIST/);
    assert.equal(existsSync(join(g.destination, "escape")), false);
  } finally {
    g.cleanup();
  }
});
test("rejects corrupt headers, truncated bodies, unsupported entries and corrupt gzip trailers", async () => {
  for (const kind of ["checksum", "truncated", "device", "gzip"] as const) {
    const f = fixture(entry("file", "payload", kind === "device" ? "3" : "0"));
    try {
      let bytes = readFileSync(f.file);
      if (kind === "checksum") bytes[0] = 88;
      if (kind === "truncated") bytes = bytes.subarray(0, 515);
      if (kind === "gzip") {
        bytes = gzipSync(bytes);
        bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 255;
      }
      writeFileSync(f.file, bytes);
      await assert.rejects(f.run(kind === "gzip"));
    } finally {
      f.cleanup();
    }
  }
});
test("missing compressed archive and cancellation reject without uncaught stream errors", async () => {
  const f = fixture();
  try {
    rmSync(f.file);
    await assert.rejects(f.run(true), /ENOENT/);
    writeFileSync(f.file, Buffer.alloc(1024));
    await assert.rejects(extractTar(f.file, f.destination, AbortSignal.abort()));
  } finally {
    f.cleanup();
  }
});
