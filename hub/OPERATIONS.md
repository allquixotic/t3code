# Operating the maintained hub fork

The maintained branch is `allquixotic/t3code:hub-passkey`. `hub/release.json` records its stable upstream baseline. Development, upgrades, dependency installs, tests, and all target builds run on **t3code**. The application coordinates approval and deployment without adding any grant arguments, orchestration instructions, or tools to the model's normal remote work.

A connection has two authorities: the protected hub broker approves a host and fixed deadline through the existing Authelia passkey page; an enrolled remote supervisor accepts a nonce-bound signed lease for that deadline and exact release manifest. The unprivileged hub T3 server proxies HTTP/WebSocket traffic through that connection. Provider CLIs, filesystem tools, terminals, and their working directories are native to the selected remote. Expiry or revoke closes the transport and stops its remote runtime. Reconnecting never renews access without a new approval.

## Build and maintain

Invoke `t3-hub-upgrade` in Codex or Claude Code on the hub. Its source is [skill/SKILL.md](skill/SKILL.md). The scripted entry points are:

```sh
node hub/scripts/maintain.ts check
node hub/scripts/maintain.ts prepare
node hub/scripts/verify.ts
node hub/scripts/build-broker.ts
# After committing the tested candidate:
node hub/scripts/package.ts
```

`prepare` makes a local worktree based on `hub-passkey` and merges the exact latest stable tag. The agent must adapt both conflicts and changed upstream interfaces, then commit, validate, and fast-forward the maintained branch. It must never replace the fork with main/nightly or force-push shared history.

`package` defaults to Linux x64/arm64, macOS arm64, and Windows x64/arm64. Pass a smaller explicit platform list only for an installation with that matching coverage. Upstream v0.0.42 does not distribute a macOS x64 native archive; such enrollment fails closed. Packaging rebuilds the patched executable and web application locally, reuses checksum-verified native dependencies from the exact stable archive, and writes `hub/artifacts/<git-revision>/manifest.json` last. A changed dependency lock requires engineering new local target builds first. The protected artifact store never fetches arbitrary software from a remote host.

The broker bundle is TypeScript compiled to JavaScript, plus the existing approval page with remote scope details and a small Linux N-API bridge for kernel peer credentials and process hardening. It requires no Go runtime or Go binary. OpenSSH still performs SSH authentication and stores the signing identity inside the isolated signer. Existing credential stores and passkeys remain in place.

## Hub installation

Installation changes protected services and restarts T3, so run it from a separate administrator terminal or a transient administrator service, not from the T3 agent process being replaced. Keep that terminal available for rollback. Build and validate first. No installation script prints credential files or keys.

Create an enrollment JSON containing only an `environments` map, using the fields from [deploy/environments.example.json](deploy/environments.example.json). Every entry must refer to an existing broker SSH alias and a successfully enrolled remote, with its verified architecture. Include **all** environments that will be available in this hub installation. Never substitute raw native SSH environments for unavailable broker enrollment.

Run the staged installer as administrator on t3code:

```sh
node hub/scripts/install-hub.ts \
  /home/sean/workspaces/operations/t3code-hub/hub/dist \
  /home/sean/workspaces/operations/t3code-hub/hub/artifacts/EXACT_COMMIT \
  /root/t3-hub-environments.json
```

It snapshots existing policy, broker clients, service overrides, and the T3 release link under `/var/backups/t3-hub/`; installs immutable root-owned bundles; creates a protected Ed25519 signing key only if absent; preserves the independent `hub-unlocker` account and existing passkey/SSH/provider policy; enables the broker socket for T3; and switches the hub runtime. The **public** key `/etc/hub-broker/lease-ed25519.pub` is the only key copied to remotes. The private key stays root-owned and readable only by the broker group.

Node runs with `--jitless` under the existing service hardening. The TypeScript service overrides use `Type=simple`; startup and first live approval need explicit verification after installation. The installation does not change Caddy, Authelia, OpenBao, SSH authentication, or the signer key. Retire the former unmanaged remote T3 listeners during each explicitly scoped enrollment; leaving independent listeners or credentials available would preserve a path outside the new gate.

For rollback from the separate administrator terminal:

```sh
node hub/scripts/rollback-hub.ts /var/backups/t3-hub/EXACT_BACKUP_DIRECTORY
```

