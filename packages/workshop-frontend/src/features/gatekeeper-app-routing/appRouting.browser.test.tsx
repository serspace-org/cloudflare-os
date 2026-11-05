/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createBrowserHistory, createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } from '@tanstack/react-router'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import type { GatekeeperAppNavigationHost, GatekeeperAppRoute, GatekeeperAppRouteReceiver } from '@gadgets/workshop-shared/app-navigation'
import GatekeeperAppPage from '../../GatekeeperAppPage'
import '../../styles.css'

const api = vi.hoisted(() => ({ getGatekeeperApp: vi.fn<() => Promise<GatekeeperUiFrame | null>>() }))
vi.hoisted(() => vi.stubEnv('VITE_GATEKEEPER_APP_ROUTES', '{"models":"example"}'))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('../../ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => null }))
vi.mock('../../errorReporting', () => ({ forwardTrustedFrameError: () => false, reportIssue: () => {} }))
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => [{ id: 'example', title: 'Models' }] }))
vi.mock('../../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
import { Route as AliasRoute } from '../../routes/$'

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
afterEach(async () => {
  host?.[Symbol.dispose]()
  host = undefined
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  restoreHistory?.()
  restoreHistory = undefined
  api.getGatekeeperApp.mockReset()
})

const mount = async (initial = '/models', aliased = true, browserHistory = false) => {
  api.getGatekeeperApp.mockImplementation(async () => ({
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
  const legacyRoute = createRoute({
    getParentRoute: () => rootRoute, path: '/models/$',
    component: () => <GatekeeperAppPage appId="example" appRouteBase={aliased ? '/models' : undefined} />,
  })
  const appRoute = aliased ? AliasRoute.update({
    id: '/$', path: '/$', getParentRoute: () => rootRoute,
  } as never) : legacyRoute
  const outputs = createRoute({ getParentRoute: () => rootRoute, path: '/outputs', component: () => <p>Output list</p> })
  const originalUrl = location.href
  if (browserHistory) window.history.replaceState({}, '', initial)
  const history = browserHistory ? createBrowserHistory() : createMemoryHistory({ initialEntries: [initial] })
  if (browserHistory) restoreHistory = () => {
    history.destroy()
    window.history.replaceState({}, '', originalUrl)
  }
  const router = createRouter({ history, routeTree: rootRoute.addChildren([appRoute, outputs]) })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  let ready = false
  const onReady = (event: MessageEvent) => { if (event.data?.type === 'synthetic-ready') ready = true }
  window.addEventListener('message', onReady)
  await act(async () => root!.render(<RouterProvider router={router} />))
  await vi.waitFor(() => expect(container!.querySelector('iframe')).not.toBeNull())
  await vi.waitFor(() => expect(ready).toBe(true))
  window.removeEventListener('message', onReady)
  const iframe = container.querySelector('iframe')!
  const { port1, port2 } = new MessageChannel()
  host = newMessagePortRpcSession<GatekeeperAppNavigationHost>(port1)
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2],
  }))
  return { router, history, iframe }
}

