# Serspace fork automation

The fork keeps upstream workflows for easier syncing, but Cloudflare-specific jobs run only
when `github.repository == 'cloudflare/cloudflare-os'`. Skipped jobs are intentional, not
passing substitutes for checks that actually ran.

| Workflows | Fork policy |
| --- | --- |
| `ci.yml` | Keep lint, build, types and tests on pull requests and pushes to `serspace` and `main`. |
| `label-pr.yml` | Keep generic changed-area labels. |
| `github-contract.yml` | Keep optional contract tests; actual tests require an explicitly configured disposable repository and token. |
| `cla.yml`, `contribution-policy.yml` | Upstream-only contributor administration. |
| `bonk.yml`, `bonk-pr.yml` | Upstream-only review service and gateway configuration. |
| `preview.yml` | Upstream-only deployment infrastructure. |
| `workshop-evals.yml`, `workshop-evals-pr.yml` | Upstream-only paid inference and reporting. |

## Upstream sync checklist

### Local merge rehearsal

From a checkout of this fork, using Node 24.19 or newer and Git:

```sh
node scripts/sync-upstream.ts
```

This fetches `origin` branch `serspace` and `upstream` branch `main`, prints their
exact commits, and checks the merge in a disposable detached worktree under
`.worktrees/`. It preserves your current branch, staged/unstaged changes, and
untracked files. It never pushes, opens a PR, changes the deployment submodule
pin, or moves local `serspace`. Fetching updates remote-tracking refs and Git
objects; this is not a fully read-only operation.

Verify `origin` points to `serspace-org/cloudflare-os` and `upstream` points to
`cloudflare/cloudflare-os` before running. The script uses those configured
remotes, not hardcoded GitHub URLs. Use `--repo PATH` to target another checkout,
including the deployment's `cloudflare-os` submodule. `--no-fetch` rehearses
existing remote-tracking commits without network access; those refs may be stale.

To retain a successful merge for review and verification:

```sh
node scripts/sync-upstream.ts --prepare
```

The script prints the new `sync/cloudflare-<fork SHA>-<upstream SHA>` branch,
worktree path, and merge commit. It refuses to overwrite an existing candidate.
Hooks and commit signing are disabled only for its merge/commit commands; a
prepared commit uses your configured Git identity. No upstream application code
is run during the rehearsal. Review before installing or testing upstream code.

Exit codes: **0** = up to date or conflict-free; **1** = merge conflicts (file
names printed); **2** = configuration/Git/usage error. Normal completion removes
the disposable worktree even on conflicts. A killed process can leave a
`sync-check-*` directory; inspect it before removing that worktree with Git.

**Conflict-free is not verified compatibility.** In the prepared worktree,
install dependencies with `pnpm install`, review the merged diff, and run the
checklist below before pushing or requesting review. Publishing and merging
remain separate operator actions. Remove a retained candidate with
`git worktree remove <printed-path>` when no longer needed; the branch remains
until explicitly deleted. Do not force-remove a worktree with work to preserve.

Regression tests (no network or GitHub credentials needed):

```sh
node --test scripts/sync-upstream.test.ts
```

### Verification before accepting a sync

1. Start from the current remote `serspace` and merge upstream `main`, preserving ancestry.
2. Preserve every upstream-only job's repository guard, including cleanup and bypass jobs.
3. Classify new workflows in `scripts/fork-workflows.test.ts`. New deployment, review or paid
   evaluation automation must not run in the fork without an explicit configuration decision.
4. Run `node --test scripts/fork-workflows.test.ts`, `pnpm lint`, and workspace tests. Do not
   disable quality checks or weaken assertions to obtain a green sync.
5. Review GitHub CI results and keep validation failures visible in the PR.

The regression test runs in the normal scripts test task and therefore in GitHub's quality CI.
It detects unclassified workflows, missing job guards and top-level ORs that bypass the guards.
This prevents accidental reintroduction from passing CI; it cannot prevent an administrator
from deliberately bypassing CI or changing workflow settings.

## Initial rollout and repository settings

`pull_request_target` jobs use trusted base-branch code. Guards added in a pull request do not
change those jobs until the guards reach the base branch. The existing CLA and contribution
policy can therefore still run on the PR introducing this policy. Comment-triggered workflows
also need the policy on the default branch before it governs new comment events.

A repository administrator can disable the upstream-only workflows in the Actions UI during
rollout. This repository setting is also a useful second layer against upstream changes; it is
not controlled by these committed files. Cancel obsolete in-progress runs separately if needed.

On 2026-10-28, all seven upstream-only workflows listed above were disabled in
`serspace-org/cloudflare-os` repository settings. CI, changed-area labels and the optional GitHub
contract workflow remained enabled. The inspected default-branch ruleset required a pull request
but no status checks, so no check requirements needed removal. Re-check settings if rules change.

Review rulesets and branch protection for `serspace`: retain quality CI requirements, and remove
requirements for upstream-only checks such as `CLAssistant` and `bonk` if present. Disabling a
workflow does not remove a required check or erase old failed results. Do not sign agreements
on behalf of upstream contributors or fabricate passing checks to clear old results.
