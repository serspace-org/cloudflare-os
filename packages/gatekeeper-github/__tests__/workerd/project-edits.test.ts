import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import type { ActionDescription, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssueProjectField, GitHubProjectFieldInput, GitHubProjectFieldValue } from "../../src/types";
import type { GatekeeperProps, Outcome, SessionCall } from "./worker";

const status: GitHubIssueProjectField = { id: "status", name: "Status", dataType: "SINGLE_SELECT", isIssueField: false,
  options: [{ id: "todo", name: "Todo" }, { id: "done", name: "Done" }, { id: "external", name: "External" }] };
const end = { hasNextPage: false, endCursor: null };

class ProjectApi {
  fields: GitHubIssueProjectField[] = [status, { id: "estimate", name: "Estimate", dataType: "NUMBER" }];
  values = new Map<string, Record<string, unknown>>([["status", { singleSelectOptionId: "todo" }]]);
  writes: Record<string, unknown>[] = [];
  kind = "Issue";
  number = 42;
  repositoryId = 17;
  projectId = "project";
  ignore = false;
  loseReply = false;
  denied = false;
  partial = false;
  observerAllowed = true;
  constructor() {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => this.fetch(new Request(input, init)));
  }
  raw(id: string, value: Record<string, unknown>) {
    const field = this.fields.find(field => field.id === id)!;
    if ("singleSelectOptionId" in value) return { field, __typename: "ProjectV2ItemFieldSingleSelectValue",
      optionId: value.singleSelectOptionId, name: field.options?.find(option => option.id === value.singleSelectOptionId)?.name };
    return { field, __typename: "ProjectV2ItemFieldNumberValue", number: value.number };
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && /\/issues\/42$/.test(new URL(request.url).pathname)) {
      return Response.json({ number: 42, title: "Ship", body: "Plan", state: "open", user: null,
        labels: [], assignees: [], milestone: null, comments: 0, html_url: "https://github.com/acme/widgets/issues/42",
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    }
    if (request.method === "GET") return Response.json({ id: 17, node_id: "R_pinned", default_branch: "main",
      name: "widgets", full_name: "acme/widgets", html_url: "https://github.com/acme/widgets", owner: { login: "acme" } });
    const { query, variables } = await request.json<{ query: string; variables: {
      id?: string; first?: number; after?: string; input?: { projectId: string; itemId: string; fieldId: string; value?: Record<string, unknown> };
    } }>();
    if (query.includes("query ProjectAccess")) return Response.json({ data: { node: this.observerAllowed ? { id: variables.id } : null } });
    if (query.includes("mutation EditIssueProjectField")) {
      if (this.denied) return Response.json({ errors: [{ type: "INSUFFICIENT_SCOPES" }] });
      const input = variables.input!;
      this.writes.push(input);
      if (!this.ignore) {
        if (input.value) this.values.set(input.fieldId, input.value);
        else this.values.delete(input.fieldId);
      }
      if (this.loseReply) { this.loseReply = false; throw new Error("Lost mutation reply"); }
      const key = input.value ? "updateProjectV2ItemFieldValue" : "clearProjectV2ItemFieldValue";
      return Response.json({ data: { [key]: { projectV2Item: { id: input.itemId } } },
        ...(this.partial ? { errors: [{ type: "INTERNAL" }] } : {}) });
    }
    const start = Number(variables.after ?? 0);
    const size = variables.first ?? 100;
    if (query.includes("query ProjectFields")) {
      return Response.json({ data: { node: { id: variables.id, fields: { nodes: this.fields.slice(start, start + size),
        pageInfo: start + size < this.fields.length ? { hasNextPage: true, endCursor: String(start + size) } : end } } } });
    }
    if (query.includes("query IssueProjectFields")) {
      const values = [...this.values].map(([id, value]) => this.raw(id, value));
      return Response.json({ data: { node: { project: { id: this.projectId },
        content: { __typename: this.kind, number: this.number, repository: { databaseId: this.repositoryId } },
        fieldValues: { nodes: values.slice(start, start + size),
          pageInfo: start + size < values.length ? { hasNextPage: true, endCursor: String(start + size) } : end } } } });
    }
    throw new Error(`Unexpected project edit request: ${query}`);
  }
}

