import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcPromise, RpcStub } from "capnweb";
import {
  actionChangeTime, type ActionHistoryFilter, type ActionLogEntry, type ActionsSubscriber,
  type AuthenticatedApi, type GatekeeperClient, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import type { ManualOwnerActionDecision } from "@gadgets/workshop-shared/gatekeeper";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, TEST_GATEKEEPER_WORKER, testActionState,
  testControl, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, RpcTarget, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

let harness: Harness;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

class ActionRecorder extends RpcTarget implements ActionsSubscriber {
  readonly entries: ActionLogEntry[] = [];
  readonly #ready = Promise.withResolvers<void>();
  readonly loaded = this.#ready.promise;
  entry(record: ActionLogEntry) { this.entries.push(record); }
  ready() { this.#ready.resolve(); }
}

async function listAll(ws: RpcStub<Overseer>, filter: ActionHistoryFilter, beforeId?: number) {
  const entries: ActionLogEntry[] = [];
  let pages = 0;
  do {
    const page = await ws.listActions({ filter, beforeId });
    entries.push(...page.entries);
    beforeId = page.nextBeforeId;
    pages++;
  } while (beforeId !== undefined);
  return { entries, pages };
}

async function approveWrite(ws: RpcStub<Overseer>, value: number): Promise<number> {
  const { entries } = await listAll(ws, "pending");
  const write = entries.find(e => e.description.title === `Set the test value to ${value}`);
  if (!write) throw new Error(`No pending write of ${value}`);
  await ws.approveAction(write.id);
  return write.id;
}

async function writeValues(session: RpcStub<TestSession>, from: number, to: number) {
  // Sequential, so action ids follow the values.
  for (let value = from; value < to; value++) await session.writeValue(value);
}

const ids = (entries: ActionLogEntry[]) => entries.map(e => e.id);
const idsDown = (from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, i) => from - i);

const actionState = (label: string) => testActionState(harness, label);

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

/** Protected actions need an actual connect callback, not an auto-provisioned identity. */
async function connectOwnerAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  const { url, nonce } = await api.connectAccount(TEST_VENDOR_ID);
  const label = new URL(url).pathname.slice("/connect/".length);
  const response = await harness.fetchWorker(TEST_GATEKEEPER_WORKER, url);
  expect(response.status).toBe(200);
  const literal = /var ticket = (".*?");\n/.exec(await response.text());
  if (!literal) throw new Error("The connect handoff page carried no ticket");
  await api.completeConnectHandoff(JSON.parse(literal[1]!), nonce);
  return waitFor("the explicitly connected account", async () =>
    (await listConnectedAccounts(api)).find(account => accountLabel(account) === label) ?? null);
}

const manualDecisions = async (label: string) => (await testControl<{
  decisions: Omit<ManualOwnerActionDecision, "connectionPrincipal">[];
}>(harness, "manual-decisions", { label })).decisions;

async function pendingWrite(ws: RpcStub<Overseer>, value: number) {
  return waitFor("the protected write to be pending", async () =>
    (await listAll(ws, "pending")).entries.find(entry =>
      entry.type === "action" && entry.description.title === `Set the test value to ${value}`) ?? null);
}

async function reopenAfterRestart(
    workspaceId: string, username: string, observerAccountId?: number) {
  return waitFor("the workspace to come back after the restart", async () => {
    using stack = new DisposableStack();
    // A fresh recorder per attempt, so a failed attempt can't consume a later one's responses.
    using callback = observerAccountId === undefined ? undefined : stubFor(
        new ObserverConfigRecorder().alwaysChoose(observerAccountId, MAX_OBSERVER_PROMPTS));
    try {
      const api = await logIn(stack.use(connect(harness.url)), username);
      const overseer = stack.use(await api.openWorkspace(workspaceId, undefined, callback));
      await overseer.getMetadata();
      return Object.assign(stack.move(), { overseer });
    } catch {
      return null;
    }
  });
}

