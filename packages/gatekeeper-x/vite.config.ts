import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { vitestTask, type GlobWithBase } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared configurator `build`/`build:configurator` tasks plus a
 * two-pass `test` task -- pure logic in Node, RpcTarget/Durable Object behaviour in workerd. The
 * passes stay separate commands so one can replay from the task cache when only the other's
 * inputs moved. The workerd suite imports the generated configurator modules, so `test` generates
 * them first rather than rely on an earlier build having left them.
 */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      // Node-only tests need Node types; production and workerd tests must not
      // acquire them. Check both programs, and fingerprint their test inputs.
      build: {
        ...gatekeeperConfiguratorConfig.run.tasks.build,
        command: ["tsc", "tsc -p tsconfig.test.json"],
        cache: {
          input: [
            { auto: true },
            { pattern: "packages/gatekeeper-x/__tests__/**", base: "workspace" } satisfies GlobWithBase,
            { pattern: "packages/gatekeeper-x/tsconfig*.json", base: "workspace" } satisfies GlobWithBase,
          ],
        },
      },
      test: {
        ...vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]),
        dependsOn: ["build:configurator"],
      },
    },
  },
};
