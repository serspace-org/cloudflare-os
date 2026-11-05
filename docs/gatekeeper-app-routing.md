# Gatekeeper app route bridge

`VITE_GATEKEEPER_APP_ROUTES` is a build-time JSON object mapping a top-level route slug to a
gatekeeper vendor ID, for example `{"models":"example"}`. Its default is `{}`. Both names must
be lowercase ASCII slugs of at most 64 characters; each vendor has at most one alias. Configuration
is limited to 64 aliases and 16 KiB. Invalid configuration fails closed, rather than partially
installing aliases. The existing frontend task fingerprints `VITE_*` variables.

Aliases cannot shadow reserved Workshop routes or HTTP endpoints. Static TanStack routes win over
the top-level splat, and unknown or malformed paths produce Not Found. App navigation accepts `/`
or slash-separated ASCII identifier segments (`A-Z`, `a-z`, digits, `_`, `-`), at most 2048
characters. It rejects all percent escapes, dot segments, empty segments, trailing slashes, query
strings, fragments, control characters, schemes and external URLs. A path is always relative to
the fixed app base: `/notes` from the `models` app means `/models/notes`, never another alias.
Apps own any stricter validation of their identifiers.

Navigation entries still come only from `useGatekeeperApps()`. Configuring a name does not grant
an account, discover an app, or authorize any data access. Both direct alias visits and legacy
visits use the existing authenticated `getGatekeeperApp(vendorId)` lookup. Authentication and
backend approval policy are unchanged. `/gatekeepers/<vendorId>` redirects with replacement to
the configured base; apps without aliases retain their old route and receive no navigation
capability. The origin must serve the normal SPA fallback for refreshes of alias deep links.

## Sandbox contract

Import the presentation-only interfaces from `@gadgets/workshop-shared/app-navigation`:

```ts
interface GatekeeperAppRoute { path: string; revision: number }
// These capability interfaces extend Cap'n Web RpcTarget, not a Worker class.
interface GatekeeperAppRouteReceiver extends RpcTarget {
  setRoute(route: GatekeeperAppRoute): void
}
interface GatekeeperAppNavigation extends RpcTarget {
  subscribeRoute(receiver: GatekeeperAppRouteReceiver): Promise<GatekeeperAppRoute>
  navigate(path: string, replace?: boolean): Promise<void>
  setBlocked(blocked: boolean): Promise<void>
}
interface GatekeeperAppNavigationHost extends RpcTarget {
  getNavigation(): Promise<GatekeeperAppNavigation | null>
}
```

Probe `host.getNavigation()` once and catch unsupported-method errors for older hosts. A null
result means use the app's legacy local navigation. Dispose the obtained stub when the app closes.
The host returns one fixed app-scoped controller per frame session, not a URL-selected controller.
Only the three interface methods are callable remotely. Calls are bounded to 120 per minute,
with at most one pending app-requested transition. Receiver registration replaces and disposes the
previous receiver; frame teardown releases the retained receiver and clears the leave guard.
Only one route callback is kept in flight; a stalled receiver gets the newest coalesced snapshot
when it resumes. Replacement or teardown also disposes the pending callback.

The app's route receiver must apply a snapshot only if its revision is **greater** than the last
applied revision, including the initial subscribe reply. A callback can beat that reply. Revisions
increase when committed relative paths change, including Back/Forward. They are scoped to one
controller, so reset the comparison when connecting to a new host session. Routes are presentation
only; never interpret a path, revision, model ID or browser principal as authorization.

The iframe and acquired UI capability remain stable while only the app-relative path changes.
The app must await `setBlocked(true)` when dirty or busy. The host guard protects app navigation,
host links, history and page unload. Cancel resolves `navigate()` without committing a new route;
Discard proceeds, then the app receives the committed snapshot. `navigate()` never automatically
clears the guard. An app that already confirmed an internal transition must clear its flag **after**
its local confirmation and **before** calling `navigate()`. Work already submitted may continue
after leaving; the host does not claim to cancel it or delete its receipt.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm --filter @gadgets/workshop-frontend test:run
pnpm --filter @gadgets/workshop-frontend test:run:browser
pnpm exec vp run -F @gadgets/workshop-frontend --no-cache build
VP_RUN_CONCURRENCY_LIMIT=4 pnpm lint
VP_RUN_CONCURRENCY_LIMIT=4 pnpm test
```

Vite's documented frontend build generates `src/routeTree.gen.ts`; do not edit it manually. The
Chromium bridge tests run the real page, sandbox host, MessagePort RPC, router and Kumo leave
confirmation against a synthetic authenticated app API. They are not Serspace SQL or live vendor
authorization tests. Alias-map parsing, reserved paths, malformed input, receiver ownership and
revision races also have focused unit coverage.
