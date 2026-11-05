/** Read access to one GitHub Project (v2), including its draft and archived items.
 * Requires project read permission. Reconnect GitHub if project access is denied.
 * All cursors must be disposed and read until next() returns null, even after empty pages.
 */
export interface GitHubProject {
  /** Read the project's title, description and README. */
  getMetadata(): Promise<GitHubProjectMetadata>;
  /** List field definitions, including selectable options and iteration schedules. */
  listFields(options?: GitHubProjectPageOptions): Promise<GitHubProjectCursor<GitHubProjectField>>;
  /** List project items, including archived items by default. Inaccessible content is redacted. */
  listItems(options?: GitHubProjectItemFilter): Promise<GitHubProjectCursor<GitHubProjectEntry>>;
  /** Read one item. Throws if it no longer belongs to this project. */
  getItem(itemId: string): Promise<GitHubProjectEntry>;
  /** Read populated values for one item. Membership is checked on every page. */
  listItemFields(itemId: string, options?: GitHubProjectPageOptions): Promise<GitHubProjectCursor<GitHubProjectValue>>;
}

/** One page at a time; null means exhausted, while an empty array may have later pages. */
export interface GitHubProjectCursor<T> { next(): Promise<T[] | null>; }

/** Page size is a positive integer, capped at 100. */
export type GitHubProjectPageOptions = { resultsPerPage?: number };

/** Project identity and descriptive information. */
export type GitHubProjectMetadata = {
  id: string;
  number: number;
  title: string;
  url: string;
  shortDescription: string | null;
  readme: string | null;
  closed: boolean;
  public: boolean;
};

/** A field definition. Options and iteration schedules are present on their respective field types. */
export type GitHubProjectField = {
  id: string;
  name: string;
  dataType: string;
  options?: { id: string; name: string }[];
  configuration?: {
    iterations: GitHubProjectIteration[];
    completedIterations: GitHubProjectIteration[];
  };
};

/** A scheduled or completed project iteration; startDate is YYYY-MM-DD. */
export type GitHubProjectIteration = { id: string; title: string; startDate: string; duration: number };

/** One project item. Linked issues and PRs give URLs; connect them separately for full details or edits. */
export type GitHubProjectEntry = {
  id: string;
  isArchived: boolean;
  content:
    | { kind: "issue" | "pullRequest"; number: number; title: string; url: string;
        repository: { id: number; nameWithOwner: string } }
    | { kind: "draftIssue"; title: string; bodyMarkdown: string }
    | { kind: "redacted" };
};

/** Optional filters; both active and archived items and all content kinds are included by default. */
export type GitHubProjectItemFilter = GitHubProjectPageOptions & {
  isArchived?: boolean;
  kind?: "issue" | "pullRequest" | "draftIssue" | "redacted";
};

/** A populated project field. Date-only values use YYYY-MM-DD strings. */
export type GitHubProjectValue = {
  field: { id: string; name: string; dataType: string } | null;
  value:
    | { kind: "text"; text: string | null }
    | { kind: "number"; number: number | null }
    | { kind: "date"; date: string | null }
    | { kind: "singleSelect"; optionId: string | null; name: string | null }
    | { kind: "multiSelect"; options: { id: string; name: string }[] }
    | { kind: "iteration"; iterationId: string; title: string; startDate: string; duration: number }
    /** Built-in fields derived from the issue/PR; open the linked issue or PR for their full values. */
    | { kind: "issueProperty"; property: "labels" | "assignees" | "milestone" | "repo" }
    /** A GitHub field type whose value this API does not yet decode. */
    | { kind: "unsupported"; type: string };
};

