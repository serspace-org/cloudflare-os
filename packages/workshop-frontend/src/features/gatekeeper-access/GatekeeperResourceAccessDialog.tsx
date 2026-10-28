import { useEffect, useRef, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter, type AccountEvent } from '../../accountsSubscriber'
import { openConnectWindow } from '../../connectHandoff'

type Props = {
  api: RpcStub<AuthenticatedApi>
  accountId: number
  vendorId: string
  patterns: string[]
  confirmed: boolean
  onFinish: (error?: Error) => void
}

/** Consent is rendered by Workshop, outside the requesting opaque-origin frame. */
export const GatekeeperResourceAccessDialog = ({ api, accountId, vendorId, patterns, confirmed, onFinish }: Props) => {
  const [account, setAccount] = useState<AccountEvent | null>(null)
  const accountRef = useRef<AccountEvent | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const active = useRef(true)
  const approved = useRef(false)
  const started = useRef(false)
  const controller = useRef(new AbortController())
  const finishRef = useRef(onFinish)
  finishRef.current = onFinish

  const finish = (error?: Error) => {
    if (!active.current && !error) return
    active.current = false
    controller.current.abort()
    finishRef.current(error)
  }
  const covers = (event: AccountEvent) => event.credentialsValid &&
    patterns.every(pattern => event.description.grantedResourceUrlPatterns?.includes(pattern))

  useEffect(() => {
    let cancelled = false
    active.current = true
    controller.current = new AbortController()
    // Must sit above even a full-viewport presenting app.
    const element = document.createElement('div')
    element.style.position = 'relative'
    element.style.zIndex = '2147483100'
    document.body.appendChild(element)
    setContainer(element)
    const subscription = api.subscribeConnectedAccounts(new AccountsSubscriberAdapter({
      add(event) {
        if (cancelled || event.id !== accountId) return
        if (!active.current) {
          if (event.vendorId !== vendorId || !covers(event)) {
            finish(new Error('The requested access was revoked.'))
          }
          return
        }
        if (event.vendorId !== vendorId || !event.credentialsValid) {
          finish(new Error('The app connection is no longer available.'))
          return
        }
        if (!patterns.every(pattern => event.supportedResources.some(resource =>
          resource.urlPattern === pattern && resource.grantable))) {
          finish(new Error('The app requested an unsupported resource type.'))
          return
        }
        accountRef.current = event
        setAccount(event)
        if (approved.current && started.current && covers(event)) finish()
      },
      remove(id) {
        if (cancelled) return
        if (id === accountId) finish(new Error('The app connection was removed.'))
      },
      ready() {
        if (cancelled) return
        if (!accountRef.current) finish(new Error('The app connection is no longer available.'))
      },
    }), { includeForcedAutoProvisionedAccounts: true })
    subscription.catch(() => { if (!cancelled) finish(new Error('Could not verify the app connection.')) })
    return () => {
      cancelled = true
      active.current = false
      controller.current.abort()
      subscription[Symbol.dispose]()
      element.remove()
    }
  }, [api, accountId, vendorId, patterns])

  const approve = async () => {
    if (!active.current || approved.current || !accountRef.current) return
    approved.current = true
    setWaiting(true)
    setNotice(null)
    try {
      const flow = await api.ensureAccountResources(accountId, patterns)
      if (!active.current) return
      started.current = true
      if (flow) {
        await openConnectWindow(flow, api, controller.current.signal)
        if (!active.current) return
      }
      if (accountRef.current && covers(accountRef.current)) {
        finish()
      } else {
        setNotice(flow
          ? 'Complete access approval in the browser window. Waiting for the updated account grant…'
          : 'Waiting for the account to confirm the requested access…')
      }
    } catch (error) {
      if (!active.current) return
      // A failed or blocked popup must never be reported as an approved grant.
      finish(error instanceof Error ? error : new Error('Could not request resource access.'))
    }
  }

  // Keep watching the exact account between the consent reply and the frame's refresh acknowledgment.
  if (!container || confirmed) return null
  return <Dialog.Root open onOpenChange={open => { if (!open) finish(new Error('Resource access cancelled.')) }}>
    <Dialog container={container} className="p-6">
      <Dialog.Title className="text-lg font-semibold">Allow app resource access?</Dialog.Title>
      <Dialog.Description className="mt-3 text-kumo-subtle">
        Workshop will request the following access for {account?.description.displayName ?? account?.description.uniqueName ?? 'this app account'} ({vendorId}). Only continue if you trust this app.
      </Dialog.Description>
      <ul className="my-4 space-y-2">
        {patterns.map(pattern => <li key={pattern} className="break-all font-mono text-sm">{pattern}</li>)}
      </ul>
      {notice && <p role="status" className="text-kumo-subtle">{notice}</p>}
      {waiting && <p className="mt-3 text-sm text-kumo-subtle">
        Cancelling stops waiting here. It does not revoke access approved in the browser window.
      </p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={() => finish(new Error('Resource access cancelled.'))}>Cancel</Button>
        <Button variant="primary" disabled={!account || waiting} onClick={() => { void approve() }}>
          {waiting ? 'Waiting for access…' : 'Continue'}
        </Button>
      </div>
    </Dialog>
  </Dialog.Root>
}
