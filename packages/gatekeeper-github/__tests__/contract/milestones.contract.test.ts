import { describe, expect, it } from "vitest";
import { GitHubApi } from "../../src/github-api";

const token = process.env.CONTRACT_GITHUB_TOKEN;
const repository = process.env.CONTRACT_GITHUB_REPO;

/** Read-only checks: use an existing milestone when available, without creating fixtures. */
describe.skipIf(!token || !repository)("GitHub milestone reads", () => {
  it("lists milestones and reads the same milestone by its number", async () => {
    const api = new GitHubApi(async () => token!);
    const [owner, repo] = repository!.split("/");
    const milestones = await api.listMilestones(owner, repo, { state: "all" }, 1, 10);
    for (const milestone of milestones) {
      expect(milestone.createdAt).toBeInstanceOf(Date);
      expect(milestone.openIssues).toBeGreaterThanOrEqual(0);
    }
    if (milestones.length) {
      const first = milestones[0];
      expect(await api.getMilestone(owner, repo, first.number)).toMatchObject({ number: first.number, title: first.title });
      const issues = await api.listIssues(owner, repo, { milestone: first.number, state: "all", per_page: 10, page: 1 });
      expect(issues.every(issue => issue.milestone?.number === first.number)).toBe(true);
    }
  });
});
