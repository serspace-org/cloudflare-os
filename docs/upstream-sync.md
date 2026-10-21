# Application upstream sync — 2026-10-20

**Status: proposed integration, not merged or deployed.** This candidate merges
the two missing upstream commits while retaining Serspace's existing fork changes.
It does not update the deployment wrapper or its pinned application revision.
The maintainer requested this review/sync directly; no separate accepted
intent/spec/plan chain was supplied, and human review remains required.

## Inspected revisions and scope

| Source | Revision |
| --- | --- |
| `serspace-org/serspace-cloudflare-os`, `main` baseline | `21b06eac38085003a1904000c4763a7e45a5e177` |
| `cloudflare/cloudflare-os`, `main` integrated | `a6794421279057cb8813d3e5d0710754f5d41618` |
| Common ancestor | `d1ff6d8d3db0968673fceb6ba18546dc1d6f9b3e` |
| Deployment wrapper's unchanged application pin | `e32262522694c9bf44ee45c51d36aa1624574148` |

Before integration the application fork was 24 commits ahead and two behind.
The upstream additions are the [unified Drive picker (#836)](https://github.com/cloudflare/cloudflare-os/pull/836)
and [Drive PDF reading (#843)](https://github.com/cloudflare/cloudflare-os/pull/843).
The merge applied without conflicts. Independent review identified one misleading
permission notice; the candidate clarifies that the Drive permission supports
selected-content/PDF reads as well as shared-drive listing. This is explanatory
text only, not an authorization change.
Fork-only GitHub README support, connect-handoff hardening, CI configuration and
test-timeout changes remain in history and are not replaced with an upstream tree.

## Operator-visible changes

- Drive selection now offers account, folder and file choices in one picker,
  including paginated shared-drive navigation and incremental consent.
- Drive resources now request the restricted `drive.readonly` OAuth scope rather
  than `drive.metadata.readonly`. Existing accounts without a covering grant must
  re-consent; review the OAuth consent screen before enabling the new version.
- `readPdf()` sends an in-scope PDF to Workers AI for Markdown conversion. The
  Google Worker gains an `AI` binding; its generated config and release-manifest
  fixture are included. Without the binding PDF reading is unavailable. Local
  use requires explicit remote Workers AI opt-in; no live AI conversion was run
  as part of this review. See the [Google Gatekeeper guide](../packages/gatekeeper-google/README.md).
  Cloudflare documents this service in [Markdown Conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/);
  the exact streaming implementation and binding types are those in this pinned
  application, not a claim that every conversion is free or locally emulated.
- PDF conversion transmits the whole PDF bytes to Workers AI; disabling image
  descriptions and metadata output does not remove those bytes before sending.
- The current wrapper inherits connector base bindings but supplies only
  `BASE_URL` as connector vars. It does not automatically copy Workshop's
  `CF_AI_GATEWAY` to Google. Without an explicit Google gateway, conversion goes
  directly to Workers AI; a chosen gateway must be in the Google Worker's own
  account. Decide routing explicitly when reviewing a matched deployment pin.

Do not advance the deployment gitlink merely because this branch exists. The
starter's separate CLI migration conflicts with Serspace-owned deployment code;
[deployment draft PR #42](https://github.com/serspace-org/serspace-os-deployment/pull/42)
records those blockers. A subsequent pin upgrade must select an accepted fork
commit, preserve connector identities and private DB wiring, and verify generated
bindings, compatible dependency catalogs and deployment dry-runs. No deployment
or production acceptance is implied by application tests.

## Verification

Commands run in the isolated application worktree with Node 24.19.0 and pnpm
11.17.0. The integration source tree is the conflict-free merge of the revisions
above, plus this document and the permission-notice correction/regression
assertion described above.

- `corepack pnpm install --frozen-lockfile`: passed; no lockfile changes.
- `pnpm lint`: passed, including script types, generated-config checks and all
  85 build tasks (zero cache hits across 62 cacheable tasks). Build warnings did
  not fail the command.
- `pnpm test`: passed on the second attempt; 58/58 tasks successful, with
  41/49 cacheable tasks replayed. Skipped cases remain skipped; this is not
  evidence of live cloud acceptance.
- After the permission-notice correction and regression assertion, `pnpm lint`
  passed again (85/85 tasks successful, 44/62 cacheable tasks replayed), and
  `pnpm --filter @gadgets/google-gatekeeper test:run` passed all three projects:
  1,667 Node tests, 500 Worker tests and 322 Docs Worker tests.
- Independent read-only integration review found no blocking regression. Its
  low-severity permission-notice finding is corrected with an assertion that
  the notice discloses selected-content/PDF reading. Its deployment caveats
  are recorded above. `git diff --check` and staged whitespace checks passed.

The first test attempt was interrupted by the outer shell's 120-second limit;
it is not a completed test result. A second attempt uses a 600-second outer
limit without changing test assertions or repository watchdog defaults. An
initial `corepack pnpm lint` launch failed because nested commands resolved a
global pnpm 12.14.0; using the repository-selected `pnpm` resolved 11.17.0 and
the complete lint/build command passed without configuration changes.
