# Connection and creation discovery

Gatekeepers advertise one list of resource **types** through
`GatekeeperVendor.getSupportedResources()`. Each `SupportedResource` has two independent flags:

- `connectable?: boolean` — offer an existing-resource picker and `requestConnection`. Defaults to
  **true** when omitted, so existing gatekeepers need no changes.
- `creatable?: boolean` — offer `createExternalResource` / `GatekeeperVendor.createResource()`.
  Defaults to **false** when omitted.

These are resource-type advertisements, not inventories of individual instances or grants of
access. Admin policy is keyed by the type's stable `urlPattern` and applies to both flows.

A document service can mark the same type `creatable: true` and leave `connectable` at its default.
A per-chat execution environment uses `connectable: false, creatable: true` to offer creation
without an existing-resource picker. Types with both flows disabled are hidden from discovery.
The account's `getSupportedResources()` may narrow the types it offers.

## Existing bindings

Discovery is for adding resources. It does not replace or invalidate existing workspace/chat
bindings. A gatekeeper continues serving those bindings through its ordinary session API, including
restoring a suspended external resource if needed. Creating a new resource is not how an existing
binding is resumed. Ownership, revocation, and resource access remain enforced by the gatekeeper.
Account consent, grant management, and observer verification still include creation-only types:
`connectable: false` does not remove the authorization needed to create or verify a resource.

## Creation

`creationConfigurator`, when needed, belongs on the resource type alongside `creatable`. Its
account UI, approval, simulation, and `applyCreation()` behavior are unchanged. Creating something
still needs approval and a chosen account; advertising creation creates or connects nothing.

Workshop filters resource types through deployment policy and checks the advertised creation type
and policy before minting its simulated gatekeeper. Existing-resource pickers and connection
request resolution exclude types marked `connectable: false`.

### Optional preparation input

`createExternalResource` accepts `creationInput?: string` in addition to `vendorId`,
`resourceUrlPattern`, `title`, and `bindingName`. Workshop forwards the string unchanged through
the Overseer and User DO to `GatekeeperVendor.createResource(resourceUrlPattern, title,
creationInput?)`. When it is omitted, the vendor still receives exactly two arguments, preserving
compatibility with existing RPC implementations.

The string is opaque to Workshop. A vendor may use it as a locator for read-only preparation of
a frozen proposal and its review card. It is **not approval**, user identity, an account selector,
or permission to publish. Vendors must validate their input without external writes and continue
enforcing selected-account authorization when the approved creation is applied. Do not log the
opaque input or include it in error messages.

Keep `resourceUrlPattern` equal to the exact advertised creatable type; do not substitute a
concrete proposal locator. Admin policy and the returned resource-type equality check still use
that advertised pattern. This parameter does not change connection selection, observer checks,
approval behavior, or existing action authority.
