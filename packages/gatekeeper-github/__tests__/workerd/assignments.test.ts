import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssueDetails, GitHubIssueSummary } from "../../src/types";
import type { GatekeeperProps, Outcome, SessionCall } from "./worker";

function milestone(number: number) {
  return { number, title: `Release ${number}`, description: null, html_url: `https://github.com/acme/widgets/milestone/${number}`,
    state: "open", open_issues: 1, closed_issues: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    due_on: null, closed_at: null };
}

class AssignmentApi {
  readonly writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  ignore = false;
  state = { milestone: milestone(1) as ReturnType<typeof milestone> | null, assignees: [{ login: "old" }] };

  constructor(readonly pull = false) {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => this.fetch(new Request(input, init)));
  }

  row() {
    return { ...this.state, number: 42, title: "Ship", body: "Plan", state: "open", user: { login: "owner" }, labels: [],
      html_url: `https://github.com/acme/widgets/${this.pull ? "pull" : "issues"}/42`,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", comments: 0,
      head: { ref: "feature", sha: "a".repeat(40), repo: null }, base: { ref: "main", sha: "b".repeat(40), repo: null },
      ...(this.pull ? { pull_request: {} } : {}) };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/repositories\/17(?=\/|$)/, "/repos/acme/widgets");
    if (request.method !== "GET") {
      const body = await request.json<Record<string, unknown>>();
      this.writes.push({ method: request.method, path, body });
      if (request.method === "POST" && path.endsWith("/issues")) this.state = { milestone: null, assignees: [] };
      if (request.method === "PATCH" && !this.ignore) {
        if ("milestone" in body) this.state.milestone = body.milestone === null ? null : milestone(body.milestone as number);
        if ("assignees" in body) this.state.assignees = (body.assignees as string[]).map(login => ({ login: login.toLowerCase() }));
      }
      return Response.json(this.row());
    }
    if (path.endsWith("/assignees")) {
      return Response.json(url.searchParams.get("page") === "1" ? [{ login: "ada" }, { login: "grace" }] : []);
    }
    if (path.includes("/assignees/")) {
      return ["ada", "grace", "old"].includes(path.split("/").at(-1)!.toLowerCase()) ? new Response(null, { status: 204 }) :
        Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (path.includes("/milestones/")) {
      const number = Number(path.split("/").at(-1));
      return number === 404 ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json(milestone(number));
    }
    if (/\/(issues|pulls)\/42$/.test(path)) return Response.json(this.row());
    if (path === "/search/issues") return Response.json({ items: [this.row()] });
    if (path.endsWith("/issues") || path.endsWith("/pulls")) {
      return Response.json(url.searchParams.get("page") === "1" ? [this.row()] : []);
    }
    if (path === "/user") return Response.json({ login: "owner" });
    if (path === "/repos/acme/widgets") return Response.json({ id: 17, full_name: "acme/widgets", default_branch: "main",
      html_url: "https://github.com/acme/widgets", name: "widgets", owner: { login: "acme" } });
    throw new Error(`Unexpected assignment request ${path}`);
  }
}

class Queue extends RpcTarget {
  actions: { id: number; description: ActionDescription }[] = [];
  observations = 0;
  refuse = false;
  async submitAction(id: number, description: ActionDescription): Promise<void> {
    if (this.refuse) throw new Error("Action refused");
    this.actions.push({ id, description });
  }
  async authorizeObservation(): Promise<void> { this.observations++; }
  async getGitCache() { return new RpcStub(new UnusedGitCache()); }
}
class UnusedGitCache extends RpcTarget {}

async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

