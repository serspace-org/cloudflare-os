// Test-harness worker exposing the Salesforce gatekeeper source under the Workers test
// runtime, with the SF_DB D1 binding available.

export { default } from "../src/index.js";
export {
  GatekeeperVendor, SalesforceAccount, SalesforceVerifier, SalesforceGatekeeper,
} from "../src/salesforce-gatekeeper.js";
export { SalesforceSyncWorkflow } from "../src/sync-workflow.js";

// Re-export the D1 store so integration tests can exercise it against a real local D1 database.
export * from "../src/sf-store.js";

import { DurableObject } from "cloudflare:workers";
import type { SalesforceGatekeeper } from "../src/salesforce-gatekeeper.js";

/** Exercise props-bound capabilities through the same facets the Workshop uses. */
export class TestHooks extends DurableObject<Cloudflare.Env> {
  async catalog(): Promise<null> {
    const gatekeeper = this.ctx.facets.get<SalesforceGatekeeper>("salesforce", () => ({
      class: this.ctx.exports.SalesforceGatekeeper({ props: { accountId: "test-account" } }),
    }));
    return gatekeeper.getAgentCatalog();
  }

  async commitReconnectMessage(): Promise<string | null> {
    const account = this.ctx.exports.SalesforceAccount({ props: { accountId: "test-account" } });
    try {
      await account.commitReconnect("unused-stage");
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
