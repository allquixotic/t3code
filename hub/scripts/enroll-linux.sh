#!/bin/sh
# Run only the hub-built installer under the selected host's timed SSH grant.
set -eu
umask 022
if [ "$(id -u)" -ne 0 ] || [ "$(uname -s)" != Linux ]; then
  printf '%s\n' 'Run enrollment as administrator on the selected Linux remote.' >&2; exit 1
fi
if [ "$#" -ne 6 ]; then
  printf '%s\n' 'Usage: enroll-linux.sh ARCHIVE SHA256 CONFIG CONFIG_SHA256 SERVICE SERVICE_SHA256' >&2; exit 1
fi
archive=$1; archive_sha=$2; config=$3; config_sha=$4; unit=$5; unit_sha=$6
for path in /etc/t3-hub /var/lib/t3-hub /usr/local/bin/t3-hub-agent /etc/systemd/system/t3-hub-remote.service; do
  if [ -e "$path" ] || [ -L "$path" ]; then printf 'Already present: %s; inspect existing enrollment before retrying.\n' "$path" >&2; exit 1; fi
done
staging=$(mktemp -d /var/lib/t3-hub-enroll.XXXXXXXX)
completed=no; group_created=no; member_added=no; runtime_user=
cleanup() {
  code=$?
  if [ "$completed" != yes ]; then
    systemctl disable --now t3-hub-remote.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/t3-hub-remote.service /usr/local/bin/t3-hub-agent
    rm -f /etc/t3-hub/remote.json
    rmdir /etc/t3-hub 2>/dev/null || true
    if [ "$member_added" = yes ]; then gpasswd -d "$runtime_user" t3-hub-connect >/dev/null; fi
    if [ "$group_created" = yes ]; then groupdel t3-hub-connect; fi
    systemctl daemon-reload
    printf '%s\n' 'Enrollment did not complete. New service/config removed; release/state retained under /var/lib/t3-hub for inspection.' >&2
  fi
  rm -rf "$staging"
  exit "$code"
}
trap cleanup EXIT
cp "$archive" "$staging/runtime.tar"
cp "$config" "$staging/remote.json"
cp "$unit" "$staging/t3-hub-remote.service"
printf '%s  %s\n' "$archive_sha" "$staging/runtime.tar" "$config_sha" "$staging/remote.json" "$unit_sha" "$staging/t3-hub-remote.service" | sha256sum -c -
python3 - "$staging/remote.json" <<'PY'
import json,pwd,os,sys,platform
c=json.load(open(sys.argv[1])); p=pwd.getpwnam(c['runtime_user'])
assert c['ssh_user']==p.pw_name and c['runtime_uid']==p.pw_uid and c['runtime_gid']==p.pw_gid and c['runtime_home']==p.pw_dir
assert c['root_directory']=='/var/lib/t3-hub/releases' and c['base_directory']=='/var/lib/t3-hub/state' and c['socket']=='/run/t3-hub/supervisor.sock'
assert c['alias']==platform.node().split('.')[0], 'Remote hostname does not match explicitly selected alias'
assert p.pw_uid>=0 and c['public_key'].startswith('-----BEGIN PUBLIC KEY-----')
PY
runtime_user=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runtime_user"])' "$staging/remote.json")
runtime_group=$(id -gn "$runtime_user")
install -d -m 0755 /var/lib/t3-hub /var/lib/t3-hub/releases /etc/t3-hub
install -d -m 0700 -o "$runtime_user" -g "$runtime_group" /var/lib/t3-hub/state
install -d -m 0755 /var/lib/t3-hub/releases/bootstrap
tar --no-same-owner --no-same-permissions -xf "$staging/runtime.tar" -C /var/lib/t3-hub/releases/bootstrap
chown -R root:root /var/lib/t3-hub/releases
chmod -R u+rwX,go+rX,go-w /var/lib/t3-hub/releases
/var/lib/t3-hub/releases/bootstrap/t3 --version
install -m 0644 "$staging/remote.json" /etc/t3-hub/remote.json
if ! getent group t3-hub-connect >/dev/null; then groupadd --system t3-hub-connect; group_created=yes; fi
if ! id -nG "$runtime_user" | tr ' ' '\n' | grep -qx t3-hub-connect; then
  usermod -a -G t3-hub-connect "$runtime_user"; member_added=yes
fi
cat > /usr/local/bin/t3-hub-agent <<'SH'
#!/bin/sh
exec /var/lib/t3-hub/releases/bootstrap/t3 __hub-agent "$@" --config /etc/t3-hub/remote.json
SH
chmod 0755 /usr/local/bin/t3-hub-agent
install -m 0644 "$staging/t3-hub-remote.service" /etc/systemd/system/t3-hub-remote.service
systemctl daemon-reload
systemctl enable --now t3-hub-remote.service
attempt=0
until test -S /run/t3-hub/supervisor.sock; do
  attempt=$((attempt+1)); test "$attempt" -lt 30 || { printf '%s\n' 'Supervisor socket readiness failed' >&2; exit 1; }
  systemctl is-active --quiet t3-hub-remote.service || exit 1
  sleep 1
done
# Only the new enrollment is removed by rollback; user data and prior tools remain.
cat > /var/lib/t3-hub/rollback-enrollment.sh <<SH
#!/bin/sh
set -eu
test "\$(id -u)" -eq 0
systemctl disable --now t3-hub-remote.service
rm -f /etc/systemd/system/t3-hub-remote.service /usr/local/bin/t3-hub-agent /etc/t3-hub/remote.json
rmdir /etc/t3-hub 2>/dev/null || true
if [ '$member_added' = yes ]; then gpasswd -d '$runtime_user' t3-hub-connect; fi
if [ '$group_created' = yes ]; then groupdel t3-hub-connect; fi
systemctl daemon-reload
printf '%s\\n' 'Enrollment disabled. Runtime/state retained in /var/lib/t3-hub.'
SH
chmod 0700 /var/lib/t3-hub/rollback-enrollment.sh
completed=yes
printf '%s\n' 'ENROLLED: protected supervisor ready; no T3 runtime starts until a signed timed lease arrives.' 'Rollback: sudo /bin/sh /var/lib/t3-hub/rollback-enrollment.sh'
