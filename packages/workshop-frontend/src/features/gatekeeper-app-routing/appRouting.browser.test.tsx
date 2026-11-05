/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createBrowserHistory, createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } from '@tanstack/react-router'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import type { GatekeeperAppNavigationHost, GatekeeperAppRoute, GatekeeperAppRouteReceiver } from '@gadgets/workshop-shared/app-navigation'
import '../../styles.css'

const api = vi.hoisted(() => ({ getGatekeeperApp: vi.fn<(id: string) => Promise<GatekeeperUiFrame | null>>() }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('../../ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => null }))
vi.mock('../../errorReporting', () => ({ forwardTrustedFrameError: () => false, reportIssue: () => {} }))
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => [{ id: 'example', title: 'Example' }] }))
vi.mock('../../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
import { Route as AppRoute } from '../../routes/gatekeepers_.$appId'
import { Route as NestedRoute } from '../../routes/gatekeepers_.$appId.$'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

class EmptyUi extends RpcTarget {}
class Receiver extends RpcTarget implements GatekeeperAppRouteReceiver {
  route: GatekeeperAppRoute = { path: '/', revision: -1 }
  setRoute(route: GatekeeperAppRoute) {
    if (route.revision > this.route.revision) this.route = route
  }
}

let root: Root | undefined
let container: HTMLElement | undefined
let host: RpcStub<GatekeeperAppNavigationHost> | undefined
let restoreHistory: (() => void) | undefined
let readyWindows = new WeakSet<object>()
const onReady = (event: MessageEvent) => {
  if (event.source && event.data?.type === 'synthetic-ready') readyWindows.add(event.source)
}
afterEach(async () => {
  host?.[Symbol.dispose]()
  host = undefined
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  restoreHistory?.()
  restoreHistory = undefined
  api.getGatekeeperApp.mockReset()
  window.removeEventListener('message', onReady)
  readyWindows = new WeakSet<object>()
})

const handshake = (iframe: HTMLIFrameElement) => {
  host?.[Symbol.dispose]()
  const { port1, port2 } = new MessageChannel()
  host = newMessagePortRpcSession<GatekeeperAppNavigationHost>(port1)
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2],
  }))
}

const mount = async (initial = '/gatekeepers/example', browserHistory = false) => {
  api.getGatekeeperApp.mockImplementation(async (id) => id === 'missing' ? null : ({
    iframeHtml: `<!doctype html><title>Synthetic app</title><input aria-label="Editor" value="draft">
      <script>
        window.addEventListener('message', event => {
          if (event.source !== parent) return;
          const input = document.querySelector('input');
          if (event.data.type === 'synthetic-edit') input.value = event.data.value;
          if (event.data.type === 'synthetic-read') parent.postMessage({type: 'synthetic-editor', value: input.value}, '*');
        });
        parent.postMessage({type: 'synthetic-ready'}, '*');
      </script>`,
    ui: new RpcStub<RpcTarget>(new EmptyUi()),
  }))
  const rootRoute = createRootRoute({ component: () => <>
    <Link to="/outputs">Outputs</Link><Outlet />
  </> })
  // Use the production route components and hierarchy, not a test-only catch-all route.
  const appRoute = AppRoute.update({
    id: '/gatekeepers_/$appId', path: '/gatekeepers/$appId', getParentRoute: () => rootRoute,
  } as never)
  const nested = NestedRoute.update({ id: '/$', path: '/$', getParentRoute: () => appRoute } as never)
  const outputs = createRoute({ getParentRoute: () => rootRoute, path: '/outputs', component: () => <p>Output list</p> })
  const originalUrl = location.href
  if (browserHistory) window.history.replaceState({}, '', initial)
  const history = browserHistory ? createBrowserHistory() : createMemoryHistory({ initialEntries: [initial] })
  restoreHistory = () => {
    history.destroy()
    if (browserHistory) window.history.replaceState({}, '', originalUrl)
  }
  const router = createRouter({ history, routeTree: rootRoute.addChildren([appRoute.addChildren([nested]), outputs]) })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  window.addEventListener('message', onReady)
  await act(async () => root!.render(<RouterProvider router={router} />))
  await vi.waitFor(() => expect(router.state.status).toBe('idle'))
  return { router, history }
}

