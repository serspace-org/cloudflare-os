import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./sync-upstream.ts", import.meta.url));

function fixture(t: { after: (fn: () => void) => void }) {
  const repo = mkdtempSync(join(tmpdir(), "os-sync-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "serspace");
  git("config", "user.name", "Sync Test");
  git("config", "user.email", "sync-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/serspace", base);
  git("update-ref", "refs/remotes/upstream/main", base);
  const run = (...args: string[]) => spawnSync(process.execPath, [script, "--repo", repo, ...args], { encoding: "utf8" });
  const diverge = (conflict = false) => {
    writeFileSync(join(repo, conflict ? "shared.txt" : "fork.txt"), "fork\n");
    git("add", "."); git("commit", "-m", "fork customization");
    const fork = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/serspace", fork);
    git("switch", "-c", "upstream-source", base);
    writeFileSync(join(repo, conflict ? "shared.txt" : "upstream.txt"), "upstream\n");
    git("add", "."); git("commit", "-m", "upstream change");
    const upstream = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/upstream/main", upstream);
    git("switch", "serspace");
    return { fork, upstream };
  };
  return { repo, git, run, diverge, base };
}

test("up-to-date is a no-op", (t) => {
  const { run, git, base } = fixture(t);
  const result = run("--no-fetch");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Already up to date/);
  assert.equal(git("rev-parse", "HEAD"), base);
  assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("check preserves dirty checkout and removes temporary worktree", (t) => {
  const { repo, run, git, diverge } = fixture(t);
  const { fork } = diverge();
  writeFileSync(join(repo, "shared.txt"), "uncommitted\n");
  writeFileSync(join(repo, "untracked.txt"), "keep\n");
  const status = git("status", "--porcelain");
  const branches = git("branch", "--format=%(refname)");
  const result = run("--no-fetch");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Clean rebase/);
  assert.equal(git("rev-parse", "HEAD"), fork);
  assert.equal(git("status", "--porcelain"), status);
  assert.equal(git("branch", "--format=%(refname)"), branches);
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "uncommitted\n");
  assert.deepEqual(readdirSync(join(repo, ".worktrees")), []);
});

test("conflicts fail clearly without changing branches or leaving worktrees", (t) => {
  const { repo, run, git, diverge } = fixture(t);
  const { fork } = diverge(true);
  const result = run("--no-fetch", "--prepare");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Rebase conflicts/);
  assert.match(result.stderr, /Stopped at: \w+ fork customization/);
  assert.match(result.stderr, /^shared.txt$/m);
  assert.equal(git("rev-parse", "HEAD"), fork);
  assert.equal(git("status", "--porcelain"), "");
  assert.deepEqual(readdirSync(join(repo, ".worktrees")), []);
});

test("prepare replays the stack onto upstream and refuses to overwrite a candidate", (t) => {
  const { repo, run, git, diverge } = fixture(t);
  const { fork, upstream } = diverge();
  const result = run("--no-fetch", "--prepare");
  assert.equal(result.status, 0, result.stderr);
  const branch = result.stdout.match(/Prepared branch: (.+)/)?.[1];
  assert.ok(branch);
  // The fork commit is replayed directly onto upstream, not joined to it by a merge.
  assert.equal(git("rev-parse", `${branch}^1`), upstream);
  assert.equal(spawnSync("git", ["-C", repo, "rev-parse", "--verify", `${branch}^2`]).status !== 0, true);
  assert.equal(git("log", "--format=%s", `${upstream}..${branch}`), "fork customization");
  assert.notEqual(git("rev-parse", branch), fork);
  assert.equal(git("rev-parse", "HEAD"), fork);
  const tree = result.stdout.match(/Worktree: (.+)/)?.[1];
  assert.ok(tree);
  assert.equal(readFileSync(join(tree, "fork.txt"), "utf8"), "fork\n");
  assert.equal(readFileSync(join(tree, "upstream.txt"), "utf8"), "upstream\n");
  assert.equal(run("--no-fetch", "--prepare").status, 2);
  assert.equal(readdirSync(join(repo, ".worktrees")).length, 1);
});

test("default fetches the configured remotes, not stale tracking refs", (t) => {
  const { repo, run, git, diverge, base } = fixture(t);
  const { upstream } = diverge();
  git("remote", "add", "origin", repo);
  git("remote", "add", "upstream", repo);
  git("branch", "main", upstream);
  git("update-ref", "refs/remotes/upstream/main", base);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Clean rebase/);
  assert.equal(git("rev-parse", "refs/remotes/upstream/main"), upstream);
});

