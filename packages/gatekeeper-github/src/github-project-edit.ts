import type { GitHubApi } from "./github-api";
import { projectFields } from "./github-project-api";
import type { GitHubIssueProjectField, GitHubProjectFieldInput, GitHubProjectFieldValue } from "./types";

const KINDS: Record<string, GitHubProjectFieldInput["kind"]> = {
  TEXT: "text", NUMBER: "number", DATE: "date", SINGLE_SELECT: "singleSelect",
  MULTI_SELECT: "multiSelect", ITERATION: "iteration",
};

/** Validate and reconstruct inputs; never pass an arbitrary caller object to GraphQL. */
export function validateProjectInput(field: GitHubIssueProjectField,
  value: GitHubProjectFieldInput | null): GitHubProjectFieldInput | null {
  if (field.isIssueField || !KINDS[field.dataType]) {
    throw new Error("This is a derived, organization issue, or read-only field. Use the issue's setTitle, setMilestone, setAssignees or label methods where applicable.");
  }
  if (value === null) return null;
  if (!value || value.kind !== KINDS[field.dataType]) throw new Error("Project value kind does not match the field data type.");
  const nonempty = (id: string) => typeof id === "string" && id.length > 0;
  switch (value.kind) {
    case "text":
      if (typeof value.text !== "string") throw new Error("Project text must be a string.");
      return { kind: "text", text: value.text };
    case "number":
      if (typeof value.number !== "number" || !Number.isFinite(value.number)) throw new Error("Project number must be finite.");
      return { kind: "number", number: value.number };
    case "date":
      if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
          !Number.isFinite(Date.parse(value.date)) || new Date(value.date).toISOString().slice(0, 10) !== value.date) {
        throw new Error("Project date must be a valid YYYY-MM-DD date.");
      }
      return { kind: "date", date: value.date };
    case "singleSelect":
      if (!nonempty(value.optionId) || !field.options?.some(option => option.id === value.optionId)) {
        throw new Error("Select option does not belong to this project field.");
      }
      return { kind: "singleSelect", optionId: value.optionId };
    case "multiSelect": {
      if (!Array.isArray(value.optionIds) || value.optionIds.some(id => !nonempty(id) || !field.options?.some(option => option.id === id))) {
        throw new Error("Select options do not belong to this project field.");
      }
      const optionIds = [...new Set(value.optionIds)].toSorted();
      return optionIds.length ? { kind: "multiSelect", optionIds } : null;
    }
    case "iteration":
      if (!nonempty(value.iterationId) || ![...(field.configuration?.iterations ?? []),
        ...(field.configuration?.completedIterations ?? [])].some(iteration => iteration.id === value.iterationId)) {
        throw new Error("Iteration does not belong to this project field.");
      }
      return { kind: "iteration", iterationId: value.iterationId };
  }
}

/** Convert only losslessly decoded values, so undo never guesses at unsupported provider data. */
export function projectInput(value: GitHubProjectFieldValue["value"] | undefined): GitHubProjectFieldInput | null {
  if (!value) return null;
  switch (value.kind) {
    case "text": return value.text === null ? null : { kind: "text", text: value.text };
    case "number": return value.number === null ? null : { kind: "number", number: value.number };
    case "date": return value.date === null ? null : { kind: "date", date: value.date };
    case "singleSelect": return value.optionId === null ? null : { kind: "singleSelect", optionId: value.optionId };
    case "multiSelect": return value.options.length ? { kind: "multiSelect", optionIds: value.options.map(option => option.id).toSorted() } : null;
    case "iteration": return { kind: "iteration", iterationId: value.iterationId };
    default: throw new Error("This project field value cannot be safely edited or restored.");
  }
}

export function sameProjectInput(a: GitHubProjectFieldInput | null, b: GitHubProjectFieldInput | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Full pagination is necessary for unset fields and for fields beyond the first 100. */
export async function issueProjectValues(api: GitHubApi, number: number, kind: "issue" | "pull", itemId: string) {
  const values: GitHubProjectFieldValue[] = [];
  let after: string | undefined;
  let projectId: string | undefined;
  do {
    const page = await api.listIssueProjectFields(number, kind, itemId, 100, after);
    if (projectId && projectId !== page.projectId) throw new Error("Project membership changed while reading fields.");
    projectId = page.projectId;
    values.push(...page.items);
    after = page.next;
  } while (after);
  return { projectId: projectId!, values };
}

export async function issueProjectField(api: GitHubApi, projectId: string, fieldId: string): Promise<GitHubIssueProjectField> {
  let after: string | undefined;
  do {
    const page = await projectFields(api, projectId, 100, after);
    const field = page.items.find(field => field.id === fieldId);
    if (field) return field;
    after = page.next;
  } while (after);
  throw new Error("Field does not belong to this project.");
}

export function projectFieldValue(field: GitHubIssueProjectField, input: GitHubProjectFieldInput): GitHubProjectFieldValue {
  let value: GitHubProjectFieldValue["value"];
  switch (input.kind) {
    case "text": value = input; break;
    case "number": value = input; break;
    case "date": value = input; break;
    case "singleSelect": value = { ...input, name: field.options?.find(option => option.id === input.optionId)?.name ?? null }; break;
    case "multiSelect": value = { kind: "multiSelect", options: input.optionIds.map(id => ({ id, name: field.options?.find(option => option.id === id)?.name ?? id })) }; break;
    case "iteration": {
      const iteration = [...(field.configuration?.iterations ?? []), ...(field.configuration?.completedIterations ?? [])]
        .find(iteration => iteration.id === input.iterationId);
      if (!iteration) throw new Error("Iteration no longer exists in the project field.");
      value = { kind: "iteration", iterationId: iteration.id, title: iteration.title, startDate: iteration.startDate, duration: iteration.duration };
      break;
    }
  }
  return { field: { id: field.id, name: field.name, dataType: field.dataType }, value };
}

/** Mutations use fixed queries and only validated scalar input, never caller-supplied GraphQL. */
export async function writeProjectField(api: GitHubApi, projectId: string, itemId: string, fieldId: string,
  value: GitHubProjectFieldInput | null): Promise<void> {
  const input = { projectId, itemId, fieldId };
  const key = value === null ? "clearProjectV2ItemFieldValue" : "updateProjectV2ItemFieldValue";
  let payload: Record<string, unknown> = input;
  if (value !== null) {
    let fieldValue: Record<string, unknown>;
    switch (value.kind) {
      case "text": fieldValue = { text: value.text }; break;
      case "number": fieldValue = { number: value.number }; break;
      case "date": fieldValue = { date: value.date }; break;
      case "singleSelect": fieldValue = { singleSelectOptionId: value.optionId }; break;
      case "multiSelect": fieldValue = { multiSelectOptionIds: value.optionIds }; break;
      case "iteration": fieldValue = { iterationId: value.iterationId }; break;
    }
    payload = { ...input, value: fieldValue };
  }
  const type = value === null ? "ClearProjectV2ItemFieldValueInput" : "UpdateProjectV2ItemFieldValueInput";
  const result = await api.planningGraphql<Record<string, { projectV2Item: { id: string } | null } | null>>(
    `mutation EditIssueProjectField($input: ${type}!) { ${key}(input: $input) { projectV2Item { id } } }`,
    { input: payload }, true);
  if (result[key]?.projectV2Item?.id !== itemId) throw new Error("GitHub did not confirm the project field change.");
}
