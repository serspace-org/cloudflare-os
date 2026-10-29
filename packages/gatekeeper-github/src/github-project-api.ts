import type { GitHubApi } from "./github-api";
import { connectionPage, normalizeProjectField, VALUE_FIELDS, type GraphConnection, type ProjectFieldResponse } from "./github-planning";
import type { GitHubProjectEntry, GitHubProjectField, GitHubProjectMetadata } from "./project-types";

/** A project locator; node identity is pinned when the connection is first resolved. */
export type ProjectLocator = { ownerType: "organization" | "user"; owner: string; number: number };

const INFO = "id number title url shortDescription readme closed public";
const PAGE = "pageInfo { hasNextPage endCursor }";
const CONTENT = `__typename
  ... on Issue { number title url repository { databaseId nameWithOwner } }
  ... on PullRequest { number title url repository { databaseId nameWithOwner } }
  ... on DraftIssue { title body }`;
const ITEM = `id isArchived project { id } content { ${CONTENT} }`;
const FIELD = `... on ProjectV2FieldCommon { id name dataType isIssueField }
  ... on ProjectV2SingleSelectField { options { id name } }
  ... on ProjectV2MultiSelectField { options { id name } }
  ... on ProjectV2IterationField { configuration {
    iterations { id title startDate duration } completedIterations { id title startDate duration }
  } }`;

type ProjectItemResponse = {
  id: string; isArchived: boolean; project: { id: string };
  content: { __typename: string; number?: number; title?: string; url?: string; body?: string;
    repository?: { databaseId: number; nameWithOwner: string } } | null;
};

function entry(raw: ProjectItemResponse): GitHubProjectEntry {
  const content = raw.content;
  if (!content) return { id: raw.id, isArchived: raw.isArchived, content: { kind: "redacted" } };
  if (content.__typename === "DraftIssue") {
    return { id: raw.id, isArchived: raw.isArchived,
      content: { kind: "draftIssue", title: content.title!, bodyMarkdown: content.body ?? "" } };
  }
  if (!["Issue", "PullRequest"].includes(content.__typename) || !content.repository) {
    throw new Error("GitHub returned an unsupported project item.");
  }
  return { id: raw.id, isArchived: raw.isArchived, content: {
    kind: content.__typename === "Issue" ? "issue" : "pullRequest",
    number: content.number!, title: content.title!, url: content.url!,
    repository: { id: content.repository.databaseId, nameWithOwner: content.repository.nameWithOwner },
  } };
}

function missing(): never {
  throw new Error("GitHub project is unavailable. Reconnect GitHub with project read permission and check project access.");
}

/** Resolve an organization or user project, without interpreting arbitrary URLs as repositories. */
export async function resolveProject(api: GitHubApi, locator: ProjectLocator): Promise<GitHubProjectMetadata> {
  const result = await api.planningGraphql<{ owner: { projectV2: GitHubProjectMetadata | null } | null }>(
    `query ResolveProject($owner: String!, $number: Int!) {
      owner: ${locator.ownerType}(login: $owner) { projectV2(number: $number) { ${INFO} } }
    }`, { owner: locator.owner, number: locator.number });
  return result.owner?.projectV2 ?? missing();
}

/** Read a pinned project's metadata, never silently substituting another project at its old URL. */
export async function projectMetadata(api: GitHubApi, id: string): Promise<GitHubProjectMetadata> {
  const { node } = await api.planningGraphql<{ node: GitHubProjectMetadata | null }>(
    `query ProjectMetadata($id: ID!) { node(id: $id) { ... on ProjectV2 { ${INFO} } } }`, { id });
  if (!node || node.id !== id) return missing();
  return node;
}

/** One bounded page of project definitions, including options and iteration schedules. */
export async function projectFields(api: GitHubApi, id: string, first: number, after?: string) {
  const { node } = await api.planningGraphql<{ node: { id: string; fields: GraphConnection<GitHubProjectField> } | null }>(
    `query ProjectFields($id: ID!, $first: Int!, $after: String) {
      node(id: $id) { ... on ProjectV2 { id fields(first: $first, after: $after) { ${PAGE} nodes { ${FIELD} } } } }
    }`, { id, first, after });
  if (!node || node.id !== id) return missing();
  return connectionPage(node.fields, after);
}

