// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import type {
  GatekeeperUiFrame,
  GatekeeperUserSelection,
  GatekeeperUserSelectionReceiver,
} from "@gadgets/workshop-shared/gatekeeper";
import SandboxedGatekeeperApp from "./SandboxedGatekeeperApp";
import type GatekeeperUserPickerDialog from "./features/gatekeeper-sharing/GatekeeperUserPickerDialog";
import type * as Kumo from "@cloudflare/kumo";
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api';

const connect = vi.hoisted(() => vi.fn<() => Promise<string>>(async () => 'opened'));
vi.mock('./connectHandoff', () => ({ openConnectWindow: connect }));

// Most host cases use callback controls; the replacement race exercises the real picker state.
type PickerProps = ComponentProps<typeof GatekeeperUserPickerDialog>;
const picker = vi.hoisted(() => ({ props: null as PickerProps | null, real: false }));
vi.mock("./features/gatekeeper-sharing/GatekeeperUserPickerDialog", async (importOriginal) => {
  const { default: RealPicker } = await importOriginal<{
    default: typeof GatekeeperUserPickerDialog;
  }>();
  return {
    default: (props: PickerProps) => {
      picker.props = props;
      if (picker.real) return <RealPicker {...props} />;
      return <>
        <button type="button" aria-label="Close person picker" onClick={props.onClose} />
        <button type="button" aria-label="Cancel person picker" onClick={props.onCancel} />
      </>;
    },
  };
});

// The mock factory is hoisted; defer JSX until rendering, after its imports are initialized.
function DialogPart({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

vi.mock("@cloudflare/kumo", async (importOriginal) => {
  const actual = await importOriginal<typeof Kumo>();
  return { ...actual, Dialog: Object.assign(DialogPart, { Root: DialogPart, Title: DialogPart, Description: DialogPart }) };
});

vi.mock("./ThemeContext", () => ({
  useTheme: () => ({ resolvedThemeMode: "light" }),
}));

vi.mock("./ServerConfigContext", () => ({
  useServerConfig: () => ({ accentColor: "#7c3aed" }),
}));

vi.mock("./errorReporting", () => ({
  forwardTrustedFrameError: () => false,
}));

const WORKSPACE_ID = "a".repeat(64);

const listWorkspaces = vi.fn<() => Promise<{ id: string; title: string }[]>>(async () => [
  { id: WORKSPACE_ID, title: "Daily Brief" },
]);
let accounts: ConnectedAccountsSubscriber | undefined;
const subscriptionDisposed = vi.fn<() => void>();
const ensureAccountResources = vi.fn<(id: number, patterns: string[]) => Promise<{ url: string, nonce: string } | null>>(async () => ({ url: 'https://consent.example', nonce: 'a'.repeat(64) }));
const getGatekeeperApp = vi.fn<() => Promise<GatekeeperUiFrame>>(async () => ({ iframeHtml: '<!doctype html><title>Refreshed</title>', ui: new RpcStub(new EmptyUi()), workshopAccountId: 7 }));
const authenticatedApi = {
  listWorkspaces, ensureAccountResources, getGatekeeperApp,
  subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
    accounts = subscriber;
    return Object.assign(Promise.resolve(), { [Symbol.dispose]: subscriptionDisposed });
  },
};

const MODEL_PATTERN = 'serspace://models/current';
const publishAccount = (granted: string[] = [], id = 7, vendorId = 'scheduler') => {
  accounts!.add(id, { avatar: { url: '' }, displayName: 'App owner', grantedResourceUrlPatterns: granted },
    { displayName: 'Domain models', url: 'https://example.com' },
    [{ title: 'Domain models', description: 'Models', urlPattern: MODEL_PATTERN, grantable: true }], true, vendorId);
};

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface TestHost extends RpcTarget {
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  setPresenting(active: boolean): Promise<{
    rect: { left: number; top: number; width: number; height: number } | null;
    willResize: boolean;
  }>;
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
  selectUsers(receiver: GatekeeperUserSelectionReceiver | string): Promise<void>;
  requestResourceAccess(patterns: string[]): Promise<void>;
  refreshResourceAccess(): Promise<void>;
}

class EmptyUi extends RpcTarget {}

class TestThemeReceiver extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(_theme: GatekeeperAppTheme): void {}
}

/**
 * An app's receiver that behaves like an "immediate" one: each selection is sent to a simulated
 * backend (`backend`, released by the test) before it counts as accepted, and a ticket of "reject"
 * is refused with a user-facing message.
 */
