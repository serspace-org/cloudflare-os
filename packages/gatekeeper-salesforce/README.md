# Salesforce gatekeeper

Mediates a Gadget's access to a Salesforce org: CRM records, their related lists, their activity
timelines and their notes.

**Status: scaffolding.** The connect flow, the account, the resource model and the observer
contract are wired end to end. Every Session method is a stub, because the
[`write-gatekeeper`](../../.agents/skills/write-gatekeeper/SKILL.md) skill stops for an operator
review of the agent-facing API before it is implemented (Step 3). That API is
[`src/types.d.ts`](src/types.d.ts), and the [open questions](#open-questions-for-review) below are
what the review should settle.

## Relationship to PR #76

[cloudflare/cloudflare-os#76](https://github.com/cloudflare/cloudflare-os/pull/76) attempted a
Salesforce gatekeeper and was closed without being merged. It is not the starting point here, for
reasons worth recording:

- It **synced the org into D1 and Vectorize** and served agents a `search()` / `getRecord()` pair
  over that index. That makes every read stale by a sync interval, demands D1, Vectorize, AI and
  Workflows bindings the deploy wizard would have to provision, and gives an agent no way to write.
  This package calls Salesforce's REST API directly, as every other gatekeeper in this repo calls
  its provider.
- It had **one coarse granularity**: the whole org. Salesforce's own sharing is per record, so
  "this one opportunity" is the grant a user most often wants to make. This package supports org,
  object and record.
- It **predates the conventions this repo now holds gatekeepers to**: a hand-written
  `wrangler.jsonc` (now generated from `cloudflare.config.ts`), no `gatekeeper-kit`, and none of
  the observer contract — no `subresources` on reads, no `verifyObserverAccess()`. Sharing a gadget
  bound to that gatekeeper would have shown collaborators CRM data their own Salesforce login could
  not reach.
- It authenticated with the **JWT bearer flow** against one deployment-wide service user, so every
  Gadget read the org as that user rather than as the human who connected it. This package uses the
  web-server OAuth flow per user, which is what makes per-record sharing checks meaningful.

Its useful residue — the 15-to-18-character Id normalization, and treating `SystemModstamp` as the
incremental-sync cursor — is carried over in `salesforce-subresources.ts` and noted below.

## Resources

Three grantable granularities, declared narrowest first so Workshop's grant check matches the
narrowest type whose pattern fits a URL:

| Resource | URL pattern | Session |
|---|---|---|
| Record | `https://salesforce.com/org/:orgId/object/:objectName/record/:recordId` | `SalesforceRecord` |
| Object | `https://salesforce.com/org/:orgId/object/:objectName` | `SalesforceObject` |
| Org | `https://salesforce.com/org/:orgId` | `SalesforceOrg` |

Salesforce's own URLs live on a per-org My Domain host (`https://acme.lightning.force.com/...`)
that an admin can rename, so the canonical form names the org by its stable 18-character Id. The
resource configurator is responsible for mapping a pasted Lightning URL onto this form through
`initialValuesFromResourceUrl`.

## Subresources and observer verification

See [`src/salesforce-subresources.ts`](src/salesforce-subresources.ts) for the ID grammar. Every ID
names its org first, because one deployed Worker serves every org the Connected App is installed in.

| Reported by | ID |
|---|---|
| Org metadata, the object list, the user directory, a cross-object search page | `org/<orgId>` |
| A describe, listing, search or query over one object that names no record | `org/<orgId>/object/<Object>` |
| Any read of a record's fields, related lists, activities or notes | `org/<orgId>/object/<Object>/record/<RecordId>` |

This is strategy **C**: one read may report the union of an object and every record it disclosed.

`verifyObserverAccess()` refuses any ID outside the binding's own org, then asks the observer's own
`UserAccount.checkSubresourceAccess`, which answers from the observer's own credentials through a
credential-partitioned `KvTtlCache`:

- **org** — the observer's grant belongs to that org.
- **object** — Salesforce describes the object for the observer's token.
- **record** — Salesforce returns the record to the observer's token. Salesforce answers a record
  outside a user's sharing with `404`, exactly as it answers one that never existed, so a
  successful read is the only proof of access. Row-level sharing is the real ACL here, and it does
  not follow from object access: two users with identical profiles routinely see different rows.

Only Salesforce's definite refusals (`403`, `404`, `INSUFFICIENT_ACCESS*`, `NOT_FOUND`,
`ENTITY_IS_DELETED`, `INVALID_TYPE`) become `false`. An expired session, a rate limit or an outage
throws, so the Workshop denies the whole call rather than silently sharing.

This gatekeeper is new, so `getHistoricalSubresources()` returns `[]` and `addObserver()` /
`removeObserver()` are no-ops.

## Actions and auto-approval

| Action | Kind | `autoApprovable` |
|---|---|---|
| `SalesforceObject.createRecord` | `create-record` — "Create records" | `true` |
| `SalesforceRecord.update` | `update-record` — "Edit records" | `true` |
| `SalesforceRecord.logActivity` | `log-activity` — "Log calls, tasks and meetings" | `true` |
| `SalesforceRecord.addNote` | `add-note` — "Add notes" | `true` |
| `SalesforceRecord.delete` | none | `false` — rule 1, deletes content |

`SalesforceOrg.query` accepts `SELECT` only and is an observation, not an action.

Deliberately **not** exposed, and why: sending email as the user (rule 2, and Salesforce's
`sendEmail` reaches contacts outside any bound record); `executeAnonymous` Apex and the Tooling
and Metadata APIs (rule 4, arbitrary code, and rule 5, org configuration); sharing-rule and
permission changes (rule 7).

## Auth

The OAuth 2.0 web-server flow with PKCE, per user. Two hosts are involved and must not be confused:

- The **login host** is deployment configuration (`SALESFORCE_LOGIN_URL`, default
  `https://login.salesforce.com`; `https://test.salesforce.com` for sandboxes). Authorization,
  refresh and revocation go there.
- The **instance host** comes from each account's own token response (`instance_url`) and is where
  every API call goes. It is stored with the grant and refreshed from every token response, never
  derived from configuration.

Salesforce access tokens carry no expiry — a session simply stops working — so there is nothing to
pre-emptively refresh against. Every request retries once through `UserAccount.refreshCredentials()`
on an expired session. Refresh tokens are not rotated, so the stored one is kept across refreshes.

## What is left to do

1. **Review `src/types.d.ts`** and settle the open questions below (skill Step 3).
2. Implement the Session reads, each through `SalesforceGatekeeperImpl.authorizeRead` with its
   complete subresources (Step 4).
3. Add the resource configurator: a `HierarchyPicker` over objects and their records, plus
   `initialValuesFromResourceUrl` for pasted Lightning URLs (Step 6).
4. Phase 2: the actions above through `submitAction`/`applyAction`, caching, and simulation.
5. Runtime coverage of the observer contract: denied observers, a record visible to one collaborator
   and not another, empty and cached pages, and reconnect identity.

## Open questions for review

- **Should a record binding reach its related records?** `listRelated`, `listActivities` and
  `listNotes` hand back child records, which widens the grant beyond the one record the user
  picked. Salesforce's record page shows exactly these lists, so an agent that cannot see them is
  close to useless on an account. The current design includes them as read-only summaries — no
  `SalesforceRecord` capability is returned — and reports each disclosed record as its own
  subresource. The alternative is to drop them and make the object binding the smallest useful one.
- **Is arbitrary SOQL the right escape hatch?** `SalesforceOrg.query` is read-only and far more
  capable than `listRecords`, but an aggregate or a relationship traversal makes "which records did
  this disclose" a parsing problem: the answer has to be the objects in the `FROM` and `SELECT`
  clauses plus every Id returned. The alternative is a structured filter only, which closes off a
  large share of what users ask for.
- **Custom objects.** `listObjects` filters Salesforce's ~500 objects down to the ones holding CRM
  data. Which heuristic — `queryable && !deprecatedAndHidden && (custom || a standard allowlist)`?
  A pure allowlist hides every custom object an org actually runs on.
- **Should `getDetails()` default to the page layout?** It is what a user means by "the record",
  but it costs a layout call per object and its result is not stable across org configuration
  changes. The alternative is a fixed per-object field set.
- **Multi-org accounts.** One connection is one org. A user who works across a production org and a
  sandbox connects twice. Confirm that is acceptable rather than modelling orgs within one account.
- **Incremental sync.** Phase 2 caching wants `SystemModstamp` plus Id as a tie-break cursor, and
  the `getDeleted`/`getUpdated` endpoints for removals — the one design point PR #76 got right and
  worth lifting when caching lands.
