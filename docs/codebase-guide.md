# Serspace Cloudflare OS: codebase guide

## What this repository is

[`serspace-org/cloudflare-os`](https://github.com/serspace-org/cloudflare-os) is Serspace Labs'
fork of [Cloudflare OS](https://github.com/cloudflare/cloudflare-os), an AI productivity platform,
not a traditional operating system. It combines agent chat, sandboxed personal applications
(**Gadgets**), reusable application templates (**Blueprints**), and capability-scoped service
integrations (**Gatekeepers**).

The default **`serspace`** branch builds Serspace OS; **`main`** tracks upstream. Fork additions
include extended GitHub Projects/milestone/assignee support, nested Gatekeeper app routes, and
upstream-sync tooling. See the [README](../README.md) for product context.

This is the application source repository. In a separate Serspace deployment checkout, the
application is pinned as a submodule: keep deployment-wrapper changes in that checkout's
`packages/`, make product changes here through reviewed PRs, and update the deployment pin
separately after review.

## Where things live

| Area | Purpose |
| --- | --- |
| `packages/workshop-backend` | Workers/Durable Objects backend, sandboxing, agents and access control: the kernel. |
| `packages/workshop-shared` | Shared Cap'n Web RPC contracts; `src/api.ts` defines the frontend/backend API. |
| `packages/workshop-frontend` | React/Vite Workshop UI; persistent WebSocket RPC to the backend. |
| `packages/router` | Public entry point, frontend assets, API and Gatekeeper routing. |
| `packages/gatekeeper-*` | Service integrations; `gatekeeper-kit` is a shared library, not a deployable Worker. |
| `packages/bundled-blueprints` | Shipped Blueprint definitions and Gadget code. |
| `packages/ui`, `packages/configurator-ui` | Shared React UI and sandboxed resource configurator UI. |
| `packages/api-cli`, `packages/integration-tests`, `packages/workshop-evals` | API-driven checks, cross-Worker tests and agent evaluations. |
| `scripts/`, `docs/`, `plans/` | Build/release/sync tools, implementation guides and design records. |

Workspaces use Durable Objects; Gadgets run in sandboxed Dynamic Worker Facets with sandboxed
browser UIs. External access requires explicitly granted capabilities, not ambient account
access. Gatekeepers log observations and can simulate writes while human approval is pending.
Preserve these security boundaries when changing behavior.

## Start locally

Use **Node >=24.19.0** and **pnpm 11.17.0**, not npm:

```sh
pnpm install --frozen-lockfile
pnpm run-local                  # whole stack at http://localhost:8787
```

For hot-reload development, run `pnpm dev-server` and `pnpm dev-client` in separate terminals,
then open **http://localhost:3000**. Local data lives under `.wrangler`; external integrations
may need their own OAuth/configuration setup (see each Gatekeeper's README). Never commit secrets.

## Make a change

1. Start from current `serspace`, create a focused branch, and read [AGENTS.md](../AGENTS.md)
   plus the package-specific guides it lists. For reviews, also read [REVIEW.md](../REVIEW.md).
2. Keep changes small, particularly in the kernel and shared API. Document every exported
   shared API member and reuse existing mechanisms rather than introducing parallel ones.
3. For frontend work, load the `frontend-conventions` skill; for Gatekeepers, load
   `write-gatekeeper` (both under `.agents/skills/`).
4. Preserve Cap'n Web promise pipelining, dispose RPC stubs, wrap stubs stored in React state,
   and use `@validateRpc()` on RPC implementations. Log through the observability library;
   never log secrets, prompts, tokens, headers or request/response bodies.
5. Edit Worker `cloudflare.config.ts` sources, then run `pnpm configs:generate`; do not hand-edit
   generated `wrangler.jsonc`. Do not rename a deployed Blueprint's `blueprintId`.
6. Verify, push to a new branch, and open a PR targeting `serspace`. Report failed or unrun
   checks explicitly; never force-push a shared branch or weaken checks to obtain a green PR.

## Verify before review

```sh
pnpm --filter <package> test:run # focused tests while iterating
pnpm lint                      # lint, script types, generated configs, build/type-checks
pnpm test                      # workspace tests
```

Use `pnpm cf-os api` against a local server for stored state, RPC behavior and authorization
checks; use integration tests for model/vendor payloads and browser tests for layout, focus
and keyboard behavior. See [testing](testing.md), [integration testing](integration-testing.md)
and [build-system guidance](build-system.md) for setup, codegen, caching and timeouts.

## Sync upstream safely

`pnpm sync:upstream` rehearses an upstream merge in a disposable worktree;
`pnpm sync:upstream --prepare` retains a candidate for review. Verify `origin` is this fork and
`upstream` is `cloudflare/cloudflare-os` first. Neither command pushes, opens a PR, or changes a
deployment submodule pin. A conflict-free merge still needs review, lint and tests.

Keep quality CI enabled. Preserve exact `github.repository == 'cloudflare/cloudflare-os'`
guards on upstream-only CLA, contribution-policy, Bonk, preview and paid-evaluation jobs.
Do not enable those jobs or sign contributor agreements. Classify newly imported workflows
and follow the full [fork automation checklist](fork-automation.md).
