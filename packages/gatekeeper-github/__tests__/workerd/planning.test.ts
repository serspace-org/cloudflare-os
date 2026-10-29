import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperProps, Outcome } from "./worker";

const milestone = {
  number: 3, title: "Launch", description: "Ready to ship", html_url: "https://github.com/acme/widgets/milestone/3",
  state: "open", open_issues: 2, closed_issues: 8, created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z", due_on: "2026-02-01T00:00:00Z", closed_at: null,
};
const project = { id: "project", number: 1, title: "Roadmap", url: "https://github.com/orgs/acme/projects/1",
  shortDescription: null, closed: false, public: false };

class FakePlanningApi {
  allowed = false;
  checks = 0;
  afters: (string | null)[] = [];
  fieldAfters: (string | null)[] = [];
  kind = "Issue";
  fieldNumber = 42;
  projectId = "project";
  deniedProjects = new Set<string>();
  stallChecks = false;
  stalled = 0;
  constructor() {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => this.fetch(new Request(input, init)));
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/milestones")) {
      return Response.json(url.searchParams.get("page") === "1" ? [milestone] : []);
    }
    if (url.pathname.endsWith("/milestones/3")) return Response.json(milestone);
    if (/\/(issues|pulls)\/42$/.test(url.pathname)) return Response.json({
      number: 42, title: "Ship", state: "open", body: "Plan", user: null, labels: [], assignees: [],
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", comments: 0, milestone,
      head: { ref: "feature", sha: "a".repeat(40), repo: null },
      base: { ref: "main", sha: "b".repeat(40), repo: null }, draft: false,
    });
    if (request.method === "GET") return Response.json({ id: 17, node_id: "R_pinned", default_branch: "main" });
    const { query, variables } = await request.json<{ query: string; variables: { after?: string; id?: string } }>();
    if (query.includes("query ProjectAccess")) {
      this.checks++;
      if (this.stallChecks) {
        this.stalled++;
        while (this.stallChecks) await new Promise(resolve => setTimeout(resolve, 1));
      }
      return Response.json({ data: { node: this.allowed && !this.deniedProjects.has(variables.id!) ? { id: variables.id } : null } });
    }
    const next = variables.after === undefined;
    const pageInfo = { hasNextPage: next, endCursor: next ? "next" : null };
    if (query.includes("query IssueProjectFields")) {
      this.fieldAfters.push(variables.after ?? null);
      return Response.json({ data: { node: {
        project: { id: this.projectId },
        content: { __typename: this.kind, number: this.fieldNumber, repository: { databaseId: 17 } },
        fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: next ? "todo" : "done",
          name: next ? "Todo" : "Done", field: { id: "status", name: "Status", dataType: "SINGLE_SELECT" } }], pageInfo },
      } } });
    }
    this.afters.push(variables.after ?? null);
    return Response.json({ data: { node: { issueOrPullRequest: {
      __typename: this.kind, projectItems: { nodes: [{ id: next ? "item" : "item2", isArchived: !next,
        project: { ...project, id: this.projectId } }], pageInfo },
    } } } });
  }
}

afterEach(() => vi.unstubAllGlobals());

async function unwrap<T>(value: Promise<Outcome<T>>): Promise<T> {
  const result = await value;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

async function setup(resourceKind: GatekeeperProps["resourceKind"] = "repo") {
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.newUniqueId());
  const props: GatekeeperProps = { userObjectId: accountId.toString(), resourceKind,
    owner: "acme", repo: "widgets", ...(resourceKind === "repo" ? {} : { issueNumber: 42 }) };
  return {
    hooks, props,
    read: (method: "projects" | "fields" | "milestones", options = {}) =>
      unwrap(hooks.planningPages("planning", props, method, options)),
    add: () => unwrap(hooks.planningObserver("planning", props, "observer", accountId.toString())),
    remove: () => unwrap(hooks.planningObserver("planning", props, "observer")),
    restart: () => hooks.restartGatekeeper("planning"),
  };
}