test("missing refs or failed fetch are errors, not an up-to-date result", (t) => {
  const { run, git } = fixture(t);
  assert.equal(run().status, 2);
  git("update-ref", "-d", "refs/remotes/upstream/main");
  assert.equal(run("--no-fetch").status, 2);
});

test("checkout hooks cannot run or leave stale registrations in either mode", (t) => {
  const { repo, run, git, diverge } = fixture(t);
  diverge();
  const hooks = join(repo, "configured-hooks");
  mkdirSync(hooks);
  const marker = join(hooks, "executed");
  const hook = join(hooks, "post-checkout");
  writeFileSync(hook, '#!/bin/sh\ntouch "$(dirname "$0")/executed"\nexit 1\n');
  chmodSync(hook, 0o755);
  git("config", "core.hooksPath", hooks);
  for (const args of [["--no-fetch"], ["--no-fetch", "--prepare"]]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false, "configured checkout hook must not execute");
    const expectedWorktrees = args.includes("--prepare") ? 2 : 1;
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, expectedWorktrees);
    assert.equal(readdirSync(join(repo, ".worktrees")).length, expectedWorktrees - 1);
  }
});

test("autosquash folds a fixup into its topic commit instead of growing the stack", (t) => {
  const { repo, run, git, diverge } = fixture(t);
  diverge();
  writeFileSync(join(repo, "fork.txt"), "fork, corrected\n");
  git("add", ".");
  git("commit", "--fixup", "HEAD");
  git("update-ref", "refs/remotes/origin/serspace", git("rev-parse", "HEAD"));
  const result = run("--no-fetch", "--prepare");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 commits before, 1 after autosquash/);
  const branch = result.stdout.match(/Prepared branch: (.+)/)?.[1];
  assert.ok(branch);
  assert.equal(git("log", "--format=%s", `refs/remotes/upstream/main..${branch}`), "fork customization");
  const tree = result.stdout.match(/Worktree: (.+)/)?.[1];
  assert.ok(tree);
  assert.equal(readFileSync(join(tree, "fork.txt"), "utf8"), "fork, corrected\n");
});

