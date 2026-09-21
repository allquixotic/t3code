#!/bin/sh
# Run the hub-built installer only on the explicitly selected Mac under its timed SSH grant.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 022
if [ "$(id -u)" -ne 0 ] || [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  printf '%s\n' 'Run enrollment as administrator on the selected Apple Silicon Mac.' >&2; exit 1
fi
if [ "$#" -ne 7 ] && [ "$#" -ne 8 ]; then
  printf '%s\n' 'Usage: enroll-macos.sh BOOTSTRAP SHA256 CONFIG CONFIG_SHA256 PLIST PLIST_SHA256 EXPECTED_HOSTNAME' >&2; exit 1
fi
archive=$1; archive_sha=$2; config=$3; config_sha=$4; plist=$5; plist_sha=$6
test "$(hostname)" = "$7" || { printf '%s\n' 'Selected hostname mismatch' >&2; exit 1; }
service=/Library/LaunchDaemons/org.allquixotic.t3-hub.plist
for path in /etc/t3-hub /var/lib/t3-hub /var/run/t3-hub "$service"; do
  if [ -e "$path" ] || [ -L "$path" ]; then printf 'Already present: %s; inspect before retrying.\n' "$path" >&2; exit 1; fi
done
if dscl . -read /Groups/t3-hub-connect >/dev/null 2>&1; then
  printf '%s\n' 'Existing t3-hub-connect group requires administrator review.' >&2; exit 1
fi
staging=$(mktemp -d /private/var/tmp/t3-hub-enroll.XXXXXXXX)
completed=no; group_created=no; runtime_user=
cleanup() {
  code=$?
  if [ "$completed" != yes ]; then
    launchctl bootout system/org.allquixotic.t3-hub >/dev/null 2>&1 || true
    rm -f "$service" /etc/t3-hub/remote.json
    rmdir /etc/t3-hub 2>/dev/null || true
    if [ "$group_created" = yes ]; then dseditgroup -o delete t3-hub-connect; fi
    printf '%s\n' 'Enrollment incomplete. New service/config removed; /var/lib/t3-hub retained for inspection.' >&2
  fi
  rm -rf "$staging"
  exit "$code"
}
trap cleanup EXIT
cp "$archive" "$staging/bootstrap.tar"
cp "$config" "$staging/remote.json"
cp "$plist" "$staging/service.plist"
printf '%s  %s\n' "$archive_sha" "$staging/bootstrap.tar" "$config_sha" "$staging/remote.json" "$plist_sha" "$staging/service.plist" | shasum -a 256 -c -
plutil -lint "$staging/service.plist"
if [ "${8:-}" = native ]; then
  # The verified hub artifact includes its interpreter. No remote build or package manager.
  read_config() { plutil -extract "$1" raw -o - "$staging/remote.json"; }
  runtime_user=$(read_config runtime_user)
  case "$runtime_user" in ''|*[!A-Za-z0-9_.-]*) exit 1;; esac
  test "$(read_config ssh_user)" = "$runtime_user"
  test "$(read_config runtime_uid)" = "$(id -u "$runtime_user")"
  test "$(read_config runtime_gid)" = "$(id -g "$runtime_user")"
  test "$(read_config runtime_uid)" -gt 0
  test "$(dscl . -read "/Users/$runtime_user" NFSHomeDirectory)" = "NFSHomeDirectory: $(read_config runtime_home)"
  test "$(read_config root_directory)" = /var/lib/t3-hub/releases
  test "$(read_config base_directory)" = /var/lib/t3-hub/state
  test "$(read_config socket)" = /var/lib/t3-hub/run/supervisor.sock
else
# A Homebrew Node and its libraries may be user-writable. This isolated official interpreter
# is used only by the enrollment selector; native T3 updates contain their own interpreter.
node_name=node-v26.8.2-darwin-arm64
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 300 \
  "https://nodejs.org/dist/v26.8.2/$node_name.tar.gz" -o "$staging/node.tar.gz"
