// Host-owned first segments, including HTTP endpoints not represented in the SPA route tree.
const reserved = new Set([
  'api', 'assets', 'blueprint', 'blueprints', 'blueprint-screenshot', 'connect',
  'explore', 'gadget', 'gatekeeper', 'gatekeepers', 'outputs', 'profile', 'providers',
  'signup', 'workspace', 'workspaces', 'context', 'admin', 'settings', 'login', 'logout', '.well-known',
])
const slugPattern = /^[a-z][a-z0-9-]{0,63}$/

export const parseAppRoutes = (json: string | undefined): ReadonlyMap<string, string> => {
  if (json && json.length > 16384) throw new Error('Gatekeeper app alias configuration is too large.')
  const value: unknown = JSON.parse(json || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('VITE_GATEKEEPER_APP_ROUTES must be an object.')
  }
  const entries = Object.entries(value)
  if (entries.length > 64) throw new Error('Too many gatekeeper app aliases.')
  const vendors = new Set<string>()
  const routes = new Map<string, string>()
  for (const [slug, vendor] of entries) {
    if (!slugPattern.test(slug) || reserved.has(slug) || typeof vendor !== 'string'
      || !slugPattern.test(vendor) || vendors.has(vendor)) {
      throw new Error('Invalid or conflicting gatekeeper app alias.')
    }
    vendors.add(vendor)
    routes.set(slug, vendor)
  }
  return routes
}

/** Accept canonical ASCII identifier paths, with no ambiguous decoding or URL interpretation. */
export const validateAppPath = (path: string): string => {
  if (typeof path !== 'string' || path.length > 2048
    || !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(path)) {
    throw new TypeError('Invalid app-relative path.')
  }
  return path
}

export const appRoutes = parseAppRoutes(import.meta.env.VITE_GATEKEEPER_APP_ROUTES)

export const appBase = (vendor: string, routes = appRoutes): string | undefined => {
  for (const [slug, id] of routes) if (id === vendor) return `/${slug}`
}

export const appLink = (vendor: string) => {
  const base = appBase(vendor)
  return base
    ? { to: '/$', params: { _splat: base.slice(1) } } as const
    : { to: '/gatekeepers/$appId', params: { appId: vendor } } as const
}

export const resolveAppRoute = (pathname: string, routes = appRoutes) => {
  const [, slug] = pathname.split('/')
  const vendor = routes.get(slug)
  if (!vendor) return null
  const base = `/${slug}`
  try {
    return { vendor, base, path: validateAppPath(pathname.slice(base.length) || '/') }
  } catch {
    return null
  }
}
