/** The owner to browse and the selected project URL. */
export type GitHubProjectConfiguratorValues = {
  owner?: string | null;
  ownerType?: string | null;
  projectUrl?: string | null;
};

/** A project shown in the connection picker. */
export type ProjectChoice = {
  id: string; title: string; kind: "leaf"; subtitle?: string; badge?: string;
};

/** Read-only discovery for the connecting user; never bound into an agent's environment. */
export interface GitHubProjectConfiguratorRpc {
  listProjects(ownerType: "organization" | "user", owner: string, cursor?: string | null):
    Promise<{ items: ProjectChoice[]; nextCursor?: string }>;
  getProject(url: string): Promise<ProjectChoice>;
}