it("pages, filters, streams and replays a workspace's action history", async () => {
  const [owner] = nextUsernames("historyowner");
  let workspaceId: string;
  let gatekeeperId: number;
  let watermark: Date;

  {
    using publicApi = connect(harness.url);
    using api = await signUp(publicApi, owner);
    await api.provisionAmbientAccount(TEST_VENDOR_ID);
    const account = await waitFor("the test account", async () =>
      (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
    using ws = await api.newWorkspace();
    workspaceId = (await ws.getMetadata()).id;
    using gatekeeper = await ws.newGatekeeper(
        account.id, "https://gadgets-test.example/things/action-history");
    if (!gatekeeper) throw new Error("Failed to create the test connection");
    gatekeeperId = await gatekeeper.getId();
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    await writeValues(session, 1000, 1055);

    const live = new ActionRecorder();
    using liveStub = stubFor(live);
    using _subscription = await ws.subscribeToActions(liveStub);
    await live.loaded;
    expect(live.entries).toEqual([]);
    await session.readValue();
    await waitFor("the live observation", async () => live.entries[0] ?? null);
    expect(live.entries).toMatchObject([{ id: 55, type: "observation" }]);

    const firstPending = await ws.listActions({ filter: "pending" });
    expect(firstPending.nextBeforeId).toBeDefined();
    const approvedId = await approveWrite(ws, 1000);
    const approved = await waitFor("the live approval", async () =>
      live.entries.find(e => e.id === approvedId && e.state === "approved") ?? null);
    const restPending = await listAll(ws, "pending", firstPending.nextBeforeId);
    expect(ids([...firstPending.entries, ...restPending.entries])).toEqual(idsDown(54, 1));

    const [all, actions, observations, pending] = await Promise.all(
        (["all", "action", "observation", "pending"] as const).map(filter => listAll(ws, filter)));
    expect(ids(all.entries)).toEqual(idsDown(55, 0));
    expect(all.pages).toBeGreaterThan(1);
    expect(ids([...observations.entries, ...actions.entries])).toEqual(ids(all.entries));
    expect(observations.entries).toMatchObject(
        [{ state: "approved", description: { title: "Read the test value" } }]);
    expect(actions.entries.map(e => e.state)).toEqual([...Array(54).fill("pending"), "approved"]);
    expect(pending.entries).toEqual(actions.entries.filter(e => e.state === "pending"));

    watermark = actionChangeTime(approved);
  }

  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, owner);
  using ws = await api.openWorkspace(workspaceId);
  using gatekeeper = await ws.getGatekeeperById(gatekeeperId);
  using session = await gatekeeper.openSession() as RpcStub<TestSession>;
  await writeValues(session, 1055, 1058);
  await approveWrite(ws, 1001);

  const replay = new ActionRecorder();
  using replayStub = stubFor(replay);
  const subscribing = ws.subscribeToActions(replayStub, watermark);
  const { entries } = await listAll(ws, "all");
  using _subscription = await subscribing;
  await replay.loaded;

  const replayed = new Map(replay.entries.map(e => [e.id, e]));
  expect(replayed.size).toBe(replay.entries.length);
  expect(replayed).toEqual(new Map(entries
      .filter(e => actionChangeTime(e) >= watermark)
      .map(e => [e.id, e])));
  expect([...replayed.keys()]).toEqual(expect.arrayContaining([0, 1, 56, 57, 58]));
  // Unchanged since long before the watermark; also fails if approval stops stamping appliedAt.
  expect(replayed.has(2)).toBe(false);
  const times = replay.entries.map(e => actionChangeTime(e).getTime());
  expect(times).toEqual(times.toSorted((a, b) => a - b));
});

it("approvals route to the account whose connection staged the write", async () => {
  const [alice, bob] = nextUsernames("routingalice", "routingbob");
  // Released before reopening; `using` covers early failures.
  using setup = new DisposableStack();
  const aliceApi = setup.use(await signUp(setup.use(connect(harness.url)), alice));
  const aliceAccount = await provisionAccount(aliceApi);
  const ws = setup.use(await aliceApi.newWorkspace());
  const workspaceId = (await ws.getMetadata()).id;
  const aliceGatekeeper = await ws.newGatekeeper(
      aliceAccount.id, "https://gadgets-test.example/things/routing-alice");
  if (!aliceGatekeeper) throw new Error("Failed to create Alice's connection");
  const aliceGatekeeperId = await setup.use(aliceGatekeeper).getId();

  const bobApi = setup.use(await signUp(setup.use(connect(harness.url)), bob));
  const bobAccount = await provisionAccount(bobApi);
  if (!await ws.addCollaborator(bob, "build")) throw new Error("Failed to add Bob");
  const callback = setup.use(stubFor(
      new ObserverConfigRecorder().alwaysChoose(bobAccount.id, MAX_OBSERVER_PROMPTS)));
  const bobWs = setup.use(await bobApi.openWorkspace(workspaceId, undefined, callback));
  // A live build collaborator makes this account-requiring connection restart the workspace
  // ~100ms after the call; pipelining getId() fetches the id before the abort.
  const bobGatekeeperId = await (bobWs.newGatekeeper(
      bobAccount.id, "https://gadgets-test.example/things/routing-bob") as
      RpcPromise<GatekeeperClient<any>>).getId();

  await waitFor("the restart to fell the old workspace instance", () =>
    ws.getMetadata().then(() => null, () => true));
  setup.dispose();

  using aliceSide = await reopenAfterRestart(workspaceId, alice);
  using bobSide = await reopenAfterRestart(workspaceId, bob, bobAccount.id);
  using aliceConnection = await aliceSide.overseer.getGatekeeperById(aliceGatekeeperId);
  using aliceSession = await aliceConnection.openSession() as RpcStub<TestSession>;
  using bobConnection = await bobSide.overseer.getGatekeeperById(bobGatekeeperId);
  using bobSession = await bobConnection.openSession() as RpcStub<TestSession>;
  // The fixture numbers actions per account.
  expect(await Promise.all([aliceSession.writeValue(21), bobSession.writeValue(22)]))
      .toEqual([1, 1]);

  const { entries } = await listAll(aliceSide.overseer, "pending");
  expect(entries).toHaveLength(2);
  const pendingFor = (gatekeeperId: number) => {
    const entry = entries.find(e => e.type === "action" && e.gatekeeperId === gatekeeperId);
    if (!entry) throw new Error(`No pending write for gatekeeper ${gatekeeperId}`);
    return entry;
  };
  const aliceEntry = pendingFor(aliceGatekeeperId);
  const bobEntry = pendingFor(bobGatekeeperId);
  const aliceLabel = accountLabel(aliceAccount);
  const bobLabel = accountLabel(bobAccount);
  await expect(actionState(aliceLabel)).resolves.toEqual(
      { pending: [{ id: 1, value: 21 }], applyCount: 0 });
  await expect(actionState(bobLabel)).resolves.toEqual(
      { pending: [{ id: 1, value: 22 }], applyCount: 0 });

  await aliceSide.overseer.approveAction(bobEntry.id);
  await expect(actionState(bobLabel)).resolves.toEqual({ pending: [], value: 22, applyCount: 1 });
  await expect(actionState(aliceLabel)).resolves.toEqual(
      { pending: [{ id: 1, value: 21 }], applyCount: 0 });

  await aliceSide.overseer.approveAction(aliceEntry.id);
  await expect(actionState(aliceLabel)).resolves.toEqual({ pending: [], value: 21, applyCount: 1 });
  expect((await actionState(bobLabel)).applyCount).toBe(1);
});

it("a build collaborator cannot apply or reserve the account owner's protected action", async () => {
  const [owner, collaborator] = nextUsernames("manualowner", "manualcollaborator");
  using stack = new DisposableStack();
  const ownerApi = stack.use(await signUp(stack.use(connect(harness.url)), owner));
  const ownerAccount = await connectOwnerAccount(ownerApi);
  const ws = stack.use(await ownerApi.newWorkspace());
  const workspaceId = (await ws.getMetadata()).id;
  const connection = await ws.newGatekeeper(
      ownerAccount.id, "https://gadgets-test.example/things/manual-owner");
  if (!connection) throw new Error("Failed to create the owner's connection");
  const gatekeeperId = await stack.use(connection).getId();

  const collaboratorApi = stack.use(await signUp(stack.use(connect(harness.url)), collaborator));
  const collaboratorAccount = await connectOwnerAccount(collaboratorApi);
  expect(await ws.addCollaborator(collaborator, "build")).toMatchObject({ role: "build" });
  const callback = stack.use(stubFor(new ObserverConfigRecorder()
      .alwaysChoose(collaboratorAccount.id, MAX_OBSERVER_PROMPTS)));
  const collaboratorWs = stack.use(await collaboratorApi.openWorkspace(workspaceId, undefined, callback));
  using session = await connection.openSession() as RpcStub<TestSession>;
  const actionId = await session.writeValue(71, { manualOwnerApproval: true });
  const entry = await pendingWrite(ws, 71);
  if (entry.type !== "action") throw new Error("Expected a pending action");
  const label = accountLabel(ownerAccount);

  await expect(collaboratorWs.approveAction(entry.id)).rejects.toThrow(/account owner/i);
  expect(await manualDecisions(label)).toEqual([]);
  expect(await testControl(harness, "apply-attempts", { label })).toEqual({ attempts: 0 });
  expect((await pendingWrite(ws, 71)).state).toBe("pending");
  expect((await actionState(label)).applyCount).toBe(0);

  await ws.approveAction(entry.id);
  expect(await actionState(label)).toEqual({ pending: [], value: 71, applyCount: 1 });
  const decisions = await manualDecisions(label);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    formatVersion: 1, mode: "manual", vendorId: TEST_VENDOR_ID, workspaceId,
    gatekeeperId, workshopActionId: entry.id, actionId,
    payloadHash: entry.description.manualOwnerApproval?.payloadHash,
  });
  expect(decisions[0].decisionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(Number.isFinite(Date.parse(decisions[0].decidedAt))).toBe(true);
  const approved = (await listAll(ws, "action")).entries.find(action => action.id === entry.id);
  expect(approved).toMatchObject({ state: "approved", autoApproved: false });
});

