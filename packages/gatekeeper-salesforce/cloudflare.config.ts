import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-salesforce",
  entrypoint: ".wrangler/validate/src/index.ts",
  compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
  env: {
    SF_DB: bindings.d1({ name: "salesforce-vector-store", id: "$D1_SF_DB_ID" }),
    SF_INDEX: bindings.vectorize({ name: "salesforce-index" }),
    AI: bindings.ai(),
    SF_SYNC: bindings.workflow({
      name: "sf-sync", worker: "gatekeeper-salesforce", exportName: "SalesforceSyncWorkflow",
    }),
  },
  exports: {
    SalesforceSyncWorkflow: {
      type: "workflow", name: "sf-sync", schedules: ["0 */2 * * *"],
    },
  },
});

export const wrangler = { build: CAPNWEB_VALIDATE_BUILD } satisfies WranglerExtras;

/** The gatekeeper facet is reached through ctx.exports rather than a namespace binding. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["SalesforceGatekeeper"] },
];
