const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// Capture failed lookup stdout: gh writes its JSON error body there, and it must
// never become part of the successful repository name after creating the fork.
export const repositoryCommand =
  'if repository_name=$(gh api repos/allquixotic/t3code --jq .full_name 2>/dev/null); then printf "%s\\n" "$repository_name"; else gh repo fork pingdotgg/t3code --clone=false >/dev/null && gh api repos/allquixotic/t3code --jq .full_name; fi';

export function publicationScript(staging: string, revision: string) {
  const git =
    "git -C repository.git -c credential.helper= -c 'credential.helper=!gh auth git-credential'";
  return `#!/bin/sh
set -eu
step='initialization'
trap 'code=$?; if [ "$code" -ne 0 ]; then printf "Publication failed during %s (exit %s). Staging retained.\\n" "$step" "$code" >&2; fi' EXIT
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
step='Mac user verification'
test "$(id -un)" = sean
step='GitHub account verification'
test "$(gh api user --jq .login)" = allquixotic
step='staged commit verification'
cd ${quote(staging)}
test "$(git -C repository.git rev-parse refs/heads/hub-passkey)" = ${quote(revision)}
step='GitHub repository lookup or fork creation'
test "$( ${repositoryCommand} )" = allquixotic/t3code
step='existing remote branch check'
remote_ref="$(${git} ls-remote https://github.com/allquixotic/t3code.git refs/heads/hub-passkey)"
case "$remote_ref" in
  ${quote(revision)}*) printf '%s\\n' 'Exact commit already published; verifying.' ;;
  *) step='branch push'; ${git} push https://github.com/allquixotic/t3code.git refs/heads/hub-passkey:refs/heads/hub-passkey ;;
esac
step='published commit verification'
test "$(gh api repos/allquixotic/t3code/git/ref/heads/hub-passkey --jq .object.sha)" = ${quote(revision)}
printf '%s\\n' ${quote(`Published and verified ${revision}`)}
step='temporary directory cleanup'
cd /
rm -rf ${quote(staging)}
`;
}
