import { useEffect, useState } from 'react'
import { SkeletonLine } from '@cloudflare/kumo'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import SandboxedGatekeeperApp from './SandboxedGatekeeperApp'
import { reportIssue } from './errorReporting'

// The frame's `ui` is an RPC stub at runtime; dispose it to release the server-side capability.
function disposeFrame(frame: GatekeeperUiFrame | null) {
  (frame?.ui as { [Symbol.dispose]?(): void } | undefined)?.[Symbol.dispose]?.()
}

/**
 * Renders a gatekeeper's full-page management app (a sandboxed SPA the gatekeeper serves).
 * Fetches the app frame (iframe HTML + `ui` capability) from the backend and hosts it.
 */
const GatekeeperAppContent = ({ appId, title }: { appId: string; title: string }) => {
  const { authenticatedApi } = useAuthenticatedApi()
  // Wrap the frame in an object: it holds a `ui` RPC stub, and we never want useState's setter to
  // treat a stored value as an updater function.
  const [state, setState] = useState<{
    api: typeof authenticatedApi
  } & ({ frame: GatekeeperUiFrame; error?: never } | { error: string; frame?: never }) | null>(null)
  const [loadedFrame, setLoadedFrame] = useState<GatekeeperUiFrame | null>(null)
  // A replaced authenticated session must never render the previous session's capability.
  const current = state?.api === authenticatedApi ? state : null
  const frame = current?.frame
  const error = current?.error
  const loading = !error && (!frame || loadedFrame !== frame)

  useEffect(() => {
    let cancelled = false
    let acquired: GatekeeperUiFrame | null = null
    authenticatedApi
      .getGatekeeperApp(appId)
      .then((receivedFrame) => {
        if (!receivedFrame) {
          if (!cancelled) setState({ api: authenticatedApi, error: 'This app is not available on this deployment.' })
          return
        }
        if (cancelled) {
          disposeFrame(receivedFrame)
          return
        }
        acquired = receivedFrame
        setState({ api: authenticatedApi, frame: receivedFrame })
      })
      .catch((err) => {
        console.error('Failed to load gatekeeper app:', err)
        reportIssue('gatekeeper-app.load', err, {
          gatekeeperVendorId: appId,
        })
        if (!cancelled) setState({ api: authenticatedApi, error: `${err}` })
      })
    return () => {
      cancelled = true
      disposeFrame(acquired)
    }
  }, [authenticatedApi, appId])

  return (
    <div className="relative h-full min-h-0">
      {(loading || error) && (
        <div className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-12">
          <header>
            <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">{title}</h1>
          </header>
          {error ? (
            <p role="alert" className="mt-6 text-sm text-kumo-danger">{error}</p>
          ) : (
            <div role="status" aria-label={`Loading ${title}`} className="mt-6 space-y-5">
              <span className="sr-only">Loading {title}</span>
              <div aria-hidden="true" className="space-y-5">
                <SkeletonLine minWidth={30} maxWidth={30} className="h-9" />
                {[0, 1, 2].map((row) => (
                  <div key={row} className="rounded-lg border border-kumo-line p-5">
                    <SkeletonLine minWidth={60} maxWidth={80} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {frame && (
        // Keep the document loading without exposing a blank pane or focusable hidden content.
        // Once loaded, the app owns its header and localized data-loading states.
        <div className={loading ? 'invisible absolute inset-0' : 'h-full'} inert={loading}>
          <SandboxedGatekeeperApp
            frame={frame}
            gatekeeperVendorId={appId}
            onLoad={() => setLoadedFrame(frame)}
          />
        </div>
      )}
    </div>
  )
}

const GatekeeperAppPage = ({ appId, title = 'App' }: { appId: string; title?: string }) => (
  <GatekeeperAppContent key={appId} appId={appId} title={title} />
)

export default GatekeeperAppPage
