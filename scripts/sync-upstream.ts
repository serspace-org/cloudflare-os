import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

// The fork's history is a patch stack: serspace is upstream/main plus one commit per
// maintained feature. This rehearses the same rebase that .github/workflows/sync-upstream.yml
// runs, so a local check and a CI sync produce the same history. It never merges upstream:
// a merge commit here would interleave fork and upstream work and the next sync would
// have to replay it.
//
// It never moves serspace. Without --pr nothing leaves the machine; --pr publishes the
// candidate branch and opens a pull request for review and CI only.

const DEFAULT_BASE = "refs/remotes/origin/serspace";
const DEFAULT_UPSTREAM = "refs/remotes/upstream/main";

// A pull request must target the fork. `gh` with no default repository picks a remote on its
// own, and this repository has an `upstream` remote, so every gh call passes --repo explicitly.
function originSlug(url: string) {
  const match = /^(?:git@[^:]+:|(?:ssh|git|https?):\/\/[^/]+\/)(.+?)(?:\.git)?$/.exec(url.trim());
  if (!match) throw new Error(`Cannot read an owner/repo from origin's URL: ${url}`);
  const slug = match[1];
  if (!/^[^/]+\/[^/]+$/.test(slug)) throw new Error(`Unexpected owner/repo in origin's URL: ${url}`);
  return slug;
}

