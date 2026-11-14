import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/**
 * No `vars`: SALESFORCE_LOGIN_URL defaults to https://login.salesforce.com in code, so an
 * unconfigured deployment authorizes against Salesforce production. A deployment that connects
 * sandboxes instead sets it to https://test.salesforce.com per deployment. Each account's API
 * calls go to the `instance_url` its own token grant reported, never to a configured host.
 */
export default defineGadgetsWorker({
  name: "gatekeeper-salesforce",
  entrypoint: ".wrangler/validate/src/salesforce.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "SalesforceGatekeeperImpl"] },
];
