import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubProjectProps } from "../../src/github-project";
import type { Outcome } from "./worker";
import { GitHubApi } from "../../src/github-api";
import { GitHubProjectConfiguratorUI } from "../../src/github-project-configurator";

const metadata = { id: "P", number: 1, title: "Roadmap", url: "https://github.com/orgs/acme/projects/1",
  shortDescription: null, readme: "Plan", closed: false, public: false };

class FakeProjectApi {
  projectId = "P";
  itemProjectId = "P";
  projectAllowed = true;
  repoAllowed = true;
  repoTransient = false;
  scopeDenied = false;
  afters: (string | null)[] = [];
  resolutions = 0;
  queries: string[] = [];
  ownerProjectAllowed = true;
  moveOnNextValuesPage = false;
  constructor() {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => this.fetch(new Request(input, init)));
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/repositories/17") {
      return Response.json(this.repoTransient ? { message: "Unavailable" } : this.repoAllowed ? { id: 17 } : { message: "Not Found" },
        { status: this.repoTransient ? 503 : this.repoAllowed ? 200 : 404 });
    }
    const { query, variables } = await request.json<{ query: string; variables: { after?: string; id?: string; item?: string } }>();
    this.queries.push(query);
    if (this.scopeDenied) return Response.json({ errors: [{ type: "INSUFFICIENT_SCOPES" }] });
    if (query.includes("query ResolveProject")) {
      this.resolutions++;
      return Response.json({ data: { owner: { projectV2: { ...metadata, id: this.projectId } } } });
    }
    if (query.includes("query DiscoverProjects")) {
      return Response.json({ data: { owner: { projectsV2: {
        nodes: [metadata], pageInfo: { hasNextPage: !variables.after, endCursor: variables.after ? null : "next" },
      } } } });
    }
    if (query.includes("query ProjectAccess")) {
      return Response.json({ data: { node: this.projectAllowed ? { id: variables.id } : null } });
    }
    if (query.includes("query ProjectMetadata")) return Response.json({ data: { node: { ...metadata, id: variables.id } } });
    const next = variables.after === undefined;
    const pageInfo = { hasNextPage: next, endCursor: next ? "next" : null };
    const item = { id: "item", isArchived: false, project: { id: this.itemProjectId }, content: {
      __typename: "Issue", number: 42, title: "Ship", url: "https://github.com/acme/widgets/issues/42",
      repository: { databaseId: 17, nameWithOwner: "acme/widgets" },
    } };
    if (query.includes("query ProjectItemFields")) {
      if (!next && this.moveOnNextValuesPage) item.project.id = "FOREIGN";
      this.afters.push(variables.after ?? null);
      return Response.json({ data: { project: this.ownerProjectAllowed ? { id: "P" } : null, node: { ...item, fieldValues: { nodes: [{
        __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "done", name: "Done",
        field: { id: "F", name: "Status", dataType: "SINGLE_SELECT" },
      }], pageInfo } } } });
    }
    if (query.includes("query ProjectItem(")) return Response.json({ data: { project: this.ownerProjectAllowed ? { id: "P" } : null, node: item } });
    if (query.includes("query ProjectFields")) return Response.json({ data: { node: {
      id: "P", fields: { nodes: [{ id: "F", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "done", name: "Done" }] }], pageInfo },
    } } });
    if (query.includes("query ProjectItems")) {
      this.afters.push(variables.after ?? null);
      return Response.json({ data: { node: { id: "P", items: { nodes: [next ? item : {
        id: "draft", isArchived: true, project: { id: this.itemProjectId }, content: { __typename: "DraftIssue", title: "Plan", body: "Draft" },
      }], pageInfo } } } });
    }
    throw new Error("Unexpected project query");
  }
}

afterEach(() => vi.unstubAllGlobals());

async function unwrap(pending: Promise<Outcome<string>>) {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return JSON.parse(result.ok);
}

async function setup() {
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), (_object, state) => { state.storage.kv.put("accessToken", "test-token"); });
  const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.newUniqueId());
  const props: GitHubProjectProps = { userObjectId: accountId.toString(), ownerType: "organization", owner: "acme", number: 1 };
  return { hooks, props,
    read: (method: Parameters<typeof hooks.projectRead>[1], options: Parameters<typeof hooks.projectRead>[2] = {}) =>
      unwrap(hooks.projectRead(props, method, options)),
    observer: (subresources?: string[]) => unwrap(hooks.projectObserver(props, accountId.toString(), subresources)),
    restart: () => hooks.restartGatekeeper("project"),
  };
}

