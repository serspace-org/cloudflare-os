import { RpcStub, RpcTarget } from 'capnweb'
import { describe, expect, it, vi } from 'vitest'
import type { GatekeeperAppRoute, GatekeeperAppRouteReceiver } from '@gadgets/workshop-shared/app-navigation'
import { AppNavigation, disposeNavigation, updateNavigationPath } from './AppNavigation'

class Receiver extends RpcTarget implements GatekeeperAppRouteReceiver {
  routes: GatekeeperAppRoute[] = []
  disposed = 0
  wait: Promise<void> = Promise.resolve()
  async setRoute(route: GatekeeperAppRoute) {
    this.routes.push(route)
    await this.wait
  }
  [Symbol.dispose]() { this.disposed++ }
}

describe('app navigation controller', () => {
  it('keeps revisions monotonic when an initial reply races a callback', async () => {
    const controller = new AppNavigation('/', async () => {}, () => {})
    const receiver = new Receiver()
    using stub = new RpcStub<GatekeeperAppRouteReceiver>(receiver)
    const initialReply = controller.subscribeRoute(stub)
    controller[updateNavigationPath]('/second')
    controller[updateNavigationPath]('/second')
    const initial = await initialReply
    await vi.waitFor(() => expect(receiver.routes).toHaveLength(1))
    expect(initial).toEqual({ path: '/', revision: 0 })
    expect(receiver.routes[0]).toEqual({ path: '/second', revision: 1 })
    controller[updateNavigationPath]('/')
    await vi.waitFor(() => expect(receiver.routes[1]).toEqual({ path: '/', revision: 2 }))
    controller[disposeNavigation]()
  })

  it('does not clear the guard on navigation and closes stale controllers', async () => {
    const navigate = vi.fn<(path: string, replace: boolean) => Promise<void>>(async () => {})
    const setBlocked = vi.fn<(blocked: boolean) => void>()
    const controller = new AppNavigation('/', navigate, setBlocked)
    await controller.setBlocked(true)
    await controller.navigate('/opaque-id')
    await controller.navigate('/', true)
    expect(navigate.mock.calls).toEqual([['/opaque-id', false], ['/', true]])
    expect(setBlocked.mock.calls).toEqual([[true]])
    await expect(controller.navigate('//elsewhere')).rejects.toThrow('Invalid app-relative path')
    controller[disposeNavigation]()
    controller[disposeNavigation]()
    expect(setBlocked.mock.calls).toEqual([[true], [false]])
    await expect(controller.navigate('/stale')).rejects.toThrow('closed')
    await expect(controller.setBlocked(true)).rejects.toThrow('closed')
  })

  it('replaces and releases route receivers without duplicate delivery', async () => {
    const controller = new AppNavigation('/', async () => {}, () => {})
    const first = new Receiver()
    const second = new Receiver()
    const firstStub = new RpcStub<GatekeeperAppRouteReceiver>(first)
    const secondStub = new RpcStub<GatekeeperAppRouteReceiver>(second)
    await controller.subscribeRoute(firstStub)
    firstStub[Symbol.dispose]()
    await controller.subscribeRoute(secondStub)
    secondStub[Symbol.dispose]()
    await vi.waitFor(() => expect(first.disposed).toBe(1))
    controller[updateNavigationPath]('/next')
    await vi.waitFor(() => expect(second.routes).toHaveLength(1))
    expect(first.routes).toHaveLength(0)
    controller[disposeNavigation]()
    await vi.waitFor(() => expect(second.disposed).toBe(1))
  })

  it('bounds calls and permits only one pending app transition', async () => {
    let finish!: () => void
    const controller = new AppNavigation('/', () => new Promise((resolve) => { finish = resolve }), () => {})
    const pending = controller.navigate('/first')
    await expect(controller.navigate('/second')).rejects.toThrow('already pending')
    finish()
    await pending
    for (let i = 0; i < 118; i++) await controller.setBlocked(false)
    await expect(controller.setBlocked(true)).rejects.toThrow('too many requests')
    controller[disposeNavigation]()
  })

  it('coalesces stalled callbacks and disposes stale work on replacement', async () => {
    const controller = new AppNavigation('/', async () => {}, () => {})
    const first = new Receiver()
    let finish!: () => void
    first.wait = new Promise((resolve) => { finish = resolve })
    const firstStub = new RpcStub<GatekeeperAppRouteReceiver>(first)
    await controller.subscribeRoute(firstStub)
    firstStub[Symbol.dispose]()
    controller[updateNavigationPath]('/one')
    await vi.waitFor(() => expect(first.routes).toHaveLength(1))
    controller[updateNavigationPath]('/two')
    controller[updateNavigationPath]('/three')
    expect(first.routes).toHaveLength(1)
    const second = new Receiver()
    const secondStub = new RpcStub<GatekeeperAppRouteReceiver>(second)
    expect(await controller.subscribeRoute(secondStub)).toEqual({ path: '/three', revision: 3 })
    secondStub[Symbol.dispose]()
    finish()
    controller[updateNavigationPath]('/four')
    await vi.waitFor(() => expect(second.routes).toEqual([{ path: '/four', revision: 4 }]))
    expect(first.routes).toHaveLength(1)
    controller[disposeNavigation]()
    await vi.waitFor(() => expect(first.disposed).toBe(1))
    await vi.waitFor(() => expect(second.disposed).toBe(1))
  })
})
