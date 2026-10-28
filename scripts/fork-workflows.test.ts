import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

// Every new upstream workflow needs an explicit decision before it runs in the fork.
const SHARED = ["ci.yml", "github-contract.yml", "label-pr.yml"];
const UPSTREAM_ONLY = [
  "bonk-pr.yml", "bonk.yml", "cla.yml", "contribution-policy.yml",
  "preview.yml", "workshop-evals-pr.yml", "workshop-evals.yml",
];

interface Workflow {
  on: { push?: { branches?: string[] }; pull_request?: unknown };
  jobs: Record<string, { if?: string }>;
}

const readWorkflow = (name: string): Workflow =>
  parse(readFileSync(`.github/workflows/${name}`, "utf8"));

describe("Serspace fork workflow policy", () => {
  it("requires an explicit policy for every workflow, including upstream additions", () => {
    const workflows = readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name));
    assert.deepEqual(workflows.toSorted(), [...SHARED, ...UPSTREAM_ONLY].toSorted());
  });

  for (const name of UPSTREAM_ONLY) {
    it(`restricts every job in ${name} to the upstream repository`, () => {
      const jobs = Object.entries(readWorkflow(name).jobs);
      assert.ok(jobs.length > 0);
      for (const [job, config] of jobs) {
        const condition = (config.if ?? "").trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
        const guard = "github.repository == 'cloudflare/cloudflare-os'";
        assert.ok(condition === guard || condition.startsWith(`${guard} &&`), `${name}:${job} needs the upstream guard first`);
        // An unparenthesized OR could bypass the leading guard. Ignore operators in strings
        // and allow ORs only inside parentheses, as in event and dependency alternatives.
        let depth = 0;
        const expression = condition.replace(/'[^']*'/g, "''");
        for (let i = 0; i < expression.length; i++) {
          if (expression[i] === "(") depth++;
          if (expression[i] === ")") depth--;
          if (expression.slice(i, i + 2) === "||") {
            assert.ok(depth > 0, `${name}:${job} must not bypass the repository guard`);
          }
        }
        assert.equal(depth, 0, `${name}:${job} has unbalanced parentheses`);
      }
    });
  }

  it("keeps quality CI enabled for Serspace pushes and pull requests", () => {
    const workflow = readWorkflow("ci.yml");
    assert.ok(workflow.on.push?.branches?.includes("serspace"));
    assert.ok(Object.hasOwn(workflow.on, "pull_request"));
    assert.equal(workflow.jobs.lint.if, undefined);
    assert.equal(workflow.jobs.test.if, undefined);
    assert.equal(workflow.jobs["build-and-test"].if, "${{ always() }}");
  });
});
