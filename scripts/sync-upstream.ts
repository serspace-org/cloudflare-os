import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

// Local only: never pushes, opens PRs, or moves the fork's base branch.
//
// The fork's history is a patch stack: serspace is upstream/main plus one commit per
// maintained feature. This rehearses the same rebase that .github/workflows/sync-upstream.yml
// runs, so a local check and a CI sync produce the same history. It never merges upstream:
// a merge commit here would interleave fork and upstream work and the next sync would
// have to replay it.
function main() {
  const { values } = parseArgs({ options: {
    repo: { type: "string", default: "." },
    prepare: { type: "boolean", default: false },
    "no-fetch": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("Usage: node scripts/sync-upstream.ts [--repo PATH] [--prepare] [--no-fetch]\n" +
      "Replay the origin/serspace patch stack onto upstream/main in an isolated worktree.\n" +
      "--prepare keeps a local rebased branch/worktree on success. Never pushes.\n" +
      "--no-fetch uses existing remote-tracking refs (possibly stale).");
    return;
  }
  const repo = resolve(values.repo);
  const git = (cwd: string, args: string[], allowed = [0]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        // Replay the stack unattended; the todo list and messages are taken as-is.
        GIT_SEQUENCE_EDITOR: "true",
        GIT_EDITOR: "true",
      },
    });
    if (result.error) throw result.error;
    if (!allowed.includes(result.status ?? -1)) {
      throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`);
    }
    return { output: result.stdout.trim(), status: result.status };
  };
  const root = git(repo, ["rev-parse", "--show-toplevel"]).output;
  console.log("Target: origin/serspace rebased onto upstream/main (local only)");
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
  // A missing common ancestor is an error, not permission to replay onto an unrelated history.
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
  // Do not run repository hooks, prompt for signing, or consult stale rerere resolutions:
  // a recorded resolution from an old merge-based sync can silently revert fork changes.
  const quiet = ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "-c", "rerere.enabled=false"];
  let added = false;
  try {
    git(root, [...quiet, "worktree", "add", "--detach", tree, base]);
    added = true;
    const stackBefore = git(tree, ["rev-list", "--count", `${upstream}..HEAD`]).output;
    const rebase = git(tree, [...quiet, "rebase", "-i", "--autosquash", upstream], [0, 1]);
    if (rebase.status !== 0) {
      const conflicts = git(tree, ["diff", "--name-only", "--diff-filter=U"]).output;
      const stopped = git(tree, ["log", "-1", "--format=%h %s", "REBASE_HEAD"], [0, 128]).output;
      git(tree, [...quiet, "rebase", "--abort"], [0, 1, 128]);
      if (!conflicts) throw new Error(`Rebase failed without file conflicts:\n${rebase.output}`);
      console.error(`Rebase conflicts; base branch unchanged.\nStopped at: ${stopped || "unknown"}\n${conflicts}`);
      console.error("Resolve inside the topic commit the rebase stops on, so the fix stays part of that patch.");
      process.exitCode = 1;
      return;
    }
    // The replayed stack must sit directly on upstream, with no merge commits reintroduced.
    git(tree, ["merge-base", "--is-ancestor", upstream, "HEAD"]);
    const merges = git(tree, ["rev-list", "--merges", `${upstream}..HEAD`]).output;
    if (merges) throw new Error(`Rebased stack contains merge commits:\n${merges}`);
    const stack = git(tree, ["log", "--format=%h %s", `${upstream}..HEAD`]).output;
    const stackAfter = git(tree, ["rev-list", "--count", `${upstream}..HEAD`]).output;
    console.log(`Clean rebase. This does not establish build or test compatibility.`);
    console.log(`Stack on upstream (${stackBefore} commits before, ${stackAfter} after autosquash):\n${stack}`);
    if (!values.prepare) {
      console.log("Check only; no branch kept. Use --prepare to keep a local candidate.");
      return;
    }
    const head = git(tree, ["rev-parse", "HEAD"]).output;
    // Create the named branch only after a successful rebase.
    git(tree, [...quiet, "switch", "-c", branch]);
    git(root, ["worktree", "move", tree, destination]);
    added = false;
    console.log(`Prepared branch: ${branch}\nWorktree: ${destination}\nStack head: ${head}`);
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
