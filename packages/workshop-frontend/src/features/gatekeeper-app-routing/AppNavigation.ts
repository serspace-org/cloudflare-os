import { type RpcPromise, RpcStub, RpcTarget } from 'capnweb'
import { validateRpc } from 'capnweb-validate'
import type {
  GatekeeperAppNavigation, GatekeeperAppRoute, GatekeeperAppRouteReceiver,
} from '@gadgets/workshop-shared/app-navigation'
import { validateAppPath } from './appRoutes'

export const updateNavigationPath = Symbol('updateNavigationPath')
export const disposeNavigation = Symbol('disposeNavigation')

/** One controller per frame session; its destination base cannot be changed by the app. */
@validateRpc<GatekeeperAppNavigation>()
export class AppNavigation extends RpcTarget implements GatekeeperAppNavigation {
  #route: GatekeeperAppRoute
  #receiver: RpcStub<GatekeeperAppRouteReceiver> | null = null
  #delivery: RpcPromise<void> | null = null
  #disposed = false
  #windowStarted = Date.now()
  #calls = 0
  #navigating = false
  readonly #navigate: (path: string, replace: boolean) => Promise<void>
  readonly #setBlocked: (blocked: boolean) => void

  constructor(path: string, navigate: (path: string, replace: boolean) => Promise<void>,
    setBlocked: (blocked: boolean) => void) {
    super()
    this.#route = { path: validateAppPath(path), revision: 0 }
    this.#navigate = navigate
    this.#setBlocked = setBlocked
  }

  #assertActive() {
    if (this.#disposed) throw new Error('App navigation is closed.')
    if (Date.now() - this.#windowStarted >= 60_000) {
      this.#windowStarted = Date.now()
      this.#calls = 0
    }
    if (++this.#calls > 120) throw new Error('App navigation made too many requests.')
  }

  async subscribeRoute(receiver: RpcStub<GatekeeperAppRouteReceiver>): Promise<GatekeeperAppRoute> {
    this.#assertActive()
    const retained = receiver.dup()
    this.#cancelDelivery()
    this.#receiver?.[Symbol.dispose]()
    this.#receiver = retained
    return this.#route
  }

  async navigate(path: string, replace = false): Promise<void> {
    this.#assertActive()
    const target = validateAppPath(path)
    if (this.#navigating) throw new Error('App navigation is already pending.')
    this.#navigating = true
    try {
      await this.#navigate(target, replace)
    } finally {
      this.#navigating = false
    }
  }

  async setBlocked(blocked: boolean): Promise<void> {
    this.#assertActive()
    // Synchronous before the RPC reply, so an immediately following navigation sees the guard.
    this.#setBlocked(blocked)
  }

  [updateNavigationPath](path: string) {
    if (this.#disposed || path === this.#route.path) return
    this.#route = { path: validateAppPath(path), revision: this.#route.revision + 1 }
    this.#publish()
  }

  #cancelDelivery() {
    const delivery = this.#delivery
    this.#delivery = null
    delivery?.[Symbol.dispose]()
  }

  #publish() {
    const receiver = this.#receiver
    if (!receiver || this.#delivery || this.#disposed) return
    const route = this.#route
    const delivery = receiver.setRoute(route)
    this.#delivery = delivery
    // One callback in flight; coalesce snapshots rather than queue behind a stalled receiver.
    Promise.resolve(delivery).then(() => {
      if (this.#delivery !== delivery) return
      this.#cancelDelivery()
      if (this.#route.revision !== route.revision) this.#publish()
    }, () => {
      if (this.#delivery !== delivery) return
      this.#cancelDelivery()
      if (this.#receiver !== receiver) return
      receiver[Symbol.dispose]()
      this.#receiver = null
    })
  }

  [disposeNavigation]() {
    if (this.#disposed) return
    this.#disposed = true
    this.#cancelDelivery()
    this.#receiver?.[Symbol.dispose]()
    this.#receiver = null
    this.#setBlocked(false)
  }
}
