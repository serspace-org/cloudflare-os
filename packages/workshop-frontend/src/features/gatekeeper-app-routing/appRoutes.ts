/** Accept canonical ASCII identifier paths, with no ambiguous decoding or URL interpretation. */
export const validateAppPath = (path: string): string => {
  if (typeof path !== 'string' || path.length > 2048
    || !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(path)) {
    throw new TypeError('Invalid app-relative path.')
  }
  return path
}

/** Fix the namespace to one canonical vendor identifier, never a decoded URL delimiter. */
export const gatekeeperAppBase = (appId: string): string => {
  if (typeof appId !== 'string' || appId.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(appId)) {
    throw new TypeError('Invalid gatekeeper app identifier.')
  }
  return '/gatekeepers/' + appId
}

/** Read a canonical location within a fixed app base; encoded identifier letters still work. */
export const appPathFromLocation = (pathname: string, base: string): string | null => {
  const prefix = '/gatekeepers/'
  if (!pathname.startsWith(prefix)) return null
  const end = pathname.indexOf('/', prefix.length)
  const segment = pathname.slice(prefix.length, end === -1 ? undefined : end)
  let identifier: string
  try {
    identifier = decodeURIComponent(segment)
  } catch {
    return null
  }
  if (prefix + identifier !== base) return null
  try {
    return validateAppPath(end === -1 ? '/' : pathname.slice(end))
  } catch {
    return null
  }
}
