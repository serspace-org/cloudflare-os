// Salesforce gatekeeper worker entrypoint. Exports the durable sync workflow class and the
// capnweb-validate gatekeeper classes; the worker itself is reached over RPC/Workflows, not HTTP.

export { SalesforceSyncWorkflow } from "./sync-workflow.js";
export { SalesforceGatekeeper } from "./salesforce-gatekeeper.js";
export {
  GatekeeperVendor, SalesforceAccount, SalesforceVerifier,
} from "./salesforce-gatekeeper.js";

/** Serve a plain health response; application access uses RPC and Workflows. */
export default {
  async fetch(): Promise<Response> {
    return new Response("Salesforce gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
