import { createFileRoute } from '@tanstack/react-router'

/** Only the location changes. The parent owns the app across entry, nested paths and history. */
export const Route = createFileRoute('/gatekeepers_/$appId/$')({
  component: () => null,
})
