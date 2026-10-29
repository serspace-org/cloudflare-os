import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github-api";
import { projectFieldValue, projectInput, sameProjectInput, validateProjectInput, writeProjectField } from "../src/github-project-edit";
import type { GitHubIssueProjectField, GitHubProjectFieldInput } from "../src/types";

const iteration = { id: "sprint", title: "Sprint 1", startDate: "2026-01-01", duration: 14 };
const fields: [GitHubIssueProjectField, GitHubProjectFieldInput, Record<string, unknown>][] = [
  [{ id: "text", name: "Notes", dataType: "TEXT" }, { kind: "text", text: "" }, { text: "" }],
  [{ id: "number", name: "Estimate", dataType: "NUMBER" }, { kind: "number", number: 0 }, { number: 0 }],
  [{ id: "date", name: "Target", dataType: "DATE" }, { kind: "date", date: "2028-02-29" }, { date: "2028-02-29" }],
  [{ id: "status", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "done", name: "Done" }] },
    { kind: "singleSelect", optionId: "done" }, { singleSelectOptionId: "done" }],
  [{ id: "multi", name: "Teams", dataType: "MULTI_SELECT", options: [{ id: "eng", name: "Engineering" }] },
    { kind: "multiSelect", optionIds: ["eng"] }, { multiSelectOptionIds: ["eng"] }],
  [{ id: "iteration", name: "Sprint", dataType: "ITERATION", configuration: { iterations: [], completedIterations: [iteration] } },
    { kind: "iteration", iterationId: "sprint" }, { iterationId: "sprint" }],
];

afterEach(() => vi.unstubAllGlobals());

describe("editable project values", () => {
  it.each(fields)("validates and round-trips $name", (field, value) => {
    const input = validateProjectInput(field, value)!;
    expect(projectInput(projectFieldValue(field, input).value)).toEqual(input);
    expect(validateProjectInput(field, null)).toBeNull();
  });

  it.each(fields)("writes one typed scalar payload for $name", async (field, value, payload) => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item" } } } }));
    vi.stubGlobal("fetch", fetch);
    await writeProjectField(new GitHubApi(async () => "test-token"), "project", "item", field.id, validateProjectInput(field, value));
    const request = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(request.query).toContain("mutation EditIssueProjectField");
    expect(request.variables.input).toEqual({ projectId: "project", itemId: "item", fieldId: field.id, value: payload });
  });

  it("uses clear rather than a null scalar or empty value object", async () => {
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.query).toContain("clearProjectV2ItemFieldValue");
      expect(body.variables.input).toEqual({ projectId: "project", itemId: "item", fieldId: "status" });
      return Response.json({ data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: "item" } } } });
    });
    await writeProjectField(new GitHubApi(async () => "token"), "project", "item", "status", null);
  });

  it("rejects invalid types, dates, numbers, options and iterations", () => {
    expect(() => validateProjectInput(fields[0][0], { kind: "number", number: 1 })).toThrow("kind");
    for (const number of [NaN, Infinity, -Infinity]) expect(() => validateProjectInput(fields[1][0], { kind: "number", number })).toThrow("finite");
    for (const date of ["2026-02-29", "2026-13-01", "tomorrow", "2026-01-01T00:00:00Z"]) {
      expect(() => validateProjectInput(fields[2][0], { kind: "date", date })).toThrow("YYYY-MM-DD");
    }
    expect(() => validateProjectInput(fields[3][0], { kind: "singleSelect", optionId: "foreign" })).toThrow("does not belong");
    expect(() => validateProjectInput(fields[4][0], { kind: "multiSelect", optionIds: ["foreign"] })).toThrow("do not belong");
    expect(() => validateProjectInput(fields[5][0], { kind: "iteration", iterationId: "foreign" })).toThrow("does not belong");
  });

  it("normalizes multi-select sets and clears empty sets", () => {
    const field = { ...fields[4][0], options: [{ id: "b", name: "B" }, { id: "a", name: "A" }] };
    expect(validateProjectInput(field, { kind: "multiSelect", optionIds: [] })).toBeNull();
    const normalized = validateProjectInput(field, { kind: "multiSelect", optionIds: ["b", "a", "b"] });
    expect(sameProjectInput(normalized, { kind: "multiSelect", optionIds: ["a", "b"] })).toBe(true);
  });

  it.each(["MILESTONE", "ASSIGNEES", "TITLE", "LABELS", "REPOSITORY", "SUB_ISSUES_PROGRESS", "ISSUE_TYPE"])("rejects derived %s even when clearing", dataType => {
    expect(() => validateProjectInput({ id: "f", name: dataType, dataType }, null)).toThrow("read-only");
  });

  it("refuses organization issue fields rather than modifying a different resource", () => {
    expect(() => validateProjectInput({ ...fields[0][0], isIssueField: true }, null)).toThrow("organization issue");
    expect(() => projectInput({ kind: "unsupported", type: "FutureType" })).toThrow("safely");
  });

  it("surfaces partial GraphQL data and missing write scopes as errors", async () => {
    const api = new GitHubApi(async () => "token");
    vi.stubGlobal("fetch", async () => Response.json({ data: { updateProjectV2ItemFieldValue: null }, errors: [{ type: "INSUFFICIENT_SCOPES" }] }));
    await expect(writeProjectField(api, "p", "i", "f", fields[0][1])).rejects.toThrow("project write permission");
    vi.stubGlobal("fetch", async () => Response.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "other" } } } }));
    await expect(writeProjectField(api, "p", "i", "f", fields[0][1])).rejects.toThrow("did not confirm");
  });
});