it('loads deep links through authenticated lookup and retains the frame and editor across push, replace and history', async () => {
  const { router, history, iframe } = await mount('/models/initial')
  using navigation = (await host!.getNavigation())!
  const receiver = new Receiver()
  receiver.setRoute(await navigation.subscribeRoute(receiver))
  expect(receiver.route.path).toBe('/initial')
  iframe.contentWindow!.postMessage({ type: 'synthetic-edit', value: 'unfinished text' }, '*')
  const readEditor = () => new Promise<string>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.data?.type !== 'synthetic-editor') return
      window.removeEventListener('message', onMessage)
      resolve(event.data.value)
    }
    window.addEventListener('message', onMessage)
    iframe.contentWindow!.postMessage({ type: 'synthetic-read' }, '*')
  })
  expect(await readEditor()).toBe('unfinished text')
  await act(async () => { await navigation.navigate('/second') })
  await vi.waitFor(() => expect(receiver.route.path).toBe('/second'))
  await act(async () => { await navigation.navigate('/replaced', true) })
  await vi.waitFor(() => expect(receiver.route.path).toBe('/replaced'))
  await act(async () => { history.back() })
  await vi.waitFor(() => expect(receiver.route.path).toBe('/initial'))
  await act(async () => { history.forward() })
  await vi.waitFor(() => expect(receiver.route.path).toBe('/replaced'))
  expect(router.state.location.pathname).toBe('/models/replaced')
  expect(container!.querySelector('iframe')).toBe(iframe)
  expect(await readEditor()).toBe('unfinished text')
  expect(api.getGatekeeperApp).toHaveBeenCalledExactlyOnceWith('example')
  await act(async () => { await navigation.navigate('/outputs') })
  expect(router.state.location.pathname).toBe('/models/outputs')
  for (const invalid of ['//evil.test', '/%2foutputs', '/../outputs', 'https://evil.test', '/a?x', '/a#x']) {
    await expect(navigation.navigate(invalid)).rejects.toThrow('Invalid app-relative path')
  }
  await expect(Reflect.get(navigation, 'navigate')('/valid', 'yes')).rejects.toThrow(/expected (union|boolean)/)
  await expect(Reflect.get(navigation, 'setBlocked')('false')).rejects.toThrow(/boolean/)
  expect(router.state.location.pathname).toBe('/models/outputs')
  // Local helpers must not be remotely callable through the app's narrow navigation capability.
  await expect(Reflect.get(navigation, 'updatePath')('/forged')).rejects.toThrow(/not|unknown|allowed|available/i)
})

it('keeps dirty internal navigation and host links in place on cancel, and commits only after discard', async () => {
  const { router, history, iframe } = await mount('/models/first', true, true)
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
  expect(router.state.location.pathname).toBe('/models/first')
  expect(receiver.route.path).toBe('/first')
  expect(container!.querySelector('iframe')).toBe(iframe)
  const second = navigation.navigate('/second')
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Discard and leave' }).click()
  await second
  await vi.waitFor(() => expect(receiver.route.path).toBe('/second'))
  history.back()
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(router.state.location.pathname).toBe('/models/second')
  history.back()
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Discard and leave' }).click()
  await vi.waitFor(() => expect(receiver.route.path).toBe('/first'))
  expect(container!.querySelector('iframe')).toBe(iframe)
  // The app must clear its dirty/busy state after receiving a confirmed route; the host never
  // silently clears it just because an app called navigate().
  await page.getByRole('link', { name: 'Outputs', exact: true }).click()
  await expect.element(page.getByText('Leave this app view?')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(router.state.location.pathname).toBe('/models/first')
  await navigation.setBlocked(false)
  await page.getByRole('link', { name: 'Outputs', exact: true }).click()
  await expect.element(page.getByText('Output list')).toBeVisible()
})

it('returns no navigation capability to legacy apps', async () => {
  await mount('/models', false)
  await expect(host!.getNavigation()).resolves.toBeNull()
})

it('does not replace the authenticated app lookup for unavailable apps', async () => {
  await mount()
  await act(async () => root!.unmount())
  root = undefined
  api.getGatekeeperApp.mockResolvedValue(null)
  const rootRoute = createRootRoute({ component: () => <GatekeeperAppPage appId="missing" appRouteBase="/missing" /> })
  const router = createRouter({ history: createMemoryHistory(), routeTree: rootRoute })
  root = createRoot(container!)
  await act(async () => root!.render(<RouterProvider router={router} />))
  await expect.element(page.getByText('This app is not available on this deployment.')).toBeVisible()
  expect(api.getGatekeeperApp).toHaveBeenLastCalledWith('missing')
  expect(container!.querySelector('iframe')).toBeNull()
})
