import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedProxyConfig } from "../scripts/proxy-config.ts";

test(
  "managed Caddy route retains Authelia while isolating primary and remote credentials",
  { skip: !existsSync("/usr/bin/caddy") },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3-hub-proxy-test-"));
    const authHeaders: http.IncomingHttpHeaders[] = [];
    const auth = http.createServer((req, res) => {
      authHeaders.push(req.headers);
      res.writeHead(
        req.headers.cookie === "fixture=approved" && !req.headers.authorization ? 200 : 401,
        { "Remote-User": "fixture-user" },
      );
      res.end();
    });
    const upstream = http.createServer((req, res) => {
      res.setHeader("set-cookie", "must-not-reach-browser=1");
      res.end(
        JSON.stringify({
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          user: req.headers["remote-user"],
          dpop: req.headers.dpop,
        }),
      );
    });
    const listen = async (s: net.Server) => {
      s.listen(0, "127.0.0.1");
      await once(s, "listening");
      return (s.address() as net.AddressInfo).port;
    };
    const authPort = await listen(auth),
      upstreamPort = await listen(upstream);
    const probe = net.createServer(),
      port = await listen(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    const original = `{
 admin off
 auto_https off
 persist_config off
}
:${port} {
 bind 127.0.0.1
 route {
  request_header -Remote-User
  request_header -Authorization
  import /usr/local/lib/hub-broker/hub-access.caddy
  handle {
   forward_auth 127.0.0.1:${authPort} {
    uri /auth
    copy_headers Remote-User
   }
   reverse_proxy 127.0.0.1:${upstreamPort} {
    header_up Authorization "Bearer fixture-primary"
    header_up -Cookie
    header_up -Remote-User
    header_down -Set-Cookie
   }
  }
 }
}
`;
    const managed = managedProxyConfig(original);
    assert.equal(managedProxyConfig(managed), managed);
    assert.throws(() => managedProxyConfig("unrecognized configuration"));
    const snippet = readFileSync(new URL("../deploy/t3-hub-remote.caddy", import.meta.url), "utf8")
      .replaceAll("127.0.0.1:9091", `127.0.0.1:${authPort}`)
      .replaceAll("127.0.0.1:3773", `127.0.0.1:${upstreamPort}`);
    const config = join(dir, "Caddyfile");
    writeFileSync(
      config,
      managed
        .replace(
          "import /usr/local/lib/hub-broker/hub-access.caddy",
          "handle /access/* {\n respond 200\n}",
        )
        .replace("import /etc/caddy/t3-hub-remote.caddy", snippet),
    );
    const child = spawn("/usr/bin/caddy", ["run", "--config", config, "--adapter", "caddyfile"], {
      env: { PATH: "/usr/bin:/bin", HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = once(child, "exit");
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture Caddy startup timed out")), 10000);
        child.once("error", reject);
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Fixture Caddy exited"));
        });
        child.stderr.on("data", (b) => {
          if (b.toString().includes("serving initial configuration")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const base = `http://127.0.0.1:${port}`;
      const headers = {
        cookie: "fixture=approved",
        authorization: "Bearer fixture-remote",
        dpop: "fixture-proof",
        "remote-user": "forged",
      };
      const primary = await fetch(base + "/api/environment", { headers });
      assert.equal(primary.status, 200);
      assert.deepEqual(await primary.json(), {
        authorization: "Bearer fixture-primary",
        dpop: "fixture-proof",
      });
      const remote = await fetch(base + "/hub/environments/seanaoruslin/api/environment", {
        headers,
      });
      assert.equal(remote.status, 200);
      assert.deepEqual(await remote.json(), {
        authorization: "Bearer fixture-remote",
        dpop: "fixture-proof",
      });
      assert.equal(remote.headers.get("set-cookie"), null);
      const unauthenticated = await fetch(base + "/hub/environments/seanaoruslin/api/environment", {
        headers: { authorization: "Bearer fixture-remote" },
      });
      assert.equal(unauthenticated.status, 401);
      assert(
        authHeaders.every((h) => h.authorization === undefined && h["remote-user"] === undefined),
      );
    } finally {
      child.kill("SIGTERM");
      await exited;
      auth.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => auth.close(() => r())),
        new Promise<void>((r) => upstream.close(() => r())),
      ]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
