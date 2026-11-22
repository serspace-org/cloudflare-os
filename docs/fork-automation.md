# Serspace fork automation

The fork keeps upstream workflows for easier syncing, but Cloudflare-specific jobs run only
when `github.repository == 'cloudflare/cloudflare-os'`. Skipped jobs are intentional, not
passing substitutes for checks that actually ran.

| Workflows | Fork policy |
| --- | --- |
| `ci.yml` | Keep lint, build, types and tests on pull requests and pushes to `serspace` and `main`. |
| `label-pr.yml` | Keep generic changed-area labels. |
| `github-contract.yml` | Keep optional contract tests; actual tests require an explicitly configured disposable repository and token. |
| `contribution-policy.yml` | Upstream-only contributor administration. |
| `bonk.yml`, `bonk-pr.yml` | Upstream-only review service and gateway configuration. |
| `preview.yml` | Upstream-only deployment infrastructure. |
| `workshop-evals.yml`, `workshop-evals-pr.yml` | Upstream-only paid inference and reporting. |
| `sync-upstream.yml` | Fork-only triggered rebase of the serspace patch stack onto upstream main. |

## The patch-stack invariant

`serspace` is always `upstream/main` plus one commit per maintained feature, replayed by rebase:

> Never merge upstream into the fork — always rebase the stack onto it. Never merge a pull
> request into `serspace` — always squash it into a single commit.

Both halves matter. A merge commit from an upstream sync interleaves fork and upstream work, and
a merge commit from a fork pull request means the next sync has to replay a merge. Either one
turns the stack into a history where "our changes" and "Cloudflare's changes" can no longer be
separated, and every later sync inherits the tangle. Everything in this document — the workflow,
the rehearsal script, and the repository settings below — exists to keep that from happening.

Verify the invariant at any time:

```sh
git fetch upstream && git merge-base --is-ancestor upstream/main origin/serspace &&
  git rev-list --merges upstream/main..origin/serspace
```

The first command must succeed and the second must print nothing.

## Triggered sync (sync-upstream.yml)

The **Sync upstream** workflow (Actions → Sync upstream → Run workflow) performs the rebase in CI:

- **mode=check** (default): rebases the stack (with `--autosquash`, so `fixup!` commits fold into
  their topic commits), pushes the result as a `sync/cloudflare-*` branch, and dispatches CI on it.
  `serspace` is untouched. When that CI is green, re-run with mode=apply.
- **mode=apply**: repeats the rebase and force-pushes `serspace` (with a lease on the commit it
  started from, so a concurrent push aborts it), then dispatches CI on `serspace`. Everyone must
  then `git fetch && git reset --hard origin/serspace`.

The workflow never resolves conflicts: a conflicted rebase fails with the stopped commit and the
conflicted files in the job summary. Resolve locally — `git fetch upstream && git rebase -i
--autosquash upstream/main`, fix inside the topic commit the rebase stops on so the resolution
becomes part of that patch, run the affected tests, and `git push --force-with-lease origin
serspace`. Keep `rerere` out of rebases (`-c rerere.enabled=false`): stale recorded resolutions
from old merge-based syncs can silently revert fork changes.

## Upstream sync checklist

### Local setup

Configure the checkout so routine commands cannot produce a merge:

```sh
git config pull.rebase true
git config rebase.autosquash true
git config rebase.updateRefs true
git config fetch.prune true
```

Without `pull.rebase`, a single `git pull` on `serspace` after a sync force-push creates a merge
commit and silently breaks the invariant. `rebase.autosquash` makes `fixup!` commits fold into
their topic commit, which is how a fix to an existing fork feature stays one commit.

### Local rebase rehearsal

From a checkout of this fork, using Node 24.19 or newer and Git:

```sh
pnpm sync:upstream
```

This fetches `origin` branch `serspace` and `upstream` branch `main`, prints their
exact commits, and replays the stack onto upstream in a disposable detached
worktree under `.worktrees/` — the same `rebase -i --autosquash` the workflow
runs, so a local check and a CI sync produce the same history. It preserves your
current branch, staged/unstaged changes, and untracked files. Without `--pr` it
never pushes, opens a pull request, changes the deployment submodule pin, or
moves local `serspace`. Fetching updates remote-tracking refs and Git objects;
this is not a fully read-only operation.

`--help` lists every flag. `pnpm sync:upstream --pr` is the full local path from a
check to a reviewable candidate; `--base`/`--upstream` exercise the rebase against
arbitrary commits when there is nothing to sync.

