import type { GitHubMilestone, GitHubProjectFieldValue, GitHubProjectItem } from "./types";

/** REST milestone shape shared by issue, pull request and milestone endpoints. */
export type MilestoneResponse = {
  number: number; title: string; description: string | null; html_url: string;
  state: "open" | "closed"; open_issues: number; closed_issues: number;
  created_at: string; updated_at: string; due_on: string | null; closed_at: string | null;
};

export function normalizeMilestone(value: MilestoneResponse): GitHubMilestone {
  return {
    number: value.number, title: value.title, description: value.description ?? "", url: value.html_url,
    state: value.state, openIssues: value.open_issues, closedIssues: value.closed_issues,
    createdAt: new Date(value.created_at), updatedAt: new Date(value.updated_at),
    dueOn: value.due_on ? new Date(value.due_on) : null,
    closedAt: value.closed_at ? new Date(value.closed_at) : null,
  };
}

/** One bounded page; absence of next means exhaustion, even for a full page. */
export type PlanningPage<T> = { items: T[]; next?: string };
export type GraphConnection<T> = {
  nodes: (T | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export function connectionPage<T>(connection: GraphConnection<T>, after?: string): PlanningPage<T> {
  const { hasNextPage, endCursor } = connection.pageInfo;
  if (hasNextPage && (!endCursor || endCursor === after)) {
    throw new Error("GitHub returned an invalid pagination cursor.");
  }
  return {
    items: connection.nodes.filter((node): node is T => node !== null),
    next: hasNextPage ? endCursor! : undefined,
  };
}

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const PROJECT_ITEM = `id isArchived project { id number title url shortDescription closed public }`;

export const ISSUE_PROJECTS_QUERY = `query IssueProjects($repo: ID!, $number: Int!, $first: Int!, $after: String) {
  node(id: $repo) { ... on Repository {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { projectItems(first: $first, after: $after, includeArchived: true) {
        ${PAGE_INFO} nodes { ${PROJECT_ITEM} }
      } }
      ... on PullRequest { projectItems(first: $first, after: $after, includeArchived: true) {
        ${PAGE_INFO} nodes { ${PROJECT_ITEM} }
      } }
    }
  } }
}`;

export type IssueProjectsResponse = {
  node: { issueOrPullRequest: {
    __typename: "Issue" | "PullRequest";
    projectItems: GraphConnection<GitHubProjectItem>;
  } | null } | null;
};

const FIELD = "field { ... on ProjectV2FieldCommon { id name dataType } }";
const VALUE_FIELDS = `
  __typename
  ... on ProjectV2ItemFieldTextValue { ${FIELD} text }
  ... on ProjectV2ItemFieldNumberValue { ${FIELD} number }
  ... on ProjectV2ItemFieldDateValue { ${FIELD} date }
  ... on ProjectV2ItemFieldSingleSelectValue { ${FIELD} optionId name }
  ... on ProjectV2ItemFieldMultiSelectValue { ${FIELD} options { id name } }
  ... on ProjectV2ItemFieldIterationValue { ${FIELD} iterationId title startDate duration }
  ... on ProjectV2ItemFieldLabelValue { ${FIELD} }
  ... on ProjectV2ItemFieldUserValue { ${FIELD} }
  ... on ProjectV2ItemFieldMilestoneValue { ${FIELD} }
  ... on ProjectV2ItemFieldRepositoryValue { ${FIELD} }
  ... on ProjectV2ItemFieldPullRequestValue { ${FIELD} }
  ... on ProjectV2ItemFieldReviewerValue { ${FIELD} }
  ... on ProjectV2ItemIssueFieldValue { ${FIELD} }
`;

export const PROJECT_FIELDS_QUERY = `query IssueProjectFields($item: ID!, $first: Int!, $after: String) {
  node(id: $item) { ... on ProjectV2Item {
    project { id }
    content {
      __typename
      ... on Issue { number repository { databaseId } }
      ... on PullRequest { number repository { databaseId } }
    }
    fieldValues(first: $first, after: $after) { ${PAGE_INFO} nodes { ${VALUE_FIELDS} } }
  } }
}`;

/** Only fields selected by PROJECT_FIELDS_QUERY; never forward arbitrary upstream objects. */
export type ProjectFieldResponse = {
  __typename: string;
  field?: GitHubProjectFieldValue["field"];
  text?: string | null; number?: number | null; date?: string | null;
  optionId?: string | null; name?: string | null;
  options?: { id: string; name: string }[] | null;
  iterationId?: string; title?: string; startDate?: string; duration?: number;
};

export type ProjectFieldsResponse = {
  node: {
    project: { id: string };
    content: {
      __typename: string; number?: number; repository?: { databaseId: number };
    } | null;
    fieldValues: GraphConnection<ProjectFieldResponse>;
  } | null;
};

export function normalizeProjectField(raw: ProjectFieldResponse): GitHubProjectFieldValue {
  let value: GitHubProjectFieldValue["value"];
  switch (raw.__typename) {
    case "ProjectV2ItemFieldTextValue": value = { kind: "text", text: raw.text ?? null }; break;
    case "ProjectV2ItemFieldNumberValue": value = { kind: "number", number: raw.number ?? null }; break;
    case "ProjectV2ItemFieldDateValue": value = { kind: "date", date: raw.date ?? null }; break;
    case "ProjectV2ItemFieldSingleSelectValue":
      value = { kind: "singleSelect", optionId: raw.optionId ?? null, name: raw.name ?? null }; break;
    case "ProjectV2ItemFieldMultiSelectValue":
      value = { kind: "multiSelect", options: raw.options ?? [] }; break;
    case "ProjectV2ItemFieldIterationValue":
      value = { kind: "iteration", iterationId: raw.iterationId!, title: raw.title!,
        startDate: raw.startDate!, duration: raw.duration! }; break;
    case "ProjectV2ItemFieldLabelValue": value = { kind: "issueProperty", property: "labels" }; break;
    case "ProjectV2ItemFieldUserValue": value = { kind: "issueProperty", property: "assignees" }; break;
    case "ProjectV2ItemFieldMilestoneValue": value = { kind: "issueProperty", property: "milestone" }; break;
    case "ProjectV2ItemFieldRepositoryValue": value = { kind: "issueProperty", property: "repo" }; break;
    default: value = { kind: "unsupported", type: raw.__typename };
  }
  return { field: raw.field ?? null, value };
}