/** One bounded page of items. Field values are paged separately to avoid nested truncation. */
export async function projectItems(api: GitHubApi, id: string, first: number, after?: string) {
  const { node } = await api.planningGraphql<{ node: { id: string; items: GraphConnection<ProjectItemResponse> } | null }>(
    `query ProjectItems($id: ID!, $first: Int!, $after: String) {
      node(id: $id) { ... on ProjectV2 { id items(first: $first, after: $after, archivedStates: [ARCHIVED, NOT_ARCHIVED]) { ${PAGE} nodes { ${ITEM} } } } }
    }`, { id, first, after });
  if (!node || node.id !== id) return missing();
  const page = connectionPage(node.items, after);
  for (const item of page.items) if (item.project.id !== id) throw new Error("Project item is outside the connected project.");
  return { ...page, items: page.items.map(entry) };
}

/** Revalidate membership when opening an item or reading another page of its fields. */
export async function projectItem(api: GitHubApi, projectId: string, itemId: string): Promise<GitHubProjectEntry> {
  const { project, node } = await api.planningGraphql<{ project: { id: string } | null; node: ProjectItemResponse | null }>(
    `query ProjectItem($id: ID!, $project: ID!) { project: node(id: $project) { ... on ProjectV2 { id } } node(id: $id) { ... on ProjectV2Item { ${ITEM} } } }`, { id: itemId, project: projectId });
  if (project?.id !== projectId) return missing();
  if (!node || node.id !== itemId || node.project.id !== projectId) {
    throw new Error("Project item does not belong to the connected project.");
  }
  return entry(node);
}

/** Read one item's values, with content and project identity from the same GraphQL result. */
export async function projectItemFields(api: GitHubApi, projectId: string, itemId: string, first: number, after?: string) {
  const query = `query ProjectItemFields($item: ID!, $project: ID!, $first: Int!, $after: String) {
    project: node(id: $project) { ... on ProjectV2 { id } }
    node(id: $item) { ... on ProjectV2Item {
      ${ITEM} fieldValues(first: $first, after: $after) { ${PAGE} nodes { ${VALUE_FIELDS} } }
    } }
  }`;
  const { project, node } = await api.planningGraphql<{ project: { id: string } | null; node: (ProjectItemResponse & { fieldValues: GraphConnection<ProjectFieldResponse> }) | null }>(
    query, { item: itemId, project: projectId, first, after });
  if (project?.id !== projectId) return missing();
  if (!node || node.id !== itemId || node.project.id !== projectId) {
    throw new Error("Project item does not belong to the connected project.");
  }
  const page = connectionPage(node.fieldValues, after);
  return { ...page, items: page.items.map(normalizeProjectField), entry: entry(node) };
}

/** Discovery is confined to the configuring account; it creates no broad agent capability. */
export async function discoverProjects(api: GitHubApi, ownerType: ProjectLocator["ownerType"], owner: string, first: number, after?: string) {
  const result = await api.planningGraphql<{ owner: { projectsV2: GraphConnection<GitHubProjectMetadata> } | null }>(
    `query DiscoverProjects($owner: String!, $first: Int!, $after: String) {
      owner: ${ownerType}(login: $owner) { projectsV2(first: $first, after: $after) { ${PAGE} nodes { ${INFO} } } }
    }`, { owner, first, after });
  if (!result.owner) return missing();
  return connectionPage(result.owner.projectsV2, after);
}

/** Parse only canonical project URLs (plus project view suffixes), refusing malformed locators. */
export function parseProjectUrl(input: string): ProjectLocator | null {
  const url = URL.parse(input);
  if (url?.origin !== "https://github.com" || url.username || url.password) return null;
  const match = /^\/(orgs|users)\/([A-Za-z0-9][A-Za-z0-9-]*)\/projects\/([1-9]\d*)(?:\/views\/[1-9]\d*)?\/?$/.exec(url.pathname);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number > 2147483647) return null;
  return { ownerType: match[1] === "orgs" ? "organization" : "user", owner: match[2], number };
}
