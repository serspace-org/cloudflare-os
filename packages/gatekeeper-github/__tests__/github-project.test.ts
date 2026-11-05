import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github-api";
import { discoverProjects, parseProjectUrl, projectFields, projectItem, projectItemFields, projectItems, resolveProject } from "../src/github-project-api";

afterEach(() => vi.unstubAllGlobals());
const api = () => new GitHubApi(async () => "test-token");
const end = { hasNextPage: false, endCursor: null };

describe("project URLs", () => {
  it.each(["orgs", "users"])("accepts %s projects and view URLs", family => {
    expect(parseProjectUrl(`https://github.com/${family}/acme/projects/12/views/4`)).toEqual({
      ownerType: family === "orgs" ? "organization" : "user", owner: "acme", number: 12,
    });
  });
  it.each([
    "https://example.com/orgs/acme/projects/1", "http://github.com/orgs/acme/projects/1",
    "https://github.com/acme/repo/projects/1", "https://github.com/orgs/acme/projects/new",
    "https://github.com/orgs/acme/projects/0", "https://github.com/orgs/acme/projects/12abc",
    "https://github.com/orgs/acme/projects/99999999999999999", "https://github.com/orgs/acme/projects/1/other",
    "https://user:pass@github.com/orgs/acme/projects/1",
  ])("rejects malformed or unsupported locator %s", url => expect(parseProjectUrl(url)).toBeNull());
});

describe("project API boundaries", () => {
  it.each(["organization", "user"] as const)("resolves a %s project with variables", async ownerType => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: { owner: { projectV2: { id: "P" } } } }));
    vi.stubGlobal("fetch", fetch);
    await expect(resolveProject(api(), { ownerType, owner: "acme", number: 1 })).resolves.toEqual({ id: "P" });
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain(`${ownerType}(login: $owner)`);
    expect(body.variables).toEqual({ owner: "acme", number: 1 });
  });

  it("does not turn missing scope into an empty project listing", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ errors: [{ type: "INSUFFICIENT_SCOPES" }] }));
    await expect(discoverProjects(api(), "organization", "acme", 50)).rejects.toThrow("Reconnect GitHub");
  });

  it("makes HTTP permission failures actionable without hiding rate limits", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ message: "Resource not accessible" }, { status: 403 }));
    await expect(discoverProjects(api(), "organization", "acme", 50)).rejects.toThrow("Reconnect GitHub");
    vi.stubGlobal("fetch", async () => Response.json({ message: "API rate limit exceeded" }, {
      status: 403, headers: { "x-ratelimit-remaining": "0" },
    }));
    await expect(discoverProjects(api(), "organization", "acme", 50)).rejects.toThrow("rate limit");
  });

  it("preserves an empty intermediate discovery page", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ data: { owner: { projectsV2: {
      nodes: [null], pageInfo: { hasNextPage: true, endCursor: "next" },
    } } } }));
    await expect(discoverProjects(api(), "user", "ada", 50)).resolves.toEqual({ items: [], next: "next" });
  });

  it("reads field options and both iteration schedules", async () => {
    const field = { id: "F", name: "Sprint", dataType: "ITERATION", configuration: {
      iterations: [{ id: "I", title: "Current", startDate: "2026-11-01", duration: 14 }], completedIterations: [],
    } };
    vi.stubGlobal("fetch", async () => Response.json({ data: { node: { id: "P", fields: { nodes: [field], pageInfo: end } } } }));
    expect((await projectFields(api(), "P", 1)).items).toEqual([field]);
  });

  it("keeps draft, archived and redacted items distinct", async () => {
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string).query).toContain("archivedStates: [ARCHIVED, NOT_ARCHIVED]");
      return Response.json({ data: { node: { id: "P", items: {
      nodes: [
        { id: "draft", isArchived: true, project: { id: "P" }, content: { __typename: "DraftIssue", title: "Plan", body: "Draft" } },
        { id: "hidden", isArchived: false, project: { id: "P" }, content: null },
      ], pageInfo: end,
    } } } }); });
    expect((await projectItems(api(), "P", 50)).items).toEqual([
      { id: "draft", isArchived: true, content: { kind: "draftIssue", title: "Plan", bodyMarkdown: "Draft" } },
      { id: "hidden", isArchived: false, content: { kind: "redacted" } },
    ]);
  });

  it.each(["item", "values"])("rejects a foreign item when reading %s", async method => {
    vi.stubGlobal("fetch", async () => Response.json({ data: { node: {
      id: "item", isArchived: false, project: { id: "OTHER" }, content: null,
      fieldValues: { nodes: [], pageInfo: end },
    } } }));
    await expect(method === "item" ? projectItem(api(), "P", "item") : projectItemFields(api(), "P", "item", 50))
      .rejects.toThrow("does not belong");
  });
});
