import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { GitHubApiRunner } from "./github-configurators";
import { discoverProjects, parseProjectUrl, resolveProject } from "./github-project-api";
import type { GitHubProjectConfiguratorRpc, ProjectChoice } from "./configurator/github-project-configurator-types";
import type { GitHubProjectMetadata } from "./project-types";

function choice(project: GitHubProjectMetadata): ProjectChoice {
  return { id: project.url, title: `#${project.number} ${project.title}`, kind: "leaf",
    subtitle: project.shortDescription ?? undefined, badge: project.closed ? "Closed" : "Open" };
}

@validateRpc()
export class GitHubProjectConfiguratorUI extends RpcTarget implements GitHubProjectConfiguratorRpc {
  constructor(private readonly read: GitHubApiRunner) { super(); }

  async listProjects(ownerType: "organization" | "user", owner: string, cursor?: string | null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) throw new Error("Enter a GitHub organization or user login.");
    const page = await this.read(api => discoverProjects(api, ownerType, owner, 50, cursor ?? undefined));
    return { items: page.items.map(choice), nextCursor: page.next };
  }

  async getProject(url: string): Promise<ProjectChoice> {
    const locator = parseProjectUrl(url);
    if (!locator) throw new Error("Enter a GitHub organization or user project URL.");
    return choice(await this.read(api => resolveProject(api, locator)));
  }
}
