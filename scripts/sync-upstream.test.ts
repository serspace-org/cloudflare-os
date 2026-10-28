import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
  assert.match(result.stdout, /Conflict-free/);
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
  assert.match(result.stderr, /Merge conflicts.*\nshared.txt/);
  assert.equal(git("rev-parse", "HEAD"), fork);
  assert.equal(git("status", "--porcelain"), "");
  assert.deepEqual(readdirSync(join(repo, ".worktrees")), []);
});

test("prepare keeps both histories and refuses to overwrite a candidate", (t) => {
  const { repo, run, git, diverge } = fixture(t);
  const { fork, upstream } = diverge();
  const result = run("--no-fetch", "--prepare");
  assert.equal(result.status, 0, result.stderr);
  const branch = result.stdout.match(/Prepared branch: (.+)/)?.[1];
  assert.ok(branch);
  assert.equal(git("rev-parse", `${branch}^1`), fork);
  assert.equal(git("rev-parse", `${branch}^2`), upstream);
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
  assert.match(result.stdout, /Conflict-free/);
  assert.equal(git("rev-parse", "refs/remotes/upstream/main"), upstream);
});

test("missing refs or failed fetch are errors, not an up-to-date result", (t) => {
  const { run, git } = fixture(t);
  assert.equal(run().status, 2);
  git("update-ref", "-d", "refs/remotes/upstream/main");
  assert.equal(run("--no-fetch").status, 2);
});
