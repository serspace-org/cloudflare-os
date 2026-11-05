# Nested gatekeeper app routes

Workshop hosts every gatekeeper management app under its existing namespace:

```text
/gatekeepers/<appId>
/gatekeepers/<appId>/<app-relative-path>
```

For example, an app may expose `/domain-models` and
`/domain-models/5d4f8b32-8b66-4c62-b331-11bf59658456`. These are app-owned presentation
paths, not Workshop resources. No deployment alias configuration, redirects, sidebar changes,
or vendor-specific host routing are required. A relative `/outputs` stays inside the app;
it cannot navigate to Workshop's `/outputs` screen.

The root and nested URLs share the same parent route component. The parent acquires the app
once through authenticated `getGatekeeperApp(appId)` and owns its iframe. Its splat child
changes only the location: root → index → detail → index, browser Back/Forward and replace
navigation retain the iframe, its RPC session, and unsaved editor state. Switching app IDs
resets that ownership, disposes the previous capability, and acquires fresh UI. Missing apps
retain the existing unavailable-app message. Nested paths do not bypass authentication or
grant backend access.

## Optional presentation capability

The type-only contract is exported from `@gadgets/workshop-shared/app-navigation`:

```ts
interface GatekeeperAppRoute { path: string; revision: number }
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

The interfaces import `RpcTarget` as a type only. New hosts return a fixed controller for
every app, with `/` representing its entry URL. Older apps need not call `getNavigation()`
and work unchanged. Apps supporting older hosts must handle an absent method or a null
result themselves. This extension does not change `ui`, theme, presentation, sharing,
workspace or prompt capabilities.

Subscribe once per session and apply only snapshots whose revision is greater than the last
applied revision, **including the subscribe reply**: a newer callback can arrive before that
reply. Revisions are local to the controller, so reset the last applied revision on reconnect.
The host replaces the previous receiver and retains one duplicate until replacement or
teardown. Dispose the navigation stub when it is no longer used. One callback may be in
flight; newer routes coalesce into the latest snapshot if a callback stalls.

`navigate()` requests a browser history push, or a replace when its second argument is true.
The committed route snapshot, not the request, is the source of truth. Cancelled requests
settle without changing that snapshot. Keep editor state independent of route subscription
setup: do not reload the app or reacquire its UI to change a view.

## Input bounds and leaving a view

Paths are canonical ASCII identifier segments separated by `/`, with a maximum length of
2,048 characters. `/` is valid; otherwise each segment must be nonempty and contain only
letters, digits, underscores or hyphens. Percent escapes, dot segments, trailing or duplicate
slashes, query strings, fragments, backslashes, protocol and external URLs are rejected.
The app ID and `/gatekeepers/<appId>` destination base are captured by the host, never supplied
by the frame. App identifiers are bounded ASCII letters, digits, underscores and hyphens;
decoded slash, query, fragment and dot identifiers are rejected before acquiring UI. Harmless
percent-encoded identifier letters retain the existing decoded-ID lookup behavior. A path
resembling another app's host URL is still relative to the current app.
Runtime RPC validation rejects non-boolean `replace` and `setBlocked` arguments. Calls are
bounded to 120 per minute per controller, with one app transition and one route callback in
flight. Disposed controllers reject further calls and release subscriptions and the guard.

Call `setBlocked(true)` when dirty edits or submitted work require confirmation before leaving.
It takes effect before its RPC reply. The host's real router blocker covers internal app
navigation, host sidebar links, and browser Back/Forward. Cancel keeps the current route and
iframe; “Discard and leave” permits the requested transition. The trusted Kumo confirmation
sits above a full-viewport app presentation. Reload/tab close use the browser's native
before-unload confirmation. Browser policies still control whether an unload prompt is shown.

The host does not silently clear the app's guard after navigation. Clear it with
`setBlocked(false)` when the app no longer needs confirmation. Leaving or switching apps
disposes the old controller so a stale app cannot block the new UI. Presentation navigation
does not cancel backend work or grant storage or resource capabilities.

## Verification

From the repository root, use the installed Node/pnpm versions documented in `README.md`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @gadgets/workshop-frontend test:run src/features/gatekeeper-app-routing
pnpm --filter @gadgets/workshop-frontend test:run:browser src/features/gatekeeper-app-routing/appRouting.browser.test.tsx
pnpm exec vp run -F @gadgets/workshop-frontend --no-cache build
pnpm lint
pnpm test
```

The build regenerates `src/routeTree.gen.ts`; do not edit it manually. Chromium tests use
the production parent and child route declarations, synthetic authenticated API responses,
opaque-origin iframes, and real MessagePort RPC. They require Playwright Chromium, not a
live vendor, paid API or deployment. Controller unit tests cover revisions, callback
coalescing, receiver replacement, teardown and request bounds.