function main() {
  const { values } = parseArgs({ options: {
    repo: { type: "string", default: "." },
    prepare: { type: "boolean", default: false },
    pr: { type: "boolean", default: false },
    base: { type: "string" },
    upstream: { type: "string" },
    "no-fetch": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("Usage: node scripts/sync-upstream.ts [options]\n" +
      "Replay the origin/serspace patch stack onto upstream/main in an isolated worktree.\n\n" +
      "  --prepare        keep the rebased branch and worktree on success (local only)\n" +
      "  --pr             implies --prepare; on success push the candidate branch and open a\n" +
      "                   pull request for review and CI. Never pushes serspace. Needs gh.\n" +
      "  --base REF       rehearse from REF instead of " + DEFAULT_BASE + "\n" +
      "  --upstream REF   rehearse onto REF instead of " + DEFAULT_UPSTREAM + "\n" +
      "  --no-fetch       use existing remote-tracking refs (possibly stale)\n" +
      "  --repo PATH      operate on another checkout\n\n" +
      "Exit codes: 0 up to date or clean, 1 rebase conflicts, 2 configuration/usage error.");
    return;
  }
  const prepare = values.prepare || values.pr;
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
  const baseRef = values.base ?? DEFAULT_BASE;
  const upstreamRef = values.upstream ?? DEFAULT_UPSTREAM;
  const rehearsal = baseRef !== DEFAULT_BASE || upstreamRef !== DEFAULT_UPSTREAM;

  // Validate everything --pr needs before spending time on a rebase.
  let slug = "";
  if (values.pr) {
    if (rehearsal) {
      throw new Error("--pr publishes a real sync candidate and cannot be combined with " +
        "--base/--upstream overrides, which rehearse arbitrary commits.");
    }
    const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
    if (gh.error || gh.status !== 0) {
      throw new Error("--pr needs an authenticated GitHub CLI. Install gh and run `gh auth login`.\n" +
        `${gh.error ? gh.error.message : gh.stderr + gh.stdout}`.trim());
    }
    slug = originSlug(git(root, ["remote", "get-url", "origin"]).output);
  }

  console.log(`Target: ${baseRef} rebased onto ${upstreamRef}` +
    (rehearsal ? " (rehearsal override; cannot be published)" : ""));
  if (!values["no-fetch"] && !rehearsal) {
    git(root, ["fetch", "--no-tags", "origin", "+refs/heads/serspace:refs/remotes/origin/serspace"]);
    git(root, ["fetch", "--no-tags", "upstream", "+refs/heads/main:refs/remotes/upstream/main"]);
  }
  const base = git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`]).output;
  const upstream = git(root, ["rev-parse", "--verify", `${upstreamRef}^{commit}`]).output;
  console.log(`Fork: ${base}\nUpstream: ${upstream}`);
  if (git(root, ["merge-base", "--is-ancestor", upstream, base], [0, 1]).status === 0) {
    console.log("Already up to date; no worktree or branch created.");
    if (!rehearsal) {
      console.log("To exercise the rebase against earlier commits, pass --base/--upstream, " +
        "for example --base origin/serspace --upstream upstream/main~20.");
    }
    return;
  }
  // A missing common ancestor is an error, not permission to replay onto an unrelated history.
  git(root, ["merge-base", base, upstream]);
  const branch = `sync/cloudflare-${base.slice(0, 8)}-${upstream.slice(0, 8)}`;
  // The candidate is always a sync branch; this script must never be able to move serspace.
  if (!branch.startsWith("sync/cloudflare-")) throw new Error(`Refusing to use branch: ${branch}`);
  const worktrees = join(root, ".worktrees");
  const destination = join(worktrees, branch.replace("/", "-"));
  if (prepare && (existsSync(destination) ||
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
      console.error(`Rebase conflicts; nothing pushed and no branch kept.\nStopped at: ${stopped || "unknown"}\n${conflicts}`);
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
    console.log("Clean rebase. This does not establish build or test compatibility.");
    console.log(`Stack on upstream (${stackBefore} commits before, ${stackAfter} after autosquash):\n${stack}`);
    if (!prepare) {
      console.log("Check only; no branch kept. Use --prepare to keep a local candidate, --pr to publish one.");
      return;
    }
    const head = git(tree, ["rev-parse", "HEAD"]).output;
    // Create the named branch only after a successful rebase.
    git(tree, [...quiet, "switch", "-c", branch]);
    git(root, ["worktree", "move", tree, destination]);
    added = false;
    console.log(`Prepared branch: ${branch}\nWorktree: ${destination}\nStack head: ${head}`);
    if (!values.pr) {
      console.log("Next: review the diff; install dependencies; run the checks in docs/fork-automation.md. Nothing pushed.");
      return;
    }
    git(destination, ["push", "--force", "origin", `HEAD:refs/heads/${branch}`]);
    console.log(`Pushed ${slug} ${branch}.`);
    const gh = (args: string[], allowed = [0]) => {
      const result = spawnSync("gh", ["--repo", slug, ...args], { encoding: "utf8" });
      if (result.error) throw result.error;
      if (!allowed.includes(result.status ?? -1)) {
        throw new Error(`gh ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`);
      }
      return result.stdout.trim();
    };
    const existing = gh(["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[].url"]);
    if (existing) {
      console.log(`Pull request already open, updated by the push: ${existing}`);
      return;
    }
    const url = gh(["pr", "create", "--base", "serspace", "--head", branch,
      "--title", `sync: cloudflare/cloudflare-os main into the serspace stack`,
      "--body", prBody({ base, upstream, branch, stack, stackBefore, stackAfter })]);
    console.log(`Opened: ${url}`);
    console.log("This pull request is for review and CI. Do not merge it: merging would add a merge\n" +
      "commit to serspace. Promote a green candidate with Actions -> Sync upstream -> mode=apply,\n" +
      `or \`git push --force-with-lease=serspace:${base} origin ${branch}:serspace\`, then close it.`);
  } finally {
    if (added) git(root, ["worktree", "remove", "--force", tree]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function prBody(sync: {
  base: string; upstream: string; branch: string; stack: string; stackBefore: string; stackAfter: string;
}) {
  const folded = sync.stackBefore === sync.stackAfter
    ? ""
    : `\n\`--autosquash\` folded ${Number(sync.stackBefore) - Number(sync.stackAfter)} \`fixup!\` ` +
      `commit(s): ${sync.stackBefore} commits before, ${sync.stackAfter} after.\n`;
  return `Rebases the serspace patch stack onto \`cloudflare/cloudflare-os\` main.

| | |
| --- | --- |
| serspace before | \`${sync.base}\` |
| upstream main | \`${sync.upstream}\` |
| candidate | \`${sync.branch}\` |

Replayed stack, now sitting directly on upstream:

\`\`\`
${sync.stack}
\`\`\`
${folded}
The rebase was clean and the result has no merge commits, which is not the same as build or
test compatibility — that is what this pull request's CI is for.

## Do not merge this

Merging would add a merge commit to \`serspace\` and break the patch stack. This pull request
exists so the candidate gets review and CI. When it is green, promote it by force-push —
Actions → **Sync upstream** → \`mode=apply\`, or
\`git push --force-with-lease=serspace:${sync.base} origin ${sync.branch}:serspace\` — then close
this and tell everyone to \`git fetch && git reset --hard origin/serspace\`.

See \`docs/fork-automation.md\`.`;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
