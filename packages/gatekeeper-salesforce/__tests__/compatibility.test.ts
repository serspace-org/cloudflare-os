import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const { TEST_HOOKS } = env;

describe("Salesforce gatekeeper compatibility", () => {
  it("does not expose CRM discovery through the unobserved catalog API", async () => {
    const hooks = TEST_HOOKS.get(TEST_HOOKS.newUniqueId());
    // No schema is initialized: this path must not consult the indexed records at all.
    await expect(hooks.catalog()).resolves.toBeNull();
  });

  it("rejects reconnect commits for an auto-provisioned account", async () => {
    const hooks = TEST_HOOKS.get(TEST_HOOKS.newUniqueId());
    await expect(hooks.commitReconnectMessage()).resolves.toContain("auto-provisioned");
  });
});