async function setup(resourceKind: GatekeeperProps["resourceKind"] = "repo", pull = false) {
  const api = new AssignmentApi(pull || resourceKind === "pull");
  const account = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(account), (_instance, state) => { state.storage.kv.put("accessToken", "test-token"); });
  const props: GatekeeperProps = { userObjectId: account.toString(), resourceKind, owner: "acme", repo: "widgets", issueNumber: 42 };
  const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.newUniqueId());
  const queue = new Queue();
  const call = async (calls: SessionCall[], drain = false) => {
    using stub = new RpcStub(queue);
    return unwrap(hooks.sessionRead("assignment", props, stub as never, calls, drain));
  };
  const change = (method: "setMilestone" | "setAssignees", value: number | null | string[], id = "42") => call([
    ...(resourceKind === "repo" ? [{ method: api.pull ? "getPullRequest" : "getIssue", args: [id] }] : []),
    { method, args: [value] },
  ]);
  return { api, queue, hooks, props, call, change,
    read: (id = "42") => api.pull ? unwrap(hooks.openPullRequest("assignment", props, id)) : unwrap(hooks.openIssue("assignment", props, id)),
    apply: async (id: number) => { using cache = new RpcStub(new UnusedGitCache()); return unwrap(hooks.applyAction("assignment", props, id, cache as never)); },
    reject: (id: number) => unwrap(hooks.rejectAction("assignment", props, id)),
    revert: (id: number) => unwrap(hooks.revertAction("assignment", props, id)),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("milestone and assignee assignment", () => {
  it.each(["repo", "issue", "pull"] as const)("stages, simulates, applies and reverts through a %s binding", async kind => {
    const g = await setup(kind);
    await g.change("setMilestone", 3);
    await g.change("setAssignees", ["Ada", "ADA", "grace"]);
    expect(g.api.writes).toEqual([]);
    expect(g.queue.observations).toBe(0);
    expect((await g.read()).milestone?.number).toBe(3);
    expect((await g.read()).assignees.map(actor => actor.login.toLowerCase())).toEqual(["ada", "grace"]);
    expect(g.queue.actions.map(action => action.description.actionKind?.tag)).toEqual(["github.setMilestone", "github.setAssignees"]);
    expect(g.queue.actions.every(action => action.description.implementsRevert)).toBe(true);
    for (const action of g.queue.actions) await g.apply(action.id);
    expect(g.api.writes.map(write => [write.path, write.body])).toEqual([
      ["/repos/acme/widgets/issues/42", { milestone: 3 }],
      ["/repos/acme/widgets/issues/42", { assignees: ["ADA", "grace"] }],
    ]);
    for (const action of g.queue.actions.toReversed()) await g.revert(action.id);
    expect((await g.read()).milestone?.number).toBe(1);
    expect((await g.read()).assignees.map(actor => actor.login)).toEqual(["old"]);
  });

  it("supports a pull request reached from a repository binding", async () => {
    const g = await setup("repo", true);
    await g.change("setMilestone", 3);
    await g.change("setAssignees", ["ada"]);
    for (const action of g.queue.actions) await g.apply(action.id);
    expect((await g.read()).milestone?.number).toBe(3);
    expect((await g.read()).assignees.map(actor => actor.login)).toEqual(["ada"]);
  });

  it("clears assignments and restores the previous values on rejection", async () => {
    const g = await setup();
    await g.change("setMilestone", null);
    await g.change("setAssignees", []);
    expect((await g.read()).milestone).toBeNull();
    expect((await g.read()).assignees).toEqual([]);
    for (const action of g.queue.actions.toReversed()) await g.reject(action.id);
    expect((await g.read()).milestone?.number).toBe(1);
    expect((await g.read()).assignees).toMatchObject([{ login: "old" }]);
    expect(g.api.writes).toEqual([]);
  });

  it("sends explicit null and [] when clearing approved assignments", async () => {
    const g = await setup();
    await g.change("setMilestone", null);
    await g.change("setAssignees", []);
    for (const action of g.queue.actions) await g.apply(action.id);
    expect(g.api.writes.map(write => write.body)).toEqual([{ milestone: null }, { assignees: [] }]);
    expect((await g.read()).milestone).toBeNull();
    expect((await g.read()).assignees).toEqual([]);
  });

  it("rechecks pending assignments in milestone and assignee issue listings", async () => {
    const g = await setup();
    await g.change("setMilestone", 3);
    await g.change("setAssignees", ["ada"]);
    for (const method of ["listIssues", "searchIssues"] as const) {
      const query = { text: "", milestone: 3, assignee: "ada", state: "all" };
      const pages = await unwrap(g.hooks.listingPages("assignment", g.props, method, query, 50)) as (GitHubIssueSummary[] | null)[];
      expect(pages.flatMap(page => page ?? []).map(issue => issue.id)).toEqual(["42"]);
      const old = await unwrap(g.hooks.listingPages("assignment", g.props, method, { ...query, milestone: 1 }, 50)) as (GitHubIssueSummary[] | null)[];
      expect(old.flatMap(page => page ?? [])).toEqual([]);
    }
  });

  it.each(["setMilestone", "setAssignees"] as const)("detects a silently ignored %s and lets the same action retry", async method => {
    const g = await setup();
    await g.change(method, method === "setMilestone" ? 3 : ["ada"]);
    const id = g.queue.actions[0].id;
    g.api.ignore = true;
    await expect(g.apply(id)).rejects.toThrow("did not apply");
    g.api.ignore = false;
    await g.apply(id);
    expect(g.api.writes).toHaveLength(2);
  });

  it("does not stage invalid milestones or unassignable users", async () => {
    const g = await setup();
    await expect(g.change("setMilestone", 0)).rejects.toThrow("positive integer");
    await expect(g.change("setMilestone", 404)).rejects.toThrow("Not Found");
    await expect(g.change("setAssignees", ["unknown"])).rejects.toThrow("Not Found");
    await expect(g.change("setAssignees", ["@ada"])).rejects.toThrow("GitHub logins");
    await expect(g.change("setAssignees", Array.from({ length: 11 }, (_, i) => `user${i}`))).rejects.toThrow("At most 10");
    expect(g.queue.actions).toEqual([]);
    expect(g.api.writes).toEqual([]);
  });

  it("rolls back simulation when the action queue refuses a change", async () => {
    const g = await setup();
    g.queue.refuse = true;
    await expect(g.change("setMilestone", 3)).rejects.toThrow("Action refused");
    await expect(g.change("setAssignees", ["ada"])).rejects.toThrow("Action refused");
    expect((await g.read()).milestone?.number).toBe(1);
    expect((await g.read()).assignees).toMatchObject([{ login: "old" }]);
  });

  it("supports assignments on a provisional issue and resolves its real number at apply", async () => {
    const g = await setup();
    const issue = await g.call([{ method: "createIssue", args: [{ title: "Ship" }] }, { method: "getDetails" }]) as GitHubIssueDetails;
    await g.change("setMilestone", 3, issue.id);
    await g.change("setAssignees", ["ada"], issue.id);
    await expect(g.apply(g.queue.actions[1].id)).rejects.toThrow("not been created");
    for (const action of g.queue.actions) await g.apply(action.id);
    expect(g.api.writes.slice(-2).map(write => write.path)).toEqual(["/repos/acme/widgets/issues/42", "/repos/acme/widgets/issues/42"]);
    expect((await g.read(issue.id)).milestone?.number).toBe(3);
  });

  it("discards dependent assignments when their provisional create is rejected", async () => {
    const g = await setup();
    const issue = await g.call([{ method: "createIssue", args: [{ title: "Ship" }] }, { method: "getDetails" }]) as GitHubIssueDetails;
    await g.change("setMilestone", 3, issue.id);
    await g.change("setAssignees", ["ada"], issue.id);
    await g.reject(g.queue.actions[0].id);
    for (const action of g.queue.actions.slice(1)) await expect(g.apply(action.id)).rejects.toThrow("discarded");
    expect(g.api.writes).toEqual([]);
  });

  it("pages assignable users and authorizes every page", async () => {
    const g = await setup();
    expect(await g.call([{ method: "listAssignees", args: [{ resultsPerPage: 2 }] }], true)).toMatchObject([{ login: "ada" }, { login: "grace" }]);
    expect(g.queue.observations).toBe(2);
  });
});
