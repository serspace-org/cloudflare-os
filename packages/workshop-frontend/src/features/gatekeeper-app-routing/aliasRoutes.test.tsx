// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => vi.stubEnv('VITE_GATEKEEPER_APP_ROUTES', '{"models":"example"}'))
vi.mock('../../GatekeeperAppPage', () => ({
  default: ({ appId }: { appId: string }) => <p>App: {appId}</p>,
}))
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => [{ id: 'example', title: 'Models' }] }))
vi.mock('../../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
import { Route as AliasRoute } from '../../routes/$'
import { Route as LegacyRoute } from '../../routes/gatekeepers_.$appId'
import { appLink } from './appRoutes'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = () => {}
let root: Root | undefined
let container: HTMLElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
})

const renderAt = async (initial: string) => {
  const parent = createRootRoute({ component: () => <Outlet />, notFoundComponent: () => <p>Not found</p> })
  const alias = AliasRoute.update({ id: '/$', path: '/$', getParentRoute: () => parent } as never)
  const legacy = LegacyRoute.update({ id: '/gatekeepers_/$appId', path: '/gatekeepers/$appId', getParentRoute: () => parent } as never)
  const outputs = createRoute({ getParentRoute: () => parent, path: '/outputs', component: () => <p>Outputs</p> })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: parent.addChildren([outputs, alias, legacy]),
  })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(<RouterProvider router={router} />))
  await act(async () => { await router.load() })
  return router
}

it.each(['/models', '/models/opaque-model-id'])('resolves a configured alias on a fresh visit to %s', async (path) => {
  const router = await renderAt(path)
  expect(container!.textContent).toBe('App: example')
  expect(router.state.location.pathname).toBe(path)
})

it('replaces only legacy URLs whose vendor has a configured alias', async () => {
  const router = await renderAt('/gatekeepers/example')
  expect(router.state.location.pathname).toBe('/models')
  expect(router.history.length).toBe(1)
  await act(async () => { await router.navigate({ to: '/gatekeepers/$appId', params: { appId: 'other' } }) })
  expect(router.state.location.pathname).toBe('/gatekeepers/other')
  expect(container!.textContent).toBe('App: other')
  expect(appLink('example')).toEqual({ to: '/$', params: { _splat: 'models' } })
  expect(appLink('other')).toEqual({ to: '/gatekeepers/$appId', params: { appId: 'other' } })
})

it('lets real static routes win and leaves unknown paths Not Found', async () => {
  const router = await renderAt('/outputs')
  expect(container!.textContent).toBe('Outputs')
  await act(async () => { await router.navigate({ to: '/$', params: { _splat: 'unknown/id' } }) })
  expect(container!.textContent).toBe('Not found')
})
