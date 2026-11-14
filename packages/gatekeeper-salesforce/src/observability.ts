import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Salesforce gatekeeper. */
export type SalesforceObservabilityFields = { vendorId: string };

/** Ambient observability fields for one Salesforce gatekeeper operation. */
export const obsContext = createObservabilityContext<SalesforceObservabilityFields>();