class Queue extends RpcTarget {
  actions: { id: number; description: ActionDescription }[] = [];
  observations: ObservationDescription[] = [];
  refuse = false;
  deny = false;
  async submitAction(id: number, description: ActionDescription): Promise<void> {
    if (this.refuse) throw new Error("Action refused");
    this.actions.push({ id, description });
  }
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
    if (this.deny || description.excludeObservers?.length) throw new Error("Observation denied");
  }
  async getGitCache() { return new RpcStub(new UnusedGitCache()); }
}
class UnusedGitCache extends RpcTarget {}
async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}
async function setup(resourceKind: GatekeeperProps["resourceKind"] = "issue") {
  const api = new ProjectApi();
  if (resourceKind === "pull") api.kind = "PullRequest";
  const account = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(account), (_instance, state) => { state.storage.kv.put("accessToken", "test-token"); });
  const props: GatekeeperProps = { userObjectId: account.toString(), resourceKind, owner: "acme", repo: "widgets", issueNumber: 42 };
  const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.newUniqueId());
  const queue = new Queue();
  const call = async (calls: SessionCall[], drain = false) => {
    using stub = new RpcStub(queue);
    return unwrap(hooks.sessionRead("project-edit", props, stub as never,
      [...(resourceKind === "repo" ? [{ method: "getIssue", args: ["42"] }] : []), ...calls], drain));
  };
  return { api, queue, hooks, props, call,
    change: (value: GitHubProjectFieldInput | null, field = "status") => call([{ method: "setProjectField", args: ["item", field, value] }]),
    read: async () => await call([{ method: "listProjectFields", args: ["item", { resultsPerPage: 1 }] }], true) as GitHubProjectFieldValue[],
    apply: async (id: number) => { using cache = new RpcStub(new UnusedGitCache()); return unwrap(hooks.applyAction("project-edit", props, id, cache as never)); },
    reject: (id: number) => unwrap(hooks.rejectAction("project-edit", props, id)),
    revert: (id: number) => unwrap(hooks.revertAction("project-edit", props, id)),
    restart: () => hooks.restartGatekeeper("project-edit"),
  };
}

afterEach(() => vi.unstubAllGlobals());
const done: GitHubProjectFieldInput = { kind: "singleSelect", optionId: "done" };