describe("whole-project connections", () => {
  it("reads metadata and pins the project across restarts and URL reuse", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    expect((await g.read("metadata")).value.id).toBe("P");
    await g.restart();
    api.projectId = "REPLACEMENT";
    expect((await g.read("metadata")).value.id).toBe("P");
    expect(api.resolutions).toBe(1);
  });

  it("paginates active and archived draft items and records repository dependencies", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    const result = await g.read("items");
    expect(result.pages).toMatchObject([[{ content: { kind: "issue" } }], [{ isArchived: true, content: { kind: "draftIssue" } }], null]);
    expect(result.observations.map((o: { subresources: string[] }) => o.subresources)).toEqual([["project/P", "repository/17"], ["project/P"]]);
    expect(api.afters).toEqual([null, "next"]);
  });

  it("continues past an empty filtered page", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    const result = await g.read("items", { kind: "draftIssue" });
    expect(result.pages).toMatchObject([[], [{ id: "draft" }], null]);
    expect(api.afters).toEqual([null, "next"]);
  });

  it("retries the same page after observation refusal", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    const result = await g.read("items", { deny: 1 });
    expect(result.pages).toMatchObject([{ error: expect.stringContaining("Observation denied") }, [{ id: "item" }], [{ id: "draft" }], null]);
    expect(api.afters).toEqual([null, null, "next"]);
  });

  it("keeps a cursor's queue alive after its session is disposed", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    const result = await g.read("items", { disposeSession: true });
    expect(result.pages).toHaveLength(3);
    expect(api.afters).toEqual([null, "next"]);
  });

  it.each(["fields", "values"] as const)("paginates %s", async method => {
    const api = new FakeProjectApi();
    const g = await setup();
    const result = await g.read(method);
    expect(result.pages).toHaveLength(3);
    expect(result.pages[2]).toBeNull();
    expect(result.observations).toHaveLength(2);
    if (method === "values") expect(api.afters).toEqual([null, "next"]);
  });

  it.each(["item", "values"] as const)("rejects a foreign item on %s without disclosure", async method => {
    const api = new FakeProjectApi();
    const g = await setup();
    api.itemProjectId = "FOREIGN";
    if (method === "item") await expect(g.read(method)).rejects.toThrow("does not belong");
    else {
      const result = await g.read(method, { calls: 1 });
      expect(result.pages).toMatchObject([{ error: expect.stringContaining("does not belong") }]);
      expect(result.observations).toEqual([]);
    }
  });

  it("rechecks membership before each subsequent field page", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    api.moveOnNextValuesPage = true;
    const result = await g.read("values", { calls: 2 });
    expect(result.pages).toMatchObject([[{ value: { name: "Done" } }], { error: expect.stringContaining("does not belong") }]);
    expect(result.observations).toHaveLength(1);
  });

  it.each(["items", "fields", "values"] as const)("uses one GraphQL request per %s page after session setup", async method => {
    const api = new FakeProjectApi();
    const g = await setup();
    await g.read(method);
    expect(api.queries).toHaveLength(4); // Resolve + session metadata + two pages.
    expect(api.queries.filter(query => query.includes("query ProjectMetadata"))).toHaveLength(1);
  });

  it.each(["item", "values"] as const)("checks project access alongside %s content", async method => {
    const api = new FakeProjectApi();
    const g = await setup();
    api.ownerProjectAllowed = false;
    if (method === "item") await expect(g.read(method)).rejects.toThrow("unavailable");
    else {
      const result = await g.read(method, { calls: 1 });
      expect(result.pages).toMatchObject([{ error: expect.stringContaining("unavailable") }]);
      expect(result.observations).toEqual([]);
    }
  });

  it("provides a reconnect error when project permission is missing", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    api.scopeDenied = true;
    await expect(g.read("metadata")).rejects.toThrow("Reconnect GitHub");
  });

  it("requires project access for observation verification", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    api.projectAllowed = false;
    expect(await g.observer()).toEqual({ allowedObserverIds: [] });
    api.projectAllowed = true;
    expect(await g.observer()).toEqual({ allowedObserverIds: ["observer"] });
  });

  it("checks linked repositories separately from project access", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    api.repoAllowed = false;
    expect(await g.observer(["repository/17"])).toEqual({ allowedObserverIds: [] });
    api.repoAllowed = true;
    expect(await g.observer(["repository/17"])).toEqual({ allowedObserverIds: ["observer"] });
    api.repoTransient = true;
    await expect(g.observer(["repository/17"])).rejects.toThrow("Unavailable");
  });

  it("rejects unknown observer subresources", async () => {
    const api = new FakeProjectApi();
    const g = await setup();
    expect(api.projectAllowed).toBe(true);
    await expect(g.observer(["unknown/OTHER"])).rejects.toThrow("Unknown GitHub project subresource");
  });
});


describe("project connection picker", () => {
  it("pages discovery and resolves a prefilled project URL", async () => {
    const api = new FakeProjectApi();
    const picker = new GitHubProjectConfiguratorUI(fn => fn(new GitHubApi(async () => "test-token")));
    const first = await picker.listProjects("organization", "acme");
    expect(first.items).toMatchObject([{ id: metadata.url, title: "#1 Roadmap" }]);
    expect(first.nextCursor).toBe("next");
    expect((await picker.listProjects("organization", "acme", first.nextCursor)).nextCursor).toBeUndefined();
    expect(await picker.getProject(metadata.url)).toMatchObject({ id: metadata.url });
    expect(api.resolutions).toBe(1);
  });

  it("rejects malformed locators before calling GitHub", async () => {
    let calls = 0;
    const picker = new GitHubProjectConfiguratorUI(() => { calls++; throw new Error("Unexpected GitHub call"); });
    await expect(picker.listProjects("organization", "bad/owner")).rejects.toThrow("login");
    await expect(picker.getProject("https://example.com/orgs/acme/projects/1")).rejects.toThrow("project URL");
    expect(calls).toBe(0);
  });
});