class TestReceiver extends RpcTarget implements GatekeeperUserSelectionReceiver {
  received: GatekeeperUserSelection[] = [];
  backend: Promise<void> = Promise.resolve();
  disposed = false;
  disposeCount = 0;

  async receive(selection: GatekeeperUserSelection): Promise<void> {
    this.received.push(selection);
    if (selection.ticket === "reject") throw new Error("Collection not found.");
    await this.backend;
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.disposeCount++;
  }
}

const ALICE: GatekeeperUserSelection = { ticket: "a".repeat(64), profile: { displayName: "Alice" } };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SandboxedGatekeeperApp navigation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let host: RpcStub<TestHost> | undefined;

  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    listWorkspaces.mockClear();
    ensureAccountResources.mockClear();
    ensureAccountResources.mockResolvedValue({ url: 'https://consent.example', nonce: 'a'.repeat(64) });
    getGatekeeperApp.mockClear();
    subscriptionDisposed.mockClear();
    connect.mockClear();
    connect.mockResolvedValue('opened');
    accounts = undefined;
  });

  afterEach(async () => {
    host?.[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
    picker.props = null;
    picker.real = false;
  });

  // Mount the host under a router and complete the iframe's handshake, leaving `host` connected.
  async function mountApp(withAccount = false) {
    const frame = {
      iframeHtml: "<!doctype html><title>Scheduler</title>",
      ui: new RpcStub(new EmptyUi()),
      ...(withAccount ? { workshopAccountId: 7 } : {}),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({
      component: () => <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="scheduler" />,
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const gadgetRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspace/$id",
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      history,
      routeTree: rootRoute.addChildren([indexRoute, gadgetRoute]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("Missing gatekeeper iframe");
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "handshake" },
        origin: "null",
        source: iframe.contentWindow,
        ports: [port2],
      }),
    );
    return { iframe, router };
  }

  // Whether `promise` has settled by the next macrotask, without waiting for it.
  async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    await tick();
    return done;
  }

  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent === label);
    if (!button) throw new Error(`Missing ${label} button`);
    await act(async () => { button.click(); await tick(); });
  };

  const requestAccess = async () => {
    let promise!: Promise<void>;
    await act(async () => { promise = host!.requestResourceAccess([MODEL_PATTERN]); await tick(); });
    // Tests attach rejection handlers before triggering cancellation/teardown.
    promise.catch(() => {});
    await act(async () => { publishAccount(); accounts!.ready(); });
    return { promise };
  };

  it('requires trusted confirmation, scopes consent to the owning account, waits for its grant, and refreshes', async () => {
    const { router } = await mountApp(true);
    const { promise } = await requestAccess();
    expect(document.body.textContent).toContain('Allow app resource access?');
    expect(document.body.textContent).toContain('App owner');
    expect(ensureAccountResources).not.toHaveBeenCalled();
    let duplicate!: Promise<void>;
    await act(async () => { duplicate = host!.requestResourceAccess([MODEL_PATTERN, MODEL_PATTERN]); await tick(); });
    await expect(host!.requestResourceAccess(['unrelated://*'])).rejects.toThrow('already open');
    await click('Continue');
    expect(ensureAccountResources).toHaveBeenCalledExactlyOnceWith(7, [MODEL_PATTERN]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await settled(promise)).toBe(false);
    await act(async () => { publishAccount([MODEL_PATTERN], 8); });
    expect(await settled(promise)).toBe(false);
    expect(getGatekeeperApp).not.toHaveBeenCalled();
    await act(async () => { publishAccount([MODEL_PATTERN]); await tick(); });
    await expect(promise).resolves.toBeUndefined();
    await expect(duplicate).resolves.toBeUndefined();
    await act(async () => { await host!.refreshResourceAccess(); await tick(); });
    expect(getGatekeeperApp).toHaveBeenCalledExactlyOnceWith('scheduler');
    expect(container!.querySelector('iframe')!.srcdoc).toContain('Refreshed');
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.search).toEqual({});
    expect(subscriptionDisposed).toHaveBeenCalledTimes(1);
  });

  it('cancels without requesting consent and rejects unsupported or unbound requests', async () => {
    await mountApp(true);
    const { promise } = await requestAccess();
    await click('Cancel');
    await expect(promise).rejects.toThrow('cancelled');
    expect(ensureAccountResources).not.toHaveBeenCalled();
    await expect(host!.requestResourceAccess([])).rejects.toThrow('Invalid resource');
    let unsupported!: Promise<void>;
    await act(async () => { unsupported = host!.requestResourceAccess(['serspace://*']); unsupported.catch(() => {}); await tick(); });
    await act(async () => publishAccount());
    await expect(unsupported).rejects.toThrow('unsupported resource');
    expect(ensureAccountResources).not.toHaveBeenCalled();
  });

  it('does not claim a grant for a no-op ensure response or an unrelated account update', async () => {
    ensureAccountResources.mockResolvedValue(null);
    await mountApp(true);
    const { promise } = await requestAccess();
    await click('Continue');
    expect(await settled(promise)).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    await act(async () => publishAccount([MODEL_PATTERN], 8));
    expect(await settled(promise)).toBe(false);
    await click('Cancel');
    await expect(promise).rejects.toThrow('cancelled');
    expect(getGatekeeperApp).not.toHaveBeenCalled();
  });

  it('rejects blocked popups and revocation without refreshing', async () => {
    connect.mockRejectedValueOnce(new Error('Pop-up blocked.'));
    await mountApp(true);
    const first = await requestAccess();
    await click('Continue');
    await expect(first.promise).rejects.toThrow('Pop-up blocked');
    const second = await requestAccess();
    await click('Continue');
    await act(async () => accounts!.remove(7));
    await expect(second.promise).rejects.toThrow('removed');
    await act(async () => publishAccount([MODEL_PATTERN]));
    expect(getGatekeeperApp).not.toHaveBeenCalled();
  });

  it('does not open a late consent flow after cancellation or teardown', async () => {
    let complete!: (value: { url: string, nonce: string }) => void;
    ensureAccountResources.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await mountApp(true);
    const { promise } = await requestAccess();
    await click('Continue');
    await click('Cancel');
    await expect(promise).rejects.toThrow('cancelled');
    await act(async () => { complete({ url: 'https://late.example', nonce: 'b'.repeat(64) }); await tick(); });
    expect(connect).not.toHaveBeenCalled();
    const second = await requestAccess();
    await act(async () => root!.unmount());
    root = undefined;
    await expect(second.promise).rejects.toThrow('Peer closed');
    expect(getGatekeeperApp).not.toHaveBeenCalled();
  });

  it('fails closed without Workshop-owned account metadata', async () => {
    await mountApp();
    await expect(host!.requestResourceAccess([MODEL_PATTERN])).rejects.toThrow('unavailable');
    await expect(host!.refreshResourceAccess()).rejects.toThrow('No confirmed resource access');
    expect(ensureAccountResources).not.toHaveBeenCalled();
  });

  it('does not refresh a different owning account', async () => {
    const disposed = vi.fn<() => void>();
    getGatekeeperApp.mockResolvedValueOnce({
      iframeHtml: 'different account', workshopAccountId: 8,
      ui: { [Symbol.dispose]: disposed } as unknown as GatekeeperUiFrame['ui'],
    });
    await mountApp(true);
    const { promise } = await requestAccess();
    await click('Continue');
    await act(async () => { publishAccount([MODEL_PATTERN]); await tick(); });
    await expect(promise).rejects.toThrow('connection changed');
    expect(disposed).toHaveBeenCalledOnce();
    expect(container!.querySelector('iframe')!.srcdoc).not.toContain('different account');
  });

  it('disposes a late refreshed capability after the user cancels', async () => {
    let complete!: (frame: GatekeeperUiFrame) => void;
    getGatekeeperApp.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const disposed = vi.fn<() => void>();
    await mountApp(true);
    const { promise } = await requestAccess();
    await click('Continue');
    await act(async () => { publishAccount([MODEL_PATTERN]); await tick(); });
    await click('Cancel');
    await expect(promise).rejects.toThrow('cancelled');
    await act(async () => {
      complete({ iframeHtml: 'late capability', workshopAccountId: 7,
        ui: { [Symbol.dispose]: disposed } as unknown as GatekeeperUiFrame['ui'] });
      await tick();
    });
    expect(disposed).toHaveBeenCalledOnce();
    await expect(host!.refreshResourceAccess()).rejects.toThrow('No confirmed resource access');
    expect(container!.querySelector('iframe')!.srcdoc).not.toContain('late capability');
  });

  it("delivers each pick to the app's receiver while the picker is open, one picker at a time", async () => {
    await mountApp();
    const receiver = new TestReceiver();

    let pendingPick!: Promise<void>;
    await act(async () => {
      pendingPick = host!.selectUsers(receiver);
      await tick();
    });
    expect(picker.props).not.toBeNull();
    const refusedReceiver = new TestReceiver();
    await expect(host!.selectUsers(refusedReceiver)).rejects.toThrow("A person picker is already open.");
    await vi.waitFor(() => expect(refusedReceiver.disposeCount).toBe(1));
    await expect(host!.selectUsers("collection-1")).rejects.toThrow(TypeError);

    // The receiver decides when a selection counts as taken: it awaits its own backend call, and
    // the picker's delivery stays pending until then, while selectUsers() itself stays pending.
    let releaseBackend!: () => void;
    receiver.backend = new Promise<void>((resolve) => { releaseBackend = resolve; });
    const delivery = picker.props!.onSelected(ALICE);
    await vi.waitFor(() => expect(receiver.received).toEqual([ALICE]));
    expect(await settled(delivery)).toBe(false);
    releaseBackend();
    await expect(delivery).resolves.toBeUndefined();
    expect(await settled(pendingPick)).toBe(false);

    // A refused selection fails only that delivery; the picker and its session stay up.
    const refused: GatekeeperUserSelection = { ticket: "reject", profile: { displayName: "Bob" } };
    await expect(picker.props!.onSelected(refused)).rejects.toThrow("Collection not found.");
    expect(receiver.received).toEqual([ALICE, refused]);
    expect(await settled(pendingPick)).toBe(false);
    await expect(picker.props!.onSelected(ALICE)).resolves.toBeUndefined();

    // Closing resolves selectUsers() and releases the host's hold on the receiver.
    const closePicker = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close person picker"]',
    );
    if (!closePicker) throw new Error("Missing person picker close button");
    await act(async () => closePicker.click());
    await expect(pendingPick).resolves.toBeUndefined();
    await vi.waitFor(() => expect(receiver.disposed).toBe(true));

    // A new picker can open now, with a fresh receiver.
    const again = new TestReceiver();
    let secondPick!: Promise<void>;
    await act(async () => {
      secondPick = host!.selectUsers(again);
      await tick();
    });
    await expect(picker.props!.onSelected(ALICE)).resolves.toBeUndefined();
    expect(again.received).toEqual([ALICE]);
    await act(async () => picker.props!.onClose());
    await expect(secondPick).resolves.toBeUndefined();
  });

  it("starts a usable, empty picker when closing and reopening are batched", async () => {
    picker.real = true;
    await mountApp();
    let first!: Promise<void>;
    await act(async () => {
      first = host!.selectUsers(new TestReceiver());
      await tick();
    });
    const input = container!.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'previous@example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const done = () => [...container!.querySelectorAll('button')].find(button => button.textContent === 'Done')!;
    let second!: Promise<void>;
    await act(async () => {
      done().click();
      picker.props!.onClose();
      second = host!.selectUsers(new TestReceiver());
      await tick();
    });
    await first;
    expect(container!.querySelector('input')?.value).toBe('');
    expect(done().disabled).toBe(false);
    expect(await settled(second)).toBe(false);
    await act(async () => done().click());
    await expect(second).resolves.toBeUndefined();
  });

  it("cancels a stalled delivery and ignores its late callbacks after reopening", async () => {
    await mountApp();
    const receiver = new TestReceiver();
    let releaseBackend!: () => void;
    receiver.backend = new Promise<void>((resolve) => { releaseBackend = resolve; });
    let pendingPick!: Promise<void>;
    await act(async () => {
      pendingPick = host!.selectUsers(receiver);
      await tick();
    });
    const oldPicker = picker.props!;
    const delivery = oldPicker.onSelected(ALICE);
    // Disposal need not retract a call already accepted by the app.
    const deliveryOutcome = delivery.catch(() => {});
    await vi.waitFor(() => expect(receiver.received).toEqual([ALICE]));
    expect(await settled(delivery)).toBe(false);

    const cancelPicker = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Cancel person picker"]',
    );
    if (!cancelPicker) throw new Error("Missing person picker cancel button");
    await act(async () => cancelPicker.click());
    // Cancelling resolves at once, while the delivery is still running.
    await expect(pendingPick).resolves.toBeUndefined();
    expect(document.querySelector('button[aria-label="Cancel person picker"]')).toBeNull();
    // Closing must release the call itself, without waiting for the app's backend.
    await vi.waitFor(async () => expect(await settled(delivery)).toBe(true));
    await expect(delivery).rejects.toThrow(/RpcPromise was disposed/);
    await vi.waitFor(() => expect(receiver.disposeCount).toBe(1));

    const again = new TestReceiver();
    let secondPick!: Promise<void>;
    await act(async () => {
      secondPick = host!.selectUsers(again);
      await tick();
    });
    const newPicker = picker.props!;
    await act(async () => {
      oldPicker.onClose();
      oldPicker.onCancel();
    });
    await expect(oldPicker.onSelected(ALICE)).rejects.toThrow("Person selection cancelled.");
    releaseBackend();
    await deliveryOutcome;
    expect(await settled(secondPick)).toBe(false);
    expect(again.disposeCount).toBe(0);
    expect(receiver.disposeCount).toBe(1);
    await expect(newPicker.onSelected(ALICE)).resolves.toBeUndefined();
    expect(again.received).toEqual([ALICE]);
    await act(async () => newPicker.onClose());
    await expect(secondPick).resolves.toBeUndefined();
    await vi.waitFor(() => expect(again.disposeCount).toBe(1));
  });

  it("releases a stalled receiver and picker when the host unmounts", async () => {
    await mountApp();
    const receiver = new TestReceiver();
    let releaseBackend!: () => void;
    receiver.backend = new Promise<void>((resolve) => { releaseBackend = resolve; });
    let pendingPick!: Promise<void>;
    await act(async () => {
      pendingPick = host!.selectUsers(receiver);
      await tick();
    });
    const oldPicker = picker.props!;
    const delivery = oldPicker.onSelected(ALICE).catch(() => {});
    await vi.waitFor(() => expect(receiver.received).toEqual([ALICE]));
    // Teardown closes the app's connection, so the client sees a transport failure, not a cancel.
    await act(async () => root!.unmount());
    root = undefined;
    await expect(pendingPick).rejects.toThrow("Peer closed");
    await vi.waitFor(() => expect(receiver.disposeCount).toBe(1));
    oldPicker.onClose();
    oldPicker.onCancel();
    releaseBackend();
    await delivery;
    expect(receiver.disposeCount).toBe(1);
    expect(document.querySelector('button[aria-label="Close person picker"]')).toBeNull();
  });

  it("provides the deployment theme and routes bounded iframe requests", async () => {
    const { iframe, router } = await mountApp();

    const themeReceiver = new TestThemeReceiver();
    await expect(host!.subscribeTheme(themeReceiver)).resolves.toEqual({
      mode: "light",
      accentColor: "#7c3aed",
    });

    await act(async () => {
      await host!.setPresenting(true);
    });
    expect(iframe.style.position).toBe("fixed");
    expect(iframe.style.top).toBe("calc(var(--app-top) + env(safe-area-inset-top))");
    expect(iframe.style.bottom).toBe("calc(var(--app-bottom) + env(safe-area-inset-bottom))");
    expect(iframe.style.width).toBe(
      "calc(100vw - (env(safe-area-inset-left) + env(safe-area-inset-right)))",
    );
    expect(iframe.style.height).toBe(
      "calc(100vh - var(--app-top) - var(--app-bottom) - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
    );

    await act(async () => {
      await host!.setPresenting(false);
    });
    expect(iframe.style.position).toBe("");
    expect(iframe.style.width).toBe("100%");
    expect(iframe.style.height).toBe("100%");

    await act(async () => {
      await host!.openWorkspace(WORKSPACE_ID, 2);
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`),
      );
    });
    expect(router.state.location.search).toEqual({ w: 2 });

    // Live titles come from the user's own gadget list, never from the app's snapshot. Concurrent
    // and repeated frame requests share a bounded-lifetime host-side index.
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    listWorkspaces
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Daily Brief" }])
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Renamed Brief" }]);
    await expect(
      Promise.all([
        host!.resolveWorkspaceTitles([WORKSPACE_ID, "b".repeat(64)]),
        host!.resolveWorkspaceTitles([WORKSPACE_ID]),
      ]),
    ).resolves.toEqual([["Daily Brief", null], ["Daily Brief"]]);
    await expect(host!.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Daily Brief"]);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    now.mockReturnValue(30_000);
    await expect(host!.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Renamed Brief"]);
    expect(listWorkspaces).toHaveBeenCalledTimes(2);

    await expect(host!.openWorkspace("../evil")).rejects.toThrow(
      "Invalid gatekeeper app workspace target",
    );
    expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`);

    await act(async () => {
      await host!.openPrompt("  Create a daily brief.  ");
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });
    expect(router.state.location.search).toEqual({ prompt: "Create a daily brief." });
  });
});
