import { DurableObject, RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { observerAccessVerifier, type VerifyObserverAccess } from "@gadgets/gatekeeper-kit/observers";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import { withAccountApi, type GitHubApi } from "./github-api";
import type { GitHubVerifierApi } from "./github";
import type { Env } from "./github-env";
import { PlanningCursor } from "./github-planning-cursor";
import { projectFields, projectItem, projectItemFields, projectItems, projectMetadata, resolveProject, type ProjectLocator } from "./github-project-api";
import type { GitHubProjectCursor as Cursor, GitHubProjectPageOptions as GitHubPageOptions, GitHubProject, GitHubProjectEntry, GitHubProjectField, GitHubProjectValue as GitHubProjectFieldValue, GitHubProjectItemFilter, GitHubProjectMetadata } from "./project-types";
import PROJECT_TYPES from "./project-types.txt";

/** Project capability props carry a locator, never authority to its owner's other projects. */
export type GitHubProjectProps = ProjectLocator & { userObjectId: string };

/** Repository content in a project has its own ACL, independent of the board's visibility. */
export function projectEntrySubresources(entries: GitHubProjectEntry[]): string[] {
  return [...new Set(entries.flatMap(({ content }) =>
    content.kind === "issue" || content.kind === "pullRequest"
      ? [formatSubresourceId({ fragments: [{ name: "repository", id: String(content.repository.id) }] })]
      : []))];
}

/** Verify every project and repository dependency reported by a project read. */
export const verifyProjectObservers: VerifyObserverAccess = observerAccessVerifier<GitHubVerifierApi>({
  hasCollectionAccess: async (verifier, ids) => Promise.all(ids.map(id => {
    const parsed = parseSubresourceId(id);
    const [resource] = parsed.fragments;
    if (parsed.namespace || parsed.fragments.length !== 1) throw new Error("Unknown GitHub project subresource.");
    if (resource.name === "project") return verifier.hasProjectAccess(resource.id);
    if (resource.name !== "repository" || !/^[1-9]\d*$/.test(resource.id) || !Number.isSafeInteger(Number(resource.id))) {
      throw new Error("Unknown GitHub project subresource.");
    }
    return verifier.hasRepoAccess(Number(resource.id));
  })),
});

/** A read-only, single-project binding. Repository disclosures are checked per observation. */
@validateRpc()
export class GitHubProjectGatekeeper extends DurableObject<Env, GitHubProjectProps> implements Gatekeeper<GitHubProject> {
  #identity?: Promise<string>;

  async #read<T>(fn: (api: GitHubApi) => Promise<T>): Promise<T> {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return withAccountApi(account, fn, { replayable: true });
  }

  async #id(): Promise<string> {
    const stored = this.ctx.storage.kv.get<string>("projectId");
    if (stored) return stored;
    this.#identity ??= this.#read(api => resolveProject(api, this.ctx.props)).then(project => {
      this.ctx.storage.kv.put("projectId", project.id);
      return project.id;
    }).catch(error => { this.#identity = undefined; throw error; });
    return this.#identity;
  }

  async projectId(): Promise<string> { return this.#id(); }

  async metadata(): Promise<GitHubProjectMetadata> {
    const id = await this.#id();
    return this.#read(api => projectMetadata(api, id));
  }

  async describe() {
    const project = await this.metadata();
    return { url: project.url, title: project.title, snippet: project.shortDescription ?? "GitHub Project",
      suggestedBindingName: "GITHUB_PROJECT", tsType: "GitHubProject" };
  }

  async getTypeScriptTypes(): Promise<string> { return PROJECT_TYPES; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }

  async startSession(queue: RpcStub<ApprovalQueue>): Promise<GitHubProject> {
    await this.metadata();
    return new GitHubProjectSession(this, queue.dup());
  }

  async fields(first: number, after?: string) {
    const id = await this.#id();
    return this.#read(api => projectFields(api, id, first, after));
  }

  async items(first: number, after?: string) {
    const id = await this.#id();
    return this.#read(api => projectItems(api, id, first, after));
  }

  async item(itemId: string) {
    const id = await this.#id();
    return this.#read(api => projectItem(api, id, itemId));
  }

  async itemFields(itemId: string, first: number, after?: string) {
    const id = await this.#id();
    return this.#read(api => projectItemFields(api, id, itemId, first, after));
  }

  async getHistoricalSubresources(): Promise<string[]> { return []; }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(...args: Parameters<VerifyObserverAccess>) {
    return verifyProjectObservers(...args);
  }

  async applyAction(_action: number): Promise<void> { throw new Error("GitHub project connections are read-only."); }
  async rejectAction(_action: number): Promise<void> { throw new Error("GitHub project connections are read-only."); }
  async revertAction(_action: number): Promise<{ message: string; canRetry: boolean }> {
    throw new Error("GitHub project connections are read-only.");
  }
}

function pageSize(options?: GitHubPageOptions): number {
  const size = options?.resultsPerPage ?? 50;
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("resultsPerPage must be a positive integer.");
  return Math.min(size, 100);
}

@validateRpc()
export class GitHubProjectSession extends RpcTarget implements GitHubProject {
  constructor(private readonly gatekeeper: GitHubProjectGatekeeper, private readonly queue: RpcStub<ApprovalQueue>) { super(); }

  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }

  async #observe(title: string, entries: GitHubProjectEntry[] = [], queue = this.queue): Promise<void> {
    const projectId = await this.gatekeeper.projectId();
    const description: ObservationDescription & { subresources: string[] } = {
      title, description: title, subresources: [
        formatSubresourceId({ fragments: [{ name: "project", id: projectId }] }),
        ...projectEntrySubresources(entries),
      ],
    };
    await queue.authorizeObservation(description);
  }

  async getMetadata(): Promise<GitHubProjectMetadata> {
    const value = await this.gatekeeper.metadata();
    await this.#observe("Read GitHub project metadata");
    return value;
  }

  async listFields(options?: GitHubPageOptions): Promise<Cursor<GitHubProjectField>> {
    const size = pageSize(options);
    const queue = this.queue.dup();
    return new PlanningCursor(async after => {
      const page = await this.gatekeeper.fields(size, after);
      await this.#observe("Read GitHub project field definitions", [], queue);
      return page;
    }, () => queue[Symbol.dispose]());
  }

  async listItems(options?: GitHubProjectItemFilter): Promise<Cursor<GitHubProjectEntry>> {
    const size = pageSize(options);
    const queue = this.queue.dup();
    return new PlanningCursor(async after => {
      const page = await this.gatekeeper.items(size, after);
      const items = page.items.filter(item =>
        (options?.isArchived === undefined || item.isArchived === options.isArchived) &&
        (options?.kind === undefined || item.content.kind === options.kind));
      await this.#observe("Read GitHub project items", items, queue);
      return { ...page, items };
    }, () => queue[Symbol.dispose]());
  }

  async getItem(itemId: string): Promise<GitHubProjectEntry> {
    const value = await this.gatekeeper.item(itemId);
    await this.#observe("Read a GitHub project item", [value]);
    return value;
  }

  async listItemFields(itemId: string, options?: GitHubPageOptions): Promise<Cursor<GitHubProjectFieldValue>> {
    const size = pageSize(options);
    const queue = this.queue.dup();
    return new PlanningCursor(async after => {
      const { entry, ...page } = await this.gatekeeper.itemFields(itemId, size, after);
      await this.#observe("Read GitHub project item fields", [entry], queue);
      return page;
    }, () => queue[Symbol.dispose]());
  }
}