Verify `origin` points to `serspace-org/cloudflare-os` and `upstream` points to
`cloudflare/cloudflare-os` before running. The script uses those configured
remotes, not hardcoded GitHub URLs. Use `--repo PATH` to target another checkout,
including the deployment's `cloudflare-os` submodule. `--no-fetch` rehearses
existing remote-tracking commits without network access; those refs may be stale.

To retain a successful rebase for review and verification:

```sh
pnpm sync:upstream --prepare
```

The script prints the new `sync/cloudflare-<fork SHA>-<upstream SHA>` branch — the
same name the workflow uses for the same pair of commits — the worktree path, the
rebased stack head, and the stack itself, with the commit count before and after
autosquash so a folded `fixup!` is visible rather than silent. It refuses to
overwrite an existing candidate. Hooks are disabled for worktree creation, branch
switching and the rebase, `rerere` is disabled, and commit signing is disabled for
the replayed commits, which keep their original authors and take your configured
Git identity as committer. No upstream application code is run during the
rehearsal. Review before installing or testing upstream code.

Stale `rerere` resolutions are a real hazard here: a resolution recorded during the
fork's old merge-based syncs can silently revert fork changes when replayed, so the
script and the workflow both run with `rerere.enabled=false`. Keep it that way.

### Publishing a candidate (`--pr`)

```sh
pnpm sync:upstream --pr
```

On a clean rebase this pushes the `sync/cloudflare-*` branch to `origin` and opens a
pull request against `serspace`, so the candidate gets review and CI from a local
run. It implies `--prepare`, so the worktree is kept for investigation. A second run
on the same pair of commits force-pushes the branch and reports the open pull
request rather than failing. Needs an authenticated `gh`.

**That pull request must not be merged.** Merging it would put a merge commit on
`serspace`. It is a review and CI artifact; promote a green candidate by force-push —
Actions → **Sync upstream** → `mode=apply`, or
`git push --force-with-lease=serspace:<fork SHA> origin <branch>:serspace` — then close
it. The pull request body repeats this, with the exact command filled in.

Guardrails, all checked before any rebase work happens:

- The candidate branch name is always `sync/cloudflare-*`; the script cannot address
  `serspace`, and the only ref it ever pushes is that candidate.
- Every `gh` call pins `--repo` to `origin`'s owner and repository. This matters: with
  an `upstream` remote present and no default repository set, `gh` picks a repository
  itself and can target `cloudflare/cloudflare-os`.
- `--pr` refuses to combine with `--base`/`--upstream`, so a rehearsal of arbitrary
  commits can never be published as a real sync.
- A conflicted rebase pushes nothing and keeps no branch.

### Exercising the rebase with nothing to sync

When `serspace` is already on top of `upstream/main` the script reports that and stops,
which leaves nothing to test. `--base` and `--upstream` rehearse any two commits:

```sh
# Replay the current stack over the last 25 upstream commits.
git branch old-fork upstream/main~25
git switch old-fork && git cherry-pick origin/serspace~7..origin/serspace && git switch -
pnpm sync:upstream --no-fetch --base old-fork --upstream upstream/main --prepare
```

The prepared candidate's tree should be identical to `origin/serspace`
(`git diff --quiet <stack head> origin/serspace`), its oldest commit's parent should be
`upstream/main`, and `git rev-list --merges upstream/main..<stack head>` should be empty.
Overrides print a `rehearsal override` banner, skip fetching, and cannot be published.
Delete the branch and worktree afterwards.

Options pass directly through the pnpm command, for example
`pnpm sync:upstream --no-fetch` or `pnpm sync:upstream --repo PATH`.
The underlying `node scripts/sync-upstream.ts` entry point remains available
without installing dependencies. In a deployment checkout, after its submodule
pin includes this script, use `pnpm --dir cloudflare-os sync:upstream`.

Exit codes: **0** = up to date or clean rebase; **1** = rebase conflicts (the
stopped commit and conflicted file names printed); **2** = configuration/Git/usage
error. A conflicted rehearsal aborts the rebase and removes the disposable
worktree; resolve conflicts in your own checkout, inside the topic commit the
rebase stops on, so the resolution becomes part of that patch. A killed process
can leave a `sync-check-*` directory; inspect it before removing that worktree
with Git.

**A clean rebase is not verified compatibility.** In the prepared worktree,
install dependencies with `pnpm install`, review the rebased diff, and run the
checklist below before promoting a candidate. Publishing a candidate and promoting
it to `serspace` remain separate operator actions. Remove a retained candidate with
`git worktree remove <printed-path>` when no longer needed; the branch remains
until explicitly deleted. Do not force-remove a worktree with work to preserve.

