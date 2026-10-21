import { describe, expect, it } from "vitest";
import { GitHubApi } from "../../src/github-api";

describe("README fetch in workerd", () => {
  it("accepts the redirect mode and returns authenticated README text", async () => {
    const api = new GitHubApi(async () => "test-token");
    expect(await api.readReadme("owner", "repo")).toBe("# Runtime README\n");
  });

  it("does not follow a redirect to another host", async () => {
    const api = new GitHubApi(async () => "test-token");
    await expect(api.readReadme("owner", "redirect")).rejects.toMatchObject({ status: 302 });
  });
});
