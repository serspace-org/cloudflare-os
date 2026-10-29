import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github-api";
import { connectionPage, normalizeMilestone, normalizeProjectField } from "../src/github-planning";

afterEach(() => vi.unstubAllGlobals());

const pageInfo = { hasNextPage: false, endCursor: null };
const api = () => new GitHubApi(async () => "test-token", { repo: { owner: "acme", repo: "widgets", id: 17 } });

function mockGraphql(node: unknown) {
  return vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { node } })));
}

describe("project API boundaries", () => {
  it("resolves projects through the pinned repository ID and includes archived items", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "GET") return Response.json({ id: 17, node_id: "R_pinned" });
      return Response.json({ data: { node: { issueOrPullRequest: {
        __typename: "Issue", projectItems: {
          nodes: [{ id: "item", isArchived: true, project: { id: "project" } }, null],
          pageInfo: { hasNextPage: true, endCursor: "page2" },
        },
      } } } });
    });
    const result = await api().listIssueProjects(42, "issue", 2, "page1");
    expect(requests[0].url).toBe("https://api.github.com/repositories/17");
    const body = await requests[1].json() as { query: string; variables: unknown };
    expect(body.variables).toEqual({ repo: "R_pinned", number: 42, first: 2, after: "page1" });
    expect(body.query).toContain("includeArchived: true");
    expect(result.next).toBe("page2");
    expect(result.items).toHaveLength(1);
  });

  it.each([
    { __typename: "Issue", number: 43, repository: { databaseId: 17 } },
    { __typename: "Issue", number: 42, repository: { databaseId: 99 } },
    { __typename: "PullRequest", number: 42, repository: { databaseId: 17 } },
    { __typename: "DraftIssue" },
    null,
  ])("rejects project items outside the bound issue: %j", async content => {
    mockGraphql({ project: { id: "private-project" }, content, fieldValues: { nodes: [], pageInfo } });
    await expect(api().listIssueProjectFields(42, "issue", "item", 10)).rejects.toThrow("does not belong");
  });

  it("paginates field values, including zero and empty text", async () => {
    mockGraphql({ project: { id: "project" },
      content: { __typename: "PullRequest", number: 42, repository: { databaseId: 17 } },
      fieldValues: { nodes: [
        { __typename: "ProjectV2ItemFieldNumberValue", number: 0 },
        { __typename: "ProjectV2ItemFieldTextValue", text: "" },
      ], pageInfo: { hasNextPage: true, endCursor: "next-fields" } },
    });
    const result = await api().listIssueProjectFields(42, "pull", "item", 2);
    expect(result.items.map(field => field.value)).toEqual([{ kind: "number", number: 0 }, { kind: "text", text: "" }]);
    expect(result.next).toBe("next-fields");
    expect(result.projectId).toBe("project");
  });

  it("rejects partial GraphQL data and does not expose upstream error messages", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ data: { node: { id: "project" } },
      errors: [{ type: "FORBIDDEN", message: "sensitive upstream detail" }] }));
    await expect(api().listIssueProjectFields(42, "issue", "item", 10)).rejects.toThrow("Reconnect GitHub");
    await expect(api().hasProjectAccess("project")).resolves.toBe(false);
  });

  it("does not turn transient GraphQL failures into missing access", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ errors: [{ type: "INTERNAL" }] }));
    await expect(api().hasProjectAccess("project")).rejects.toThrow("complete project data");
  });

  it("propagates HTTP rate limits rather than treating them as missing project access", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ message: "API rate limit exceeded" },
      { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    await expect(api().hasProjectAccess("project")).rejects.toThrow("rate limit");
  });

  it("requires repository identity before making a project query", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const unpinned = new GitHubApi(async () => "token");
    await expect(unpinned.listIssueProjects(42, "issue", 10)).rejects.toThrow("verified repository");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("planning data", () => {
  it("normalizes milestone progress and nullable dates", () => {
    const milestone = normalizeMilestone({ number: 3, title: "Launch", description: null, html_url: "https://github.com/a/b/milestone/3",
      state: "open", open_issues: 2, closed_issues: 8, created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z", due_on: "2026-02-01T00:00:00Z", closed_at: null });
    expect(milestone).toMatchObject({ number: 3, description: "", openIssues: 2, closedIssues: 8,
      dueOn: new Date("2026-02-01T00:00:00Z"), closedAt: null });
  });

  it("preserves single-select, multi-select and iteration identities", () => {
    const field = { id: "field", name: "Status", dataType: "SINGLE_SELECT" };
    expect(normalizeProjectField({ __typename: "ProjectV2ItemFieldSingleSelectValue", field, optionId: "done", name: "Done" }))
      .toEqual({ field, value: { kind: "singleSelect", optionId: "done", name: "Done" } });
    expect(normalizeProjectField({ __typename: "ProjectV2ItemFieldMultiSelectValue", options: [{ id: "a", name: "A" }] }).value)
      .toEqual({ kind: "multiSelect", options: [{ id: "a", name: "A" }] });
    expect(normalizeProjectField({ __typename: "ProjectV2ItemFieldIterationValue", iterationId: "sprint", title: "Sprint 1",
      startDate: "2026-01-01", duration: 14 }).value)
      .toEqual({ kind: "iteration", iterationId: "sprint", title: "Sprint 1", startDate: "2026-01-01", duration: 14 });
  });

  it("distinguishes derived issue fields and unsupported future types", () => {
    expect(normalizeProjectField({ __typename: "ProjectV2ItemFieldMilestoneValue" }).value)
      .toEqual({ kind: "issueProperty", property: "milestone" });
    expect(normalizeProjectField({ __typename: "FutureValue" }).value)
      .toEqual({ kind: "unsupported", type: "FutureValue" });
  });

  it("rejects non-advancing pagination and preserves empty intermediate pages", () => {
    expect(() => connectionPage({ nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } }, "same"))
      .toThrow("invalid pagination");
    expect(connectionPage({ nodes: [null], pageInfo: { hasNextPage: true, endCursor: "next" } }))
      .toEqual({ items: [], next: "next" });
  });
});
