import type { RpcTarget } from 'capnweb'

/** Presentation-only route snapshot; neither paths nor revisions convey authority. */
export interface GatekeeperAppRoute {
  /** Validated path relative to this app's configured host base, beginning with `/`. */
  path: string
  /** Monotonically increasing within one host controller; ignore older snapshots. */
  revision: number
}

/** Receives browser history and host navigation updates. */
export interface GatekeeperAppRouteReceiver extends RpcTarget {
  /** Apply only snapshots newer than the last applied revision, including the subscribe reply. */
  setRoute(route: GatekeeperAppRoute): void
}

/** Fixed, app-scoped presentation capability, not a resource or identity capability. */
export interface GatekeeperAppNavigation extends RpcTarget {
  /** Replace the previous receiver and return the current snapshot; callbacks may arrive first. */
  subscribeRoute(receiver: GatekeeperAppRouteReceiver): Promise<GatekeeperAppRoute>
  /** Navigate within this app only; normal host leave confirmation still applies. */
  navigate(path: string, replace?: boolean): Promise<void>
  /** Block navigation and page unload while edits or work need a leave confirmation. */
  setBlocked(blocked: boolean): Promise<void>
}

/** Optional extension to a sandbox host; older hosts may not implement it. */
export interface GatekeeperAppNavigationHost extends RpcTarget {
  /** Return this app's fixed controller, or null for an app without a configured alias. */
  getNavigation(): Promise<GatekeeperAppNavigation | null>
}
