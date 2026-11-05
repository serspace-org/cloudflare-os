import { createFileRoute, notFound } from '@tanstack/react-router'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { resolveAppRoute } from '../features/gatekeeper-app-routing/appRoutes'
import { useGatekeeperApps } from '../useGatekeeperApps'
import { useDocumentTitle } from '../useDocumentTitle'

const AliasedApp = () => {
  const { vendor, base } = Route.useLoaderData()
  const app = useGatekeeperApps().find((entry) => entry.id === vendor)
  useDocumentTitle(app?.title ?? 'App')
  return <GatekeeperAppPage key={vendor} appId={vendor} appRouteBase={base} />
}

export const Route = createFileRoute('/$')({
  loader: ({ location }) => {
    const route = resolveAppRoute(location.pathname)
    if (!route) throw notFound()
    return route
  },
  component: AliasedApp,
})