describe("planning reads through sessions", () => {
  it("includes milestone details and paginates repository milestones", async () => {
    const api = new FakePlanningApi();
    const g = await setup();
    const details = await unwrap(g.hooks.openIssue("planning", g.props, "42"));
    expect(details.milestone).toMatchObject({ title: "Launch", openIssues: 2, closedIssues: 8,
      dueOn: new Date("2026-02-01T00:00:00Z") });
    const result = await g.read("milestones");
    expect(result.pages).toMatchObject([[{ number: 3 }], [], null]);
    expect(result.observations).toHaveLength(2);
    expect(api.afters).toEqual([]);
  });

  it.each(["repo", "issue", "pull"] as const)("paginates project memberships on a %s binding", async kind => {
    const api = new FakePlanningApi();
    if (kind === "pull") api.kind = "PullRequest";
    const g = await setup(kind);
    const result = await g.read("projects");
    expect(result.pages).toMatchObject([[{ id: "item", isArchived: false }], [{ id: "item2", isArchived: true }], null]);
    expect(api.afters).toEqual([null, "next"]);
    expect(result.observations).toHaveLength(2);
  });

  it("does not skip a page when observation authorization fails", async () => {
    const api = new FakePlanningApi();
    const g = await setup();
    const result = await g.read("projects", { deny: 1 });
    expect(result.pages).toMatchObject([{ error: expect.stringContaining("Observation denied") }, [{ id: "item" }], [{ id: "item2" }], null]);
    expect(api.afters).toEqual([null, null, "next"]);
  });

  it("paginates field values and rechecks item membership on every page", async () => {
    const api = new FakePlanningApi();
    const g = await setup("issue");
    const result = await g.read("fields");
    expect(result.pages).toMatchObject([[{ value: { name: "Todo" } }], [{ value: { name: "Done" } }], null]);
    expect(api.fieldAfters).toEqual([null, "next"]);
    api.fieldNumber = 99;
    const escaped = await g.read("fields", { calls: 1 });
    expect(escaped.pages).toEqual([{ error: expect.stringContaining("does not belong") }]);
    expect(escaped.observations).toHaveLength(0);
  });
});

describe("project observers", () => {
  it("blocks existing repo observers from a new private project, including retries after restart", async () => {
    const api = new FakePlanningApi();
    const g = await setup();
    await g.add(); // Repository access alone suffices until any project is read.
    const denied = await g.read("projects", { calls: 1 });
    expect(denied.observations[0].excludeObservers).toEqual(["observer"]);
    expect(denied.pages).toEqual([{ error: expect.stringContaining("Observation denied") }]);
    await g.restart();
    await expect(g.add()).rejects.toThrow("cannot read a GitHub project");
    const again = await g.read("projects", { calls: 1 });
    expect(again.observations[0].excludeObservers).toEqual(["observer"]);
    api.allowed = true;
    await g.add();
    expect((await g.read("projects", { calls: 1 })).pages).toMatchObject([[{ id: "item" }]]);
  });

  it("verifies newly admitted observers against observed projects after restart", async () => {
    const api = new FakePlanningApi();
    const g = await setup();
    await g.read("fields", { calls: 1 });
    await g.restart();
    await expect(g.add()).rejects.toThrow("cannot read a GitHub project");
    expect(api.checks).toBe(1);
  });

  it("checks projects introduced while observer admission is awaiting another project", async () => {
    const api = new FakePlanningApi();
    api.allowed = true;
    const g = await setup();
    await g.read("projects", { calls: 1 });
    api.stallChecks = true;
    const admission = g.add();
    try {
      await vi.waitFor(() => expect(api.stalled).toBe(1));
      api.projectId = "private-project";
      api.deniedProjects.add("private-project");
      await g.read("projects", { calls: 1 });
    } finally {
      api.stallChecks = false;
    }
    await expect(admission).rejects.toThrow("cannot read a GitHub project");
    expect(api.checks).toBe(2);
  });

  it("removes an observer idempotently and rechecks pending projects on retry", async () => {
    const api = new FakePlanningApi();
    const g = await setup();
    await g.add();
    await g.read("projects", { calls: 1 });
    await g.remove();
    await g.remove();
    const checks = api.checks;
    expect((await g.read("projects", { calls: 1 })).pages).toMatchObject([[{ id: "item" }]]);
    expect(api.checks).toBe(checks);
  });
});