describe("approval-gated issue project fields", () => {
  it.each(["repo", "issue", "pull"] as const)("stages, simulates, applies and undoes from a %s binding", async kind => {
    const g = await setup(kind);
    await g.change(done);
    expect(g.api.writes).toEqual([]);
    expect(await g.read()).toMatchObject([{ value: { name: "Done" } }]);
    const action = g.queue.actions[0];
    expect(action.description).toMatchObject({ actionKind: { tag: "github.setProjectField" }, autoApprovable: false, implementsRevert: true });
    expect(action.description.description).toContain("Status");
    await g.apply(action.id);
    expect(g.api.writes).toEqual([{ projectId: "project", itemId: "item", fieldId: "status", value: { singleSelectOptionId: "done" } }]);
    await g.restart();
    await g.revert(action.id);
    await g.revert(action.id);
    expect(g.api.values.get("status")).toEqual({ singleSelectOptionId: "todo" });
    expect(g.api.writes).toHaveLength(2);
  });

  it("adds an unset value once across simulated pages and clears/restores values", async () => {
    const g = await setup();
    await g.change({ kind: "number", number: 0 }, "estimate");
    expect(await g.read()).toHaveLength(2);
    await g.change(null);
    expect(await g.read()).toMatchObject([{ field: { id: "estimate" }, value: { number: 0 } }]);
    for (const action of g.queue.actions) await g.apply(action.id);
    expect(g.api.values.has("status")).toBe(false);
    for (const action of g.queue.actions.toReversed()) await g.revert(action.id);
    expect(g.api.values.has("estimate")).toBe(false);
    expect(g.api.values.get("status")).toEqual({ singleSelectOptionId: "todo" });
  });

  it("does not write on rejection or queue refusal", async () => {
    const g = await setup();
    await g.change(done);
    await g.reject(g.queue.actions[0].id);
    expect(await g.read()).toMatchObject([{ value: { name: "Todo" } }]);
    g.queue.refuse = true;
    await expect(g.change(done)).rejects.toThrow("Action refused");
    expect(await g.read()).toMatchObject([{ value: { name: "Todo" } }]);
    expect(g.api.writes).toEqual([]);
  });

  it("requires observation authorization before disclosing a staged field", async () => {
    const g = await setup();
    g.queue.deny = true;
    await expect(g.change(done)).rejects.toThrow("Observation denied");
    await expect(g.call([{ method: "listProjectFieldDefinitions", args: ["item"] }], true)).rejects.toThrow("Observation denied");
    expect(g.queue.actions).toEqual([]);
    expect(g.api.writes).toEqual([]);
  });

  it("keeps independently private project data hidden from repository-only observers", async () => {
    const g = await setup();
    await unwrap(g.hooks.planningObserver("project-edit", g.props, "observer", g.props.userObjectId));
    g.api.observerAllowed = false;
    await expect(g.change(done)).rejects.toThrow("Observation denied");
    expect(g.queue.observations.at(-1)?.excludeObservers).toEqual(["observer"]);
    expect(g.queue.actions).toEqual([]);
    await g.restart();
    await expect(unwrap(g.hooks.planningObserver("project-edit", g.props, "observer", g.props.userObjectId)))
      .rejects.toThrow("cannot read a GitHub project");
    expect(g.api.writes).toEqual([]);
  });

  it.each(["number", "repositoryId", "kind"] as const)("rejects a foreign issue membership (%s) at staging and apply", async property => {
    const g = await setup();
    await g.change(done);
    if (property === "number") g.api.number = 99;
    if (property === "repositoryId") g.api.repositoryId = 99;
    if (property === "kind") g.api.kind = "PullRequest";
    await expect(g.change(done)).rejects.toThrow("does not belong");
    await expect(g.apply(g.queue.actions[0].id)).rejects.toThrow("does not belong");
    expect(g.api.writes).toEqual([]);
  });

  it("pins the approved project and rejects deleted fields or removed options", async () => {
    const g = await setup();
    await g.change(done);
    const id = g.queue.actions[0].id;
    g.api.projectId = "different-project";
    await expect(g.apply(id)).rejects.toThrow("approved project");
    g.api.projectId = "project";
    g.api.fields = [{ ...status, options: [] }];
    await expect(g.apply(id)).rejects.toThrow("does not belong");
    g.api.fields = [];
    g.api.values.clear();
    await expect(g.apply(id)).rejects.toThrow("Field does not belong");
    expect(g.api.writes).toEqual([]);
  });

  it("finds definitions and previous values past the first 100 fields", async () => {
    const g = await setup();
    const fillers = Array.from({ length: 101 }, (_, i) => ({ id: `f${i}`, name: `Field ${i}`, dataType: "NUMBER" }));
    g.api.fields = [...fillers, status];
    g.api.values = new Map([...fillers.map(field => [field.id, { number: 1 }] as [string, Record<string, unknown>]), ["status", { singleSelectOptionId: "todo" }]]);
    const definitions = await g.call([{ method: "listProjectFieldDefinitions", args: ["item", { resultsPerPage: 100 }] }], true) as GitHubIssueProjectField[];
    expect(definitions).toHaveLength(102);
    await g.change(done);
    await g.apply(g.queue.actions[0].id);
    await g.revert(g.queue.actions[0].id);
    expect(g.api.values.get("status")).toEqual({ singleSelectOptionId: "todo" });
  });

  it("preserves apply-time undo after an earlier rejection", async () => {
    const g = await setup();
    await g.change(done);
    await g.change({ kind: "singleSelect", optionId: "external" });
    await g.reject(g.queue.actions[0].id);
    const id = g.queue.actions[1].id;
    await g.apply(id);
    await g.revert(id);
    expect(g.api.values.get("status")).toEqual({ singleSelectOptionId: "todo" });
  });

  it("recovers from a lost mutation reply after restart without writing twice", async () => {
    const g = await setup();
    await g.change(done);
    const id = g.queue.actions[0].id;
    g.api.loseReply = true;
    await expect(g.apply(id)).rejects.toThrow("Lost mutation reply");
    await g.restart();
    await g.apply(id);
    expect(g.api.writes).toHaveLength(1);
    await g.revert(id);
    expect(g.api.values.get("status")).toEqual({ singleSelectOptionId: "todo" });
  });

  it("reports missing write scope, silent no-ops and partial GraphQL errors", async () => {
    const g = await setup();
    await g.change(done);
    const id = g.queue.actions[0].id;
    g.api.denied = true;
    await expect(g.apply(id)).rejects.toThrow("project write permission");
    g.api.denied = false;
    g.api.ignore = true;
    await expect(g.apply(id)).rejects.toThrow("did not apply");
    g.api.ignore = false;
    g.api.partial = true;
    await expect(g.apply(id)).rejects.toThrow("complete project data");
    g.api.partial = false;
    await g.apply(id);
    expect(g.api.writes).toHaveLength(2);
  });

  it("never overwrites a newer edit during undo or a retry", async () => {
    const g = await setup();
    await g.change(done);
    const id = g.queue.actions[0].id;
    await g.apply(id);
    g.api.values.set("status", { singleSelectOptionId: "external" });
    await expect(g.revert(id)).rejects.toThrow("newer value");
    expect(g.api.writes).toHaveLength(1);
    await g.change(done);
    const retryId = g.queue.actions[1].id;
    g.api.ignore = true;
    await expect(g.apply(retryId)).rejects.toThrow("did not apply");
    g.api.values.set("status", { singleSelectOptionId: "todo" });
    await expect(g.apply(retryId)).rejects.toThrow("newer value");
    expect(g.api.writes).toHaveLength(2);
  });
});