const connect = async () => {
  await vi.waitFor(() => expect(container!.querySelector('iframe')).not.toBeNull())
  const iframe = container!.querySelector('iframe')!
  await vi.waitFor(() => expect(readyWindows.has(iframe.contentWindow!)).toBe(true))
  expect(await readEditor(iframe)).toBe('draft')
  handshake(iframe)
  return iframe
}

const readEditor = (iframe: HTMLIFrameElement) => new Promise<string>((resolve) => {
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.data?.type !== 'synthetic-editor') return
    window.removeEventListener('message', onMessage)
    resolve(event.data.value)
  }
  window.addEventListener('message', onMessage)
  iframe.contentWindow!.postMessage({ type: 'synthetic-read' }, '*')
})

it('retains acquisition, iframe and edited input from root through index/detail/root and Back/Forward', async () => {
  const { router, history } = await mount()
  const iframe = await connect()
  using navigation = (await host!.getNavigation())!
  const receiver = new Receiver()
  receiver.setRoute(await navigation.subscribeRoute(receiver))
  expect(receiver.route.path).toBe('/')
  iframe.contentWindow!.postMessage({ type: 'synthetic-edit', value: 'unfinished text' }, '*')
  expect(await readEditor(iframe)).toBe('unfinished text')
  const detail = '/domain-models/5d4f8b32-8b66-4c62-b331-11bf59658456'
  for (const path of ['/domain-models', detail, '/domain-models', '/']) {
    await act(async () => { await navigation.navigate(path) })
    await vi.waitFor(() => expect(receiver.route.path).toBe(path))
    expect(container!.querySelector('iframe')).toBe(iframe)
    expect(await readEditor(iframe)).toBe('unfinished text')
  }
  await act(async () => { history.back() })
  await vi.waitFor(() => expect(receiver.route.path).toBe('/domain-models'))
  await act(async () => { history.back() })
  await vi.waitFor(() => expect(receiver.route.path).toBe(detail))
  await act(async () => { history.forward() })
  await vi.waitFor(() => expect(receiver.route.path).toBe('/domain-models'))
  expect(container!.querySelector('iframe')).toBe(iframe)
  expect(await readEditor(iframe)).toBe('unfinished text')
  expect(api.getGatekeeperApp).toHaveBeenCalledExactlyOnceWith('example')
  await act(async () => { await navigation.navigate('/outputs', true) })
  expect(router.state.location.pathname).toBe('/gatekeepers/example/outputs')
  // Even an apparently cross-app host path remains under this app's fixed namespace.
  await act(async () => { await navigation.navigate('/gatekeepers/other') })
  expect(router.state.location.pathname).toBe('/gatekeepers/example/gatekeepers/other')
  for (const invalid of ['//evil.test', '/%2foutputs', '/../outputs', 'https://evil.test', '/a?x', '/a#x', '/a//b']) {
    await expect(navigation.navigate(invalid)).rejects.toThrow('Invalid app-relative path')
  }
  // @ts-expect-error Deliberately invalid RPC argument tests runtime validation, not TypeScript.
  await expect(navigation.navigate('/valid', 'yes')).rejects.toThrow(/expected (union|boolean)/)
  // @ts-expect-error Deliberately invalid RPC argument tests runtime validation, not TypeScript.
  await expect(navigation.setBlocked('false')).rejects.toThrow(/boolean/)
  // @ts-expect-error Private host update helpers must not be remotely callable.
  await expect(navigation.updatePath('/forged')).rejects.toThrow(/not|unknown|allowed|available/i)
})

it('loads a nested entry directly using authenticated lookup', async () => {
  await mount('/gatekeepers/example/domain-models/opaque-id')
  await connect()
  using navigation = (await host!.getNavigation())!
  const receiver = new Receiver()
  receiver.setRoute(await navigation.subscribeRoute(receiver))
  expect(receiver.route.path).toBe('/domain-models/opaque-id')
  expect(api.getGatekeeperApp).toHaveBeenCalledExactlyOnceWith('example')
})