Regression tests (no network or GitHub credentials needed):

```sh
node --test scripts/sync-upstream.test.ts
```

### Verification before accepting a sync

1. Start from the current remote `serspace` and rebase it onto upstream `main`. The result must
   have `upstream/main` as an ancestor and contain no merge commits.
2. Preserve every upstream-only job's repository guard, including cleanup and bypass jobs.
3. Classify new workflows in `scripts/fork-workflows.test.ts`. New deployment, review or paid
   evaluation automation must not run in the fork without an explicit configuration decision.
4. Run `node --test scripts/fork-workflows.test.ts`, `pnpm lint`, and workspace tests. Do not
   disable quality checks or weaken assertions to obtain a green sync.
5. Review GitHub CI results and keep validation failures visible in the PR.

The regression test runs in the normal scripts test task and therefore in GitHub's quality CI.
It detects unclassified workflows, missing job guards and top-level ORs that bypass the guards.
It reads job-level `if:` conditions only — not `on:` triggers or step conditions — so a guarded
job that gains a side effect in a step is the reviewer's problem, not the test's. This prevents
accidental reintroduction from passing CI; it cannot prevent an administrator from deliberately
bypassing CI or changing workflow settings.

## Repository settings

A guard in a committed file is the first layer. Disabling the upstream-only workflows in the
Actions UI is the second, and it is not controlled by these files — it also holds when an
upstream change rewrites a guard. Keep both.

A `pull_request_target` job runs the trusted base-branch revision, so a guard added in a pull
request does not govern that pull request's own run; it takes effect once it reaches the base
branch. The same applies to comment-triggered workflows and new comment events.

Verified on 2026-11-21 in `serspace-org/cloudflare-os`:

- Six upstream-only workflows — `contribution-policy.yml`, `bonk.yml`, `bonk-pr.yml`,
  `preview.yml`, `workshop-evals.yml`, `workshop-evals-pr.yml` — are `disabled_manually`.
  `cla.yml` is no longer one of them: Cloudflare deleted the CLA Assistant workflow upstream in
  `e08850f7` (#1172) because contributors are no longer asked to sign the Cloudflare CLA.
- `ci.yml`, `label-pr.yml`, `github-contract.yml` and `sync-upstream.yml` are active.
- The default branch is `serspace`, and `main` is a clean ancestor of `upstream/main` — a stale
  mirror, with nothing of its own.
- The `Primary` ruleset on the default branch carries a deletion rule and nothing else. It does
  **not** require linear history, a pull request, or any status check. The settings below are
  therefore the rule everyone remembers, not a rule the repository enforces; #36 was merged into
  `serspace` as a merge commit for exactly that reason.

Disabling a workflow does not remove a required check or erase old failed results. If a ruleset
ever requires an upstream-only check such as `bonk`, remove the requirement rather than trying
to satisfy it. Do not fabricate passing checks to clear old results.

### Settings the patch-stack invariant depends on

These are repository settings, not committed files, so nothing in this repository can enforce
them. They are the mechanical half of the invariant above; without them the rule depends on
everyone remembering it. As of 2026-11-21 only the first two are in place — the ruleset work
below is outstanding.

- **Default branch `serspace`.** It is where fork work belongs and what pull requests should
  target by default. A stale `main` left as the default sends new pull requests at a branch
  that is behind upstream and whose history is merge-shaped.
- **`main` is not a fork branch.** Either delete it or keep it as a pure mirror of
  `cloudflare/cloudflare-os` main that is never merged into anything.
- **Merge commits disabled** for pull requests — squash only, so each fork feature lands as one
  commit. Rebase merging is also acceptable for a deliberately multi-commit feature.
- **Linear history required on `serspace`**, which makes a merge commit on the branch impossible
  rather than merely discouraged. It is compatible with the sync workflow, whose `mode=apply`
  step force-pushes a linear rebased stack. Add it to the `Primary` ruleset alongside the
  existing deletion rule, together with the `lint` and `test` checks from `ci.yml`.
- **Force pushes allowed on `serspace`** for the actor the sync workflow runs as, and for fork
  maintainers resolving a conflicted stack locally. The workflow always pushes with a lease, so
  a concurrent push aborts the sync instead of discarding it.

A force-push to `serspace` rewrites commits everyone has. After any `mode=apply` sync, every
checkout must `git fetch && git reset --hard origin/serspace`; a `git pull` there merges the old
stack back in, which is what `pull.rebase true` above prevents.