it("a permissive rule cannot apply a protected action, and a restart retries the exact manual decision",
    async () => {
  const [owner, collaborator] = nextUsernames("manualretryowner", "manualretrycollaborator");
  let workspaceId: string;
  let label: string;
  let entryId: number;
  let original: Omit<ManualOwnerActionDecision, "connectionPrincipal">;
  {
    using publicApi = connect(harness.url);
    using api = await signUp(publicApi, owner);
    const account = await connectOwnerAccount(api);
    label = accountLabel(account);
    using ws = await api.newWorkspace();
    workspaceId = (await ws.getMetadata()).id;
    using connection = await ws.newGatekeeper(
        account.id, "https://gadgets-test.example/things/manual-retry");
    if (!connection) throw new Error("Failed to create the owner's connection");
    const gatekeeperId = await connection.getId();
    using session = await connection.openSession() as RpcStub<TestSession>;
    await ws.setAutoApprovedActionKind(gatekeeperId, { tag: "set-value", label: "Set value" });
    // Prove this exact enabled rule is live before submitting the protected request.
    await session.writeValue(80, { autoApprovable: true });
    await waitFor("the ordinary write to be auto-approved", async () =>
      (await actionState(label)).applyCount === 1 || null);
    await session.writeValue(81, { autoApprovable: true, manualOwnerApproval: true });
    const entry = await pendingWrite(ws, 81);
    if (entry.type !== "action") throw new Error("Expected a pending action");
    entryId = entry.id;
    // The drain runs in waitUntil; use the same settle window as the auto-approval suite.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await pendingWrite(ws, 81)).state).toBe("pending");
    expect(await manualDecisions(label)).toEqual([]);
    expect((await actionState(label)).applyCount).toBe(1);
    expect(await testControl(harness, "apply-attempts", { label })).toEqual({ attempts: 1 });

    await testControl(harness, "fail-next-apply", { label, reason: "manual dispatch interrupted" });
    await expect(ws.approveAction(entryId)).rejects.toThrow("manual dispatch interrupted");
    const decisions = await manualDecisions(label);
    expect(decisions).toHaveLength(1);
    original = decisions[0];
    expect(original.payloadHash).toBe(entry.description.manualOwnerApproval?.payloadHash);
    expect((await pendingWrite(ws, 81)).state).toBe("pending");

    using collaboratorPublicApi = connect(harness.url);
    using collaboratorApi = await signUp(collaboratorPublicApi, collaborator);
    const collaboratorAccount = await connectOwnerAccount(collaboratorApi);
    await ws.addCollaborator(collaborator, "build");
    using callback = stubFor(new ObserverConfigRecorder()
        .alwaysChoose(collaboratorAccount.id, MAX_OBSERVER_PROMPTS));
    using collaboratorWs = await collaboratorApi.openWorkspace(workspaceId, undefined, callback);
    await collaboratorWs.getMetadata();
    // Like the routing case above: an account-requiring connection with a live collaborator
    // restarts the Overseer. Pipeline getId() before the scheduled abort closes these sessions.
    await (ws.newGatekeeper(account.id, "https://gadgets-test.example/things/manual-restart") as
        RpcPromise<GatekeeperClient<any>>).getId();
    await waitFor("the restart to fell the failed decision's workspace instance", () =>
      ws.getMetadata().then(() => null, () => true));
  }

  // Both the Overseer and authenticated browser session are new; no verifier survives the boundary.
  using reopened = await reopenAfterRestart(workspaceId, owner);
  const ws = reopened.overseer;
  await ws.approveAction(entryId);
  expect(await manualDecisions(label)).toEqual([original, original]);
  expect(await actionState(label)).toEqual({ pending: [], value: 81, applyCount: 2 });
  expect(await testControl(harness, "apply-attempts", { label })).toEqual({ attempts: 3 });
  expect((await listAll(ws, "action")).entries.find(entry => entry.id === entryId))
      .toMatchObject({ state: "approved", autoApproved: false });
});