This restores the saved policy/clients/overrides and prior T3 release link. Restarting either broker ends its in-memory grants; request a fresh passkey approval. Keep previous remote release directories and their state backups until the new version has passed live checks. Database changes may require restoring the corresponding state backup; do not silently downgrade a migrated database.

## First remote enrollment

Enrollment is the one-time privileged setup needed to prevent the ordinary runtime account from changing its own trust policy. A timed SSH grant does not manufacture administrator privileges. Perform it only on an explicitly selected host after verifying its resolved SSH identity, hostname, user, and working directory. Existing authorization selects `mbp` for testing, not changes to every catalog host or SSH authentication settings.

1. Copy the checksum-verified patched archive from t3code and extract it into an administrator-owned `/var/lib/t3-hub/releases/bootstrap`. Do not clone source or build/install dependencies there. On macOS ad-hoc sign the cross-built bootstrap executable with `/usr/bin/codesign --force --sign - /var/lib/t3-hub/releases/bootstrap/t3`; later updates perform that step automatically. On Windows use `C:\ProgramData\t3-hub\releases\bootstrap`.
2. Create a protected configuration from [deploy/remote.example.json](deploy/remote.example.json), with the real runtime identity, UID/GID, home, tool PATH, and the hub's public lease key. Keep release/config ancestors administrator-owned and unwritable by the runtime user. Create its writable state directory separately. Do not point it at live state without a backup and migration review.
3. On Linux install [deploy/t3-hub-remote.service](deploy/t3-hub-remote.service); on macOS install [deploy/org.allquixotic.t3-hub.plist](deploy/org.allquixotic.t3-hub.plist). Provision the `t3-hub-connect` group and the socket directory, and allow the enrolled SSH account to connect. Install `/usr/local/bin/t3-hub-agent` as a protected wrapper executing the bootstrap binary's `__hub-agent connect --config /etc/t3-hub/remote.json`. This changes the new supervisor's socket access, not SSH authentication. Start the service with the platform's service manager.
4. Windows needs an administrator-protected startup task/service running as the **enrolled runtime account**, with automatic restart and its named-pipe/config ACLs restricted to administrators and the SSH account. Do not run it as SYSTEM while configuring another runtime user: the implementation rejects that mismatch. Use `bootstrap\t3.exe __hub-agent supervise --config C:\ProgramData\t3-hub\remote.json`; a wrapper for `connect` must be available at the absolute path in hub policy. Its OS service enrollment must be validated on that Windows host before enabling the entry.
5. Add that exact alias/platform/supervisor to the hub's protected environment map. After approval, the application checks the installed revision, uploads a newer signed-manifest artifact if needed, and atomically activates it. The supervisor re-executes from the verified new revision after the lease closes. Subsequent updates need only the normal timed approval.

Linux runtimes use a systemd cgroup with an independent maximum lifetime. macOS process groups and Windows process-tree termination clean up ordinary descendants, but cannot contain a deliberately escaping daemon or a hostile administrator. This is a gate against later unauthorized access through the hub, not a sandbox against malicious code or an administrator on an already approved remote. Root/admin runtime accounts can change their machine's security; the grant does not undo their changes. The broker still rejects new traffic and tears down existing tunnels at its deadline on every platform.

## Verification and publication

Automated checks use temporary state and fixture keys only. They cover passkey binding, CSRF/cookies, expiry/revoke races, signed scope/nonce/deadline/manifest validation, interrupted updates, checksums, HTTP and WebSocket tunneling, Unix caller credentials, and managed endpoint routing. They do not claim real passkey or remote OS service validation. Perform an approved live smoke test on the selected host: approve, connect, execute a harmless native `hostname`/`pwd`, update a stale runtime, revoke, and confirm an existing terminal and new operations both lose access. Also test expiry without reconnecting or approving again. Browser automation requires the repository's separate explicit permission.

Publishing is restricted to `allquixotic/t3code:hub-passkey`. The user authorizes `gh` on `mbp` as the publishing credential holder. Obtain this task's timed `ssh:mbp` grant through the existing broker, then run `node hub/scripts/publish-via-mbp.ts GRANT_ID` locally on t3code. It uses a temporary bare transport repository on mbp; it does no remote checkout, development, dependency installation, or build. GitHub credentials stay inside `gh` on mbp. Verify the remote ref and revoke the task's grant. This supersedes the need for a GitHub write provider in the local broker; it does not authorize raw SSH or exporting a GitHub token.