printf '%s  %s\n' 974b6d5fb2fc7c33ff2354db0902b4e91c2de01ec8acc6de48e543c97e18c9e1 "$staging/node.tar.gz" | shasum -a 256 -c -
tar -xzf "$staging/node.tar.gz" -C "$staging" "$node_name/bin/node"
node="$staging/$node_name/bin/node"
runtime_user=$("$node" --input-type=module - "$staging/remote.json" "$7" <<'JS'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import assert from 'node:assert/strict';
const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.match(c.runtime_user, /^[A-Za-z0-9_.-]+$/);
const run = (binary, args) => execFileSync(binary, args, { encoding: 'utf8' }).trim();
assert.equal(hostname(), process.argv[3]);
assert.match(c.alias, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
assert.equal(c.ssh_user, c.runtime_user);
assert.equal(c.runtime_uid, Number(run('/usr/bin/id', ['-u', c.runtime_user])));
assert.equal(c.runtime_gid, Number(run('/usr/bin/id', ['-g', c.runtime_user])));
assert(c.runtime_uid > 0);
assert.equal(run('/usr/bin/dscl', ['.', '-read', '/Users/' + c.runtime_user, 'NFSHomeDirectory']), 'NFSHomeDirectory: ' + c.runtime_home);
assert.equal(c.root_directory, '/var/lib/t3-hub/releases');
assert.equal(c.base_directory, '/var/lib/t3-hub/state');
assert.equal(c.socket, '/var/lib/t3-hub/run/supervisor.sock');
assert(c.public_key.startsWith('-----BEGIN PUBLIC KEY-----'));
console.log(c.runtime_user);
JS
)
fi
runtime_group=$(id -gn "$runtime_user")
install -d -o root -g wheel -m 0755 /var/lib /var/lib/t3-hub /var/lib/t3-hub/releases /var/lib/t3-hub/releases/bootstrap /var/lib/t3-hub/node /var/lib/t3-hub/node/bin /etc/t3-hub
install -d -o "$runtime_user" -g "$runtime_group" -m 0700 /var/lib/t3-hub/state
if [ "${8:-}" != native ]; then install -o root -g wheel -m 0755 "$node" /var/lib/t3-hub/node/bin/node; fi
tar -xf "$staging/bootstrap.tar" -C /var/lib/t3-hub/releases/bootstrap
chown -R root:wheel /var/lib/t3-hub/releases
chmod -R u+rwX,go+rX,go-w /var/lib/t3-hub/releases
install -o root -g wheel -m 0644 "$staging/remote.json" /etc/t3-hub/remote.json
if [ "${8:-}" = native ]; then /usr/bin/codesign --force --sign - /var/lib/t3-hub/releases/bootstrap/t3; fi
/var/lib/t3-hub/releases/bootstrap/t3 --version
dseditgroup -o create t3-hub-connect
group_created=yes
dseditgroup -o edit -a "$runtime_user" -t user t3-hub-connect
cat > /var/lib/t3-hub/connect <<'SH'
#!/bin/sh
exec /var/lib/t3-hub/releases/bootstrap/t3 __hub-agent "$@" --config /etc/t3-hub/remote.json
SH
cat > /var/lib/t3-hub/supervise <<'SH'
#!/bin/sh
set -eu
umask 027
# launchd serializes this job. Create a protected directory and discard only
# a stale socket from the previous instance; refuse symlinks and unexpected files.
if [ -L /var/lib/t3-hub/run ]; then exit 1; fi
/usr/bin/install -d -o root -g t3-hub-connect -m 0750 /var/lib/t3-hub/run
socket=/var/lib/t3-hub/run/supervisor.sock
if [ -L "$socket" ]; then exit 1; fi
if [ -e "$socket" ]; then
  test -S "$socket" || exit 1
  /bin/rm "$socket"
fi
exec /var/lib/t3-hub/releases/bootstrap/t3 __hub-agent supervise --config /etc/t3-hub/remote.json
SH
chmod 0755 /var/lib/t3-hub/connect /var/lib/t3-hub/supervise
cat > /var/lib/t3-hub/rollback-enrollment.sh <<SH
#!/bin/sh
set -eu
test "\$(id -u)" -eq 0
/bin/launchctl bootout system/org.allquixotic.t3-hub
/bin/rm -f '$service' /etc/t3-hub/remote.json /var/lib/t3-hub/connect
/bin/rmdir /etc/t3-hub 2>/dev/null || true
/usr/sbin/dseditgroup -o delete t3-hub-connect
printf '%s\\n' 'Enrollment disabled. Runtime/state retained in /var/lib/t3-hub.'
SH
chmod 0700 /var/lib/t3-hub/rollback-enrollment.sh
install -o root -g wheel -m 0644 "$staging/service.plist" "$service"
launchctl bootstrap system "$service"
attempt=0
until test -S /var/lib/t3-hub/run/supervisor.sock; do
  attempt=$((attempt+1)); test "$attempt" -lt 30 || { printf '%s\n' 'Supervisor socket readiness failed' >&2; exit 1; }
  sleep 1
done
completed=yes
printf '%s\n' 'ENROLLED: protected supervisor ready; native T3 waits for a signed timed lease.' 'Rollback: sudo /bin/sh /var/lib/t3-hub/rollback-enrollment.sh'
