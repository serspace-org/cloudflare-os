/// <reference types="@cloudflare/vitest-plugin/types" />

import type { TestHooks } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Test-only facet host configured by vitest.config.ts, not deployed. */
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
