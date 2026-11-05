import { describe, expect, it } from "vitest";
import { GitHubApi } from "../../src/github-api";
import { discoverProjects, parseProjectUrl, projectFields, projectItem, projectItemFields, projectItems, resolveProject } from "../../src/github-project-api";

const token = process.env.CONTRACT_GITHUB_PROJECT_TOKEN;
const url = process.env.CONTRACT_GITHUB_PROJECT_URL;

if (!!token !== !!url) throw new Error("Set both CONTRACT_GITHUB_PROJECT_TOKEN and CONTRACT_GITHUB_PROJECT_URL.");

/** Explicitly opt-in and read-only: the project and token are separate from the hooks' fixtures. */
describe.skipIf(!token || !url)("GitHub whole-project GraphQL contract", () => {
  it("resolves a project and reads definitions, items, and their values", async () => {
    const locator = parseProjectUrl(url!);
    expect(locator).not.toBeNull();
    const api = new GitHubApi(async () => token!);
    const project = await resolveProject(api, locator!);
    expect(project.id).toBeTruthy();
    const discovery = await discoverProjects(api, locator!.ownerType, locator!.owner, 2);
    expect(discovery.items.length).toBeLessThanOrEqual(2);
    const fields = await projectFields(api, project.id, 2);
    expect(fields.items.every(field => !!field.id && !!field.name && !!field.dataType)).toBe(true);
    const page = await projectItems(api, project.id, 2);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThanOrEqual(2);
    if (page.next) await projectItems(api, project.id, 2, page.next);
    for (const item of page.items) {
      expect((await projectItem(api, project.id, item.id)).id).toBe(item.id);
      const values = await projectItemFields(api, project.id, item.id, 2);
      if (values.next) await projectItemFields(api, project.id, item.id, 2, values.next);
    }
  });
});
