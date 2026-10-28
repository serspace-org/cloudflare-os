import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

// Local only: never pushes, opens PRs, or moves the fork's base branch.
function main() {
  const { values } = parseArgs({ options: {
    repo: { type: "string", default: "." },
    prepare: { type: "boolean", default: false },
    "no-fetch": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("Usage: node scripts/sync-upstream.ts [--repo PATH] [--prepare] [--no-fetch]\n" +
      "Check origin/serspace + upstream/main in an isolated worktree.\n" +
      "--prepare keeps a local merge branch/worktree on success. Never pushes.\n" +
      "--no-fetch uses existing remote-tracking refs (possibly stale).");
    return;
  }
  const repo = resolve(values.repo);
  const git = (cwd: string, args: string[], allowed = [0]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
    });
    if (result.error) throw result.error;
    if (!allowed.includes(result.status ?? -1)) {
      throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`);
    }
    return { output: result.stdout.trim(), status: result.status };
  };
  const root = git(repo, ["rev-parse", "--show-toplevel"]).output;
  console.log("Target: origin/serspace <- upstream/main (local merge only)");
  if (!values["no-fetch"]) {
    git(root, ["fetch", "--no-tags", "origin", "+refs/heads/serspace:refs/remotes/origin/serspace"]);
    git(root, ["fetch", "--no-tags", "upstream", "+refs/heads/main:refs/remotes/upstream/main"]);
  }
  const base = git(root, ["rev-parse", "--verify", "refs/remotes/origin/serspace^{commit}"]).output;
  const upstream = git(root, ["rev-parse", "--verify", "refs/remotes/upstream/main^{commit}"]).output;
  console.log(`Fork: ${base}\nUpstream: ${upstream}`);
  if (git(root, ["merge-base", "--is-ancestor", upstream, base], [0, 1]).status === 0) {
    console.log("Already up to date; no worktree or branch created.");
    return;
  }
  // A missing common ancestor is an error, not permission to join unrelated histories.
  git(root, ["merge-base", base, upstream]);
  const branch = `sync/cloudflare-${base.slice(0, 8)}-${upstream.slice(0, 8)}`;
  const worktrees = join(root, ".worktrees");
  const destination = join(worktrees, branch.replace("/", "-"));
  if (values.prepare && (existsSync(destination) ||
    git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], [0, 1]).status === 0)) {
    throw new Error(`Refusing to overwrite existing branch/worktree: ${branch}, ${destination}`);
  }
  mkdirSync(worktrees, { recursive: true });
  const scratch = mkdtempSync(join(worktrees, "sync-check-"));
  const hooks = join(scratch, "empty-hooks");
  mkdirSync(hooks);
  const tree = join(scratch, "tree");
  let added = false;
  try {
    git(root, ["worktree", "add", "--detach", tree, base]);
    added = true;
    // Do not run repository hooks or prompt for signing during a merge check.
    const merge = git(tree, ["-c", `core.hooksPath=${hooks}`, "merge", "--no-commit", "--no-ff", upstream], [0, 1]);
    if (merge.status !== 0) {
      const conflicts = git(tree, ["diff", "--name-only", "--diff-filter=U"]).output;
      if (!conflicts) throw new Error(`Merge failed without file conflicts:\n${merge.output}`);
      console.error(`Merge conflicts; base branch unchanged:\n${conflicts}`);
      process.exitCode = 1;
      return;
    }
    console.log("Conflict-free merge. This does not establish build or test compatibility.");
    if (!values.prepare) {
      console.log("Check only; no merge commit or branch kept. Use --prepare to keep a local candidate.");
      return;
    }
    git(tree, ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "commit", "-m", "Merge cloudflare/cloudflare-os main into Serspace fork"]);
    const head = git(tree, ["rev-parse", "HEAD"]).output;
    // Create the named branch only after a successful merge commit.
    git(tree, ["switch", "-c", branch]);
    git(root, ["worktree", "move", tree, destination]);
    added = false;
    console.log(`Prepared branch: ${branch}\nWorktree: ${destination}\nMerge commit: ${head}`);
    console.log("Next: review the diff; install dependencies; run the checks in docs/fork-automation.md. Nothing pushed.");
  } finally {
    if (added) git(root, ["worktree", "remove", "--force", tree]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
