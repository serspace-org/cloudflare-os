// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import GatekeeperAppPage from './GatekeeperAppPage'

const auth = vi.hoisted(() => ({
  authenticatedApi: { getGatekeeperApp: vi.fn<(id: string) => Promise<GatekeeperUiFrame | null>>() },
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => auth }))
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('./ServerConfigContext', () => ({ useServerConfig: () => null }))
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<() => void>(), forwardTrustedFrameError: () => false }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const makeFrame = () => {
  const dispose = vi.fn<() => void>()
  class TestUi extends RpcTarget {
    [Symbol.dispose]() { dispose() }
  }
  const ui = new RpcStub(new TestUi())
  const frame: GatekeeperUiFrame = { iframeHtml: '<!doctype html><title>Test app</title>', ui }
  return { frame, dispose }
}

describe('gatekeeper route loading', () => {
  let container: HTMLDivElement
  let root: Root
  let allowFrameLoad: boolean

  beforeEach(() => {
    auth.authenticatedApi = { getGatekeeperApp: vi.fn<(id: string) => Promise<GatekeeperUiFrame | null>>() }
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    container = document.createElement('div')
    // jsdom loads an empty document rather than executing srcDoc. Drive completion explicitly.
    allowFrameLoad = false
    container.addEventListener('load', (event) => {
      if (!allowFrameLoad) event.stopPropagation()
    }, true)
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const mountRoute = async () => {
    const rootRoute = createRootRoute()
    const appRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/gatekeepers/$appId',
      component: () => {
        const { appId } = appRoute.useParams()
        return <GatekeeperAppPage appId={appId} title={appId === 'first' ? 'First app' : 'Second app'} />
      },
    })
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/gatekeepers/first'] }),
      routeTree: rootRoute.addChildren([appRoute]),
    })
    await act(async () => root.render(<RouterProvider router={router} />))
    return router
  }

  it('renders the title before a slow host request, retaining the skeleton through document load', async () => {
    const request = deferred<GatekeeperUiFrame | null>()
    auth.authenticatedApi.getGatekeeperApp.mockReturnValue(request.promise)
    await mountRoute()
    expect(auth.authenticatedApi.getGatekeeperApp).toHaveBeenCalledWith('first')
    expect(container.querySelector('h1')?.textContent).toBe('First app')
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading First app')
    expect(container.querySelector('iframe')).toBeNull()

    const { frame, dispose } = makeFrame()
    await act(async () => request.resolve(frame))
    const iframe = container.querySelector('iframe')!
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-modals')
    expect(iframe.getAttribute('srcdoc')).toBe(frame.iframeHtml)
    expect(iframe.parentElement?.hasAttribute('inert')).toBe(true)
    expect(container.querySelector('h1')?.textContent).toBe('First app')
    expect(container.querySelector('[role="status"]')).not.toBeNull()

    allowFrameLoad = true
    await act(async () => iframe.dispatchEvent(new Event('load')))
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('h1')).toBeNull() // The frame now owns the app header.
    expect(iframe.parentElement?.hasAttribute('inert')).toBe(false)
    expect(dispose).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it.each(['unavailable', 'rejected'])('keeps the header and announces the error when the app is %s', async (outcome) => {
    const request = deferred<GatekeeperUiFrame | null>()
    auth.authenticatedApi.getGatekeeperApp.mockReturnValue(request.promise)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await mountRoute()
    await act(async () => {
      if (outcome === 'unavailable') request.resolve(null)
      else request.reject(new Error('Access denied'))
    })
    expect(container.querySelector('h1')?.textContent).toBe('First app')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      outcome === 'unavailable' ? 'not available' : 'Access denied',
    )
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('disposes a late frame after navigation and never displays it in the next app', async () => {
    const first = deferred<GatekeeperUiFrame | null>()
    const second = deferred<GatekeeperUiFrame | null>()
    auth.authenticatedApi.getGatekeeperApp.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const router = await mountRoute()
    await act(async () => router.navigate({ to: '/gatekeepers/$appId', params: { appId: 'second' } }))
    const stale = makeFrame()
    await act(async () => first.resolve(stale.frame))
    expect(stale.dispose).toHaveBeenCalledTimes(1)
    expect(container.querySelector('h1')?.textContent).toBe('Second app')
    expect(container.querySelector('iframe')).toBeNull()
    const next = makeFrame()
    await act(async () => second.resolve(next.frame))
    expect(container.querySelector('iframe')).not.toBeNull()
    await act(async () => root.render(null))
    expect(next.dispose).toHaveBeenCalledTimes(1)
    expect(stale.dispose).toHaveBeenCalledTimes(1)
  })

  it('releases an acquired frame on navigation without caching it for a return visit', async () => {
    const first = makeFrame()
    auth.authenticatedApi.getGatekeeperApp.mockResolvedValueOnce(first.frame).mockImplementation(() => new Promise(() => {}))
    const router = await mountRoute()
    await act(async () => router.navigate({ to: '/gatekeepers/$appId', params: { appId: 'second' } }))
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(container.querySelector('iframe')).toBeNull()
    await act(async () => router.navigate({ to: '/gatekeepers/$appId', params: { appId: 'first' } }))
    expect(auth.authenticatedApi.getGatekeeperApp.mock.calls.map(([id]) => id)).toEqual(['first', 'second', 'first'])
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('disposes a frame that arrives after unmount', async () => {
    const request = deferred<GatekeeperUiFrame | null>()
    auth.authenticatedApi.getGatekeeperApp.mockReturnValue(request.promise)
    await mountRoute()
    await act(async () => root.render(null))
    const late = makeFrame()
    await act(async () => request.resolve(late.frame))
    expect(late.dispose).toHaveBeenCalledTimes(1)
    expect(container.querySelector('iframe')).toBeNull()
  })
})