it('guards app/internal, host sidebar, Back and reload; cancel retains the frame, discard commits', async () => {
  const { router, history } = await mount('/gatekeepers/example/first', true)
  const iframe = await connect()
  using navigation = (await host!.getNavigation())!
  const receiver = new Receiver()
  receiver.setRoute(await navigation.subscribeRoute(receiver))
  await navigation.setBlocked(true)
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  const transition = navigation.navigate('/second')
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await transition
  expect(router.state.location.pathname).toBe('/gatekeepers/example/first')
  expect(receiver.route.path).toBe('/first')
  const second = navigation.navigate('/second')
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Discard and leave' }).click()
  await second
  await vi.waitFor(() => expect(receiver.route.path).toBe('/second'))
  history.back()
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(router.state.location.pathname).toBe('/gatekeepers/example/second')
  history.back()
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Discard and leave' }).click()
  await vi.waitFor(() => expect(receiver.route.path).toBe('/first'))
  expect(container!.querySelector('iframe')).toBe(iframe)
  history.forward()
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(router.state.location.pathname).toBe('/gatekeepers/example/first')
  history.forward()
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Discard and leave' }).click()
  await vi.waitFor(() => expect(receiver.route.path).toBe('/second'))
  await page.getByRole('link', { name: 'Outputs', exact: true }).click()
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(router.state.location.pathname).toBe('/gatekeepers/example/second')
  await page.getByRole('link', { name: 'Outputs', exact: true }).click()
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Discard and leave' }).click()
  await expect.element(page.getByText('Output list')).toBeVisible()
})

it('switches app identity with fresh UI and no stale leave guard', async () => {
  const { router } = await mount()
  const first = await connect()
  using navigation = (await host!.getNavigation())!
  await navigation.setBlocked(true)
  const next = router.navigate({ to: '/gatekeepers/$appId', params: { appId: 'other' } })
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Discard and leave' }).click()
  await next
  await vi.waitFor(() => expect(container!.querySelector('iframe')).not.toBe(first))
  const second = await connect()
  expect(second).not.toBe(first)
  expect(api.getGatekeeperApp.mock.calls).toEqual([['example'], ['other']])
  await page.getByRole('link', { name: 'Outputs', exact: true }).click()
  await expect.element(page.getByText('Output list')).toBeVisible()
})

it('keeps older apps working without requesting the optional navigation capability', async () => {
  const { router } = await mount()
  const iframe = await connect()
  expect(await readEditor(iframe)).toBe('draft')
  await page.getByRole('link', { name: 'Outputs', exact: true }).click()
  expect(router.state.location.pathname).toBe('/outputs')
})

it('preserves unavailable-app handling on nested entries', async () => {
  await mount('/gatekeepers/missing/domain-models')
  await expect.element(page.getByText('This app is not available on this deployment.')).toBeVisible()
  expect(api.getGatekeeperApp).toHaveBeenCalledExactlyOnceWith('missing')
  expect(container!.querySelector('iframe')).toBeNull()
})

it('rejects malformed nested browser paths before acquiring a capability', async () => {
  await mount('/gatekeepers/example/domain-models/%2fescape')
  expect(api.getGatekeeperApp).not.toHaveBeenCalled()
  expect(container!.querySelector('iframe')).toBeNull()
})

it.each(['example%2fother', 'example%3fquery', '%2e%2e', '.'])('rejects decoded delimiter or dot app ID %s before acquiring UI', async (appId) => {
  await mount('/gatekeepers/' + appId + '/domain-models')
  expect(api.getGatekeeperApp).not.toHaveBeenCalled()
  expect(container!.querySelector('iframe')).toBeNull()
})

it('preserves harmless encoded app ID letters and navigates under the canonical fixed base', async () => {
  const { router } = await mount('/gatekeepers/%65xample/domain-models')
  await connect()
  using navigation = (await host!.getNavigation())!
  await navigation.navigate('/outputs')
  expect(router.state.location.pathname).toBe('/gatekeepers/example/outputs')
  expect(api.getGatekeeperApp).toHaveBeenCalledExactlyOnceWith('example')
})
