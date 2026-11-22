# Contributing

## Contributing to this fork

This repository is Serspace Labs' fork of
[cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os). Cloudflare's policy,
reproduced below, governs the upstream project — not this fork. Take a change to whichever
project owns the code it touches:

- **A change to Cloudflare OS itself** belongs upstream, under Cloudflare's policy below. It
  reaches this fork through the next `sync-upstream` rebase.
- **A change to the Serspace additions** — the extended GitHub Gatekeeper, nested Gatekeeper app
  routes, or the sync tooling — belongs here, as a pull request against the `serspace` branch.

Fork pull requests are squashed into a single commit, never merged, because `serspace` is a
patch stack replayed onto upstream `main` by rebase. See
[`docs/fork-automation.md`](docs/fork-automation.md) for the invariant and the settings behind
it. A maintainer reviews every pull request; passing CI is not acceptance.

There is no contributor licence agreement. Cloudflare removed the CLA Assistant workflow
upstream in November 2026, and this fork has not added one, so contributions are covered by
section 5 of the repository's [Apache 2.0 licence](LICENSE). Cloudflare's
`contribution-policy.yml` automation, which closes pull requests it judges out of policy, is
one of the upstream-only workflows disabled here; nothing enforces the size limit below in
this fork.

Issues and discussions are turned off on this fork. Open a pull request, or raise the idea
upstream if it belongs to Cloudflare OS proper.

## Cloudflare's upstream policy

At this time, we are not seeking outside contribution.

AI has made writing code easy. The hard part, today, is not writing the code, but reviewing it, making sure quality stays high, and keeping the product coherent. In that light, unfortunately, external code contributions are "donating" the easy part of the job, while creating more of the hard work.

With that said, we are happy to accept small, trivially-verified PRs that fix a problem. However, we ask that you refrain from submitting low-value PRs (e.g. typo fixes) or PRs that are more than a dozen or so lines. Such PRs will be closed with a reference to this guideline.

If you have a big idea you'd like us to consider, feel free to [open a discussion](https://github.com/cloudflare/cloudflare-os/discussions) about it.

This policy may change in the future as the project matures. Until then, thank you for your understanding.

## What CI runs on your pull request

Lint, build and tests ([`ci.yml`](.github/workflows/ci.yml)) run on every pull request, including
those from forks.

Preview deployments ([`preview.yml`](.github/workflows/preview.yml)) do **not**, this is
deliberate. Deploying a preview requires a Cloudflare API token that can create Workers
and storage on a Cloudflare-owned account, and GitHub structurally withholds repository secrets
from `pull_request` runs whose head is a fork. If you see the preview job skipped on your PR,
that is working as intended — a maintainer will deploy one if the change needs manual review.
See [`.github/workflows/README.md`](.github/workflows/README.md).
