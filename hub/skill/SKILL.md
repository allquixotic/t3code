---
name: t3-hub-upgrade
description: Maintain allquixotic/t3code on hub-passkey, upgrading the latest stable T3 baseline while adapting native timed remote access, preserving the passkey UX, and staging verified remote runtimes. Run only on the t3code control VM. Use when asked to upgrade or maintain the T3 hub fork.
---

# Maintain the T3 hub fork

Work on **t3code itself**. Keep the maintained engine, source, dependency installation, tests, builds, and packaging here. A selected remote is a runtime/test destination, never a development host. Use the local execution tool. Before changes verify `hostname`, `id -un`, and `pwd`; fail closed if the short hostname is not `t3code`.

Repository: `/home/sean/workspaces/operations/t3code-hub`. Upstream: `https://github.com/pingdotgg/t3code.git`. Fork: `https://github.com/allquixotic/t3code.git`, maintained branch `hub-passkey`. Read its AGENTS.md and `hub/OPERATIONS.md` before work. The authoritative skill source is `hub/skill/`; installed Codex and Claude copies must remain independent files.

## Upgrade

1. Inspect local modifications, current deployment, and `hub/release.json`. Preserve unrelated work. Run `node hub/scripts/maintain.ts check`. Resolve **latest stable now** from upstream's release API, excluding drafts, previews, nightlies, and prereleases. Never substitute upstream main or an unverified model-recalled version.
2. With a clean maintained branch, run `node hub/scripts/maintain.ts prepare`. It creates a separate local candidate worktree and merges the exact stable tag. Keep all further work in that candidate. If already current, verify the patch and proceed with any requested repair; do not fabricate an upgrade.
3. Agentically adapt conflicts **and semantic changes**, reading upstream release notes and the new remote/auth/process/update interfaces. Preserve the invariants in [references/invariants.md](references/invariants.md). A clean Git merge does not prove compatibility. Change the integration to fit upstream; do not carry dead hooks or weaken authorization to make tests pass.
4. Update `hub/release.json` baseline and patch version, and stamp server/web package versions to the stable version. Keep the original stable tag immutable. Review the complete diff against both the last fork revision and the new stable tag.
5. Run `node hub/scripts/verify.ts` and `node hub/scripts/build-broker.ts`. Use isolated temporary state; never the live T3 userdata, credentials, or approval records. Package checks run sequentially within the hub service's memory budget. Inspect failures, fix patch defects, and distinguish pre-existing upstream failures with evidence. No repository-wide test/typecheck/lint command. Browser verification follows the repository's explicit authorization rule; do not claim it occurred if it did not.
6. Commit the candidate using a conventional commit, then run `node hub/scripts/package.ts` for every enrolled platform. This builds here, uses checksum-verified native dependencies from the same stable release, and creates a manifest binding the exact Git revision, protocol, platform, sizes, and hashes. Require a clean committed revision before packaging. Never build on a remote. A failed/missing platform blocks promotion for that platform.
7. Promote only a verified complete candidate: fast-forward `hub-passkey` to it; retain the prior revision and protected release directory for rollback. Stage the protected hub installation using `hub/OPERATIONS.md`. Routine authorized upgrades need no additional confirmation; unavailable administrator rights or a necessary migration outside scope must be reported with the concrete staged result and recovery instructions.
8. Publish only to `allquixotic/t3code:hub-passkey`, without force-push or PR. The user authorizes `gh` on **mbp** as the publishing credential holder. Request a fresh `ssh:mbp` grant through the existing broker with purpose limited to publication, show its exact passkey approval URL, automatically wait and recheck active status, then run `node hub/scripts/publish-via-mbp.ts GRANT_ID` on t3code. The script verifies mbp/user/directory/GitHub identity, uploads a checksum-verified Git bundle into a temporary bare repository, pushes using `gh auth git-credential`, verifies the exact remote ref, and removes its staging directory. This is a publishing exception only: no remote source checkout, engineering, dependency install, or build. If the local Mac Terminal can authenticate but SSH cannot access Keychain, `--stage-only` prepares a verified temporary repository and a concrete command for the user to run in that Terminal. Do not change credential storage or authentication settings to bypass this. Revoke this task's grant afterward. Do not export `gh` tokens or use raw SSH. An interrupted push requires checking the remote ref before retrying.

## Remote delivery

The application owns delivery. After an explicit Connect and timed passkey approval, the broker verifies the selected host/account/directory, opens its scoped SSH transport, signs the fixed lease and approved manifest, compares the remote revision, uploads verified bytes if needed, and starts native T3 there. No agent-issued `--grant` wrapper belongs in normal file or shell operations. No remote source checkout, package install, or compiler is allowed.

Do not preemptively update the fleet. Existing enrollment is reused; first enrollment is an administrator setup action with pinned hub public key, trusted supervisor, OS service, runtime identity, and recovery path. Do not silently treat plain upstream SSH remotes as broker-managed. Every configured managed environment must reject access while locked and require its own timed approval after expiry. Polling, reconnects, deployment, and browser reloads must never create or extend a grant.

For an authorized remote smoke test use the installed broker and the `jump` workflow: exact approval link, automatic bounded wait, status recheck, identity verification, then scoped testing. Revoke task grants afterward. `mbp` is the existing selected test target; this does not authorize authentication changes or writes to other hosts.

## Finish

Report stable tag, fork commit/branch, checks actually run, artifact coverage, deployment/publication status, and any remaining concrete dependency. Keep credentials and internal pairing tokens out of model context and logs. Synchronize this skill into Codex and Claude using the installed sync-agent-context skill; snapshot both destinations before writing and preserve unrelated baseline entries.