// --pr needs a remote it can push to and a slug it can read. Point origin's fetch URL at a
// GitHub-style address for the slug and its push URL at a local bare repository.
function publishable(repo: string, git: (...args: string[]) => string, t: { after: (fn: () => void) => void }) {
  const bare = mkdtempSync(join(tmpdir(), "os-sync-origin-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  spawnSync("git", ["init", "--bare", "-b", "serspace", bare]);
  git("remote", "add", "origin", "git@github.com:serspace-org/cloudflare-os.git");
  git("config", "remote.origin.pushurl", bare);
  const bin = mkdtempSync(join(tmpdir(), "os-sync-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const calls = join(bin, "calls");
  const stub = (body: string) => {
    writeFileSync(join(bin, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$1 $2 $3 $4 $5 $6 $7 $8" >> ${JSON.stringify(calls)}\n${body}\n`);
    chmodSync(join(bin, "gh"), 0o755);
  };
  const recorded = () => (existsSync(calls) ? readFileSync(calls, "utf8").trimEnd().split("\n") : []);
  const path = { PATH: `${bin}:${process.env.PATH ?? ""}` };
  return { bare, stub, recorded, path };
}

const ghStub = (prListUrl = "") => `
case "$*" in
  *"auth status"*) exit 0 ;;
  *"pr list"*) printf '%s' ${JSON.stringify(prListUrl)}; exit 0 ;;
  *"pr create"*) echo "https://github.com/serspace-org/cloudflare-os/pull/99"; exit 0 ;;
esac
exit 1`;

test("base and upstream overrides exercise the rebase without touching the real refs", (t) => {
  const { run, git, diverge, base } = fixture(t);
  const { fork, upstream } = diverge();
  // Pretend the fork tip is the shared base: the stack is then empty and already on upstream.
  const stale = run("--no-fetch", "--base", base, "--upstream", upstream);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /rehearsal override; cannot be published/);
  const result = run("--no-fetch", "--base", fork, "--upstream", upstream);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Clean rebase/);
  assert.match(result.stdout, /fork customization/);
  assert.equal(git("rev-parse", "refs/remotes/origin/serspace"), fork);
});

test("up-to-date names the overrides that exercise the rebase anyway", (t) => {
  const { run } = fixture(t);
  const result = run("--no-fetch");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--base\/--upstream/);
});

test("pr publishes the candidate and targets the fork explicitly", (t) => {
  const { repo, git, diverge } = fixture(t);
  const { upstream } = diverge();
  const { bare, stub, recorded, path } = publishable(repo, git, t);
  stub(ghStub());
  const result = spawnSync(process.execPath, [script, "--repo", repo, "--no-fetch", "--pr"],
    { encoding: "utf8", env: { ...process.env, ...path } });
  assert.equal(result.status, 0, result.stderr);
  const branch = result.stdout.match(/Prepared branch: (.+)/)?.[1];
  assert.ok(branch);
  // Pushed only the candidate; serspace on the remote is untouched.
  const remote = spawnSync("git", ["-C", bare, "branch", "--format=%(refname:short)"], { encoding: "utf8" }).stdout;
  assert.deepEqual(remote.trim().split("\n"), [branch]);
  assert.equal(spawnSync("git", ["-C", bare, "rev-parse", `${branch}^1`], { encoding: "utf8" }).stdout.trim(), upstream);
  const calls = recorded();
  assert.match(calls[0], /^auth status\b/);
  // Every gh call pins the fork: with an upstream remote and no default, gh would guess.
  for (const call of calls.slice(1)) assert.match(call, /^--repo serspace-org\/cloudflare-os /);
  assert.ok(calls.some((c) => c.includes(`pr create --base serspace --head ${branch}`)), calls.join(" | "));
  assert.match(result.stdout, /Opened: https:\/\/github.com\/serspace-org\/cloudflare-os\/pull\/99/);
  assert.match(result.stdout, /Do not merge it/);
});

test("pr reuses an open pull request instead of failing on a second run", (t) => {
  const { repo, git, diverge } = fixture(t);
  diverge();
  const { stub, recorded, path } = publishable(repo, git, t);
  stub(ghStub("https://github.com/serspace-org/cloudflare-os/pull/7"));
  const result = spawnSync(process.execPath, [script, "--repo", repo, "--no-fetch", "--pr"],
    { encoding: "utf8", env: { ...process.env, ...path } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already open, updated by the push: .*\/pull\/7/);
  assert.equal(recorded().some((c) => c.includes("pr create")), false);
});

test("pr refuses rehearsal overrides, unusable gh and an unreadable origin, before rebasing", (t) => {
  const { repo, git, diverge, base } = fixture(t);
  const { upstream } = diverge();
  const { stub, path } = publishable(repo, git, t);

  stub(ghStub());
  const override = spawnSync(process.execPath,
    [script, "--repo", repo, "--no-fetch", "--pr", "--base", base, "--upstream", upstream],
    { encoding: "utf8", env: { ...process.env, ...path } });
  assert.equal(override.status, 2);
  assert.match(override.stderr, /cannot be combined with --base\/--upstream/);

  stub("exit 1");
  const unauthenticated = spawnSync(process.execPath, [script, "--repo", repo, "--no-fetch", "--pr"],
    { encoding: "utf8", env: { ...process.env, ...path } });
  assert.equal(unauthenticated.status, 2);
  assert.match(unauthenticated.stderr, /needs an authenticated GitHub CLI/);

  stub(ghStub());
  git("remote", "set-url", "origin", "/srv/git/not-a-github-remote");
  const unreadable = spawnSync(process.execPath, [script, "--repo", repo, "--no-fetch", "--pr"],
    { encoding: "utf8", env: { ...process.env, ...path } });
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /Cannot read an owner\/repo/);

  // Every refusal happens before any worktree is created.
  assert.equal(existsSync(join(repo, ".worktrees")), false);
});

test("pr pushes nothing when the rebase conflicts", (t) => {
  const { repo, git, diverge } = fixture(t);
  diverge(true);
  const { bare, stub, recorded, path } = publishable(repo, git, t);
  stub(ghStub());
  const result = spawnSync(process.execPath, [script, "--repo", repo, "--no-fetch", "--pr"],
    { encoding: "utf8", env: { ...process.env, ...path } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /nothing pushed and no branch kept/);
  assert.equal(spawnSync("git", ["-C", bare, "branch"], { encoding: "utf8" }).stdout.trim(), "");
  assert.deepEqual(recorded().map((c) => c.trim()), ["auth status"]);
  assert.deepEqual(readdirSync(join(repo, ".worktrees")), []);
});
