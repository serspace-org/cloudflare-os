import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ActionDescription, ManualOwnerActionDecision } from "@gadgets/workshop-shared/gatekeeper";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const GK = 7;
const HASH = "a".repeat(64);
const OWNER = { userId: "owner-id", connectionPrincipal: "b".repeat(64) };
const PROFILE = { type: "user" as const, id: "owner@example.com", name: "Owner" };
const FOREIGN = { userId: "other-id", connectionPrincipal: "c".repeat(64) };

function description(): ActionDescription {
  return {
    title: "Publish model",
    description: "Publish the reviewed model snapshot.",
    implementsRevert: false,
    autoApprovable: true,
    actionKind: { tag: "publish", label: "Publications" },
    manualOwnerApproval: { formatVersion: 1, payloadHash: HASH },
  };
}

// Match the other Overseer chokepoint tests: real implementation and SQLite, with only the
// external gatekeeper facet substituted. Private implementation access is test-fixture-only.
async function inOverseer(name: string, fn: (impl: any) => Promise<void>) {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`manual-owner-${name}`),
      async (instance: OverseerDurableObject) => {
        let impl = (instance as unknown as { impl: any }).impl;
        impl.storage.gatekeepers.put({
          id: GK,
          resourceTitle: "Model catalog",
          class: {} as any,
          creationSpec: { type: "gatekeeper", vendorId: "serspace",
            resourceUrl: "https://example.com/models", typeUrlPattern: "https://*" },
        });
        await fn(impl);
      });
}

async function submit(impl: any, value = description()) {
  await impl.submitAction(GK, 19, value, { from: "user" });
  return Array.from(impl.storage.actions.list()).find((a: any) => a.type === "action") as any;
}

function deferred() {
  let resolve!: () => void;
  let promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function facet() {
  return {
    applyAction: vi.fn(async (_action: number, _cache: any) => {}),
    verifyManualOwnerAction: vi.fn(async (action: number, principal: string, hash: string) => {
      expect(action).toBe(19);
      expect(hash).toBe(HASH);
      if (principal !== OWNER.connectionPrincipal) throw new Error("Not the connection owner");
    }),
    applyActionWithManualOwnerApproval: vi.fn(async (_action: number, _cache: any, verifier: any) => {
      await verifier.getDecision();
    }),
  };
}

describe("manual owner publication approval through the Overseer", () => {
  it.each(["unknown outcome", "confirmed approval"])(
      "does not overwrite concurrent %s with rejectAction's stale snapshot", async outcome => {
    await inOverseer(`reject-race-${outcome}`, async impl => {
      let record = await submit(impl);
      let gatekeeper = facet();
      let rejectionEntered = deferred();
      let releaseRejection = deferred();
      let rejectingFacet = {
        ...gatekeeper,
        rejectAction: vi.fn(async (action: number) => {
          expect(action).toBe(19);
          rejectionEntered.resolve();
          await releaseRejection.promise;
        }),
      };
      gatekeeper.applyActionWithManualOwnerApproval.mockImplementation(async (_action, _cache, verifier) => {
        await verifier.getDecision();
        if (outcome === "unknown outcome") throw new Error("unknown publication outcome");
      });
      impl.getGatekeeperFacet = () => rejectingFacet;
      using client = await openFakeOverseer(impl.storage, { impl: {
        ctx: impl.ctx,
        gitCache: impl.gitCache,
        getGatekeeperFacet: impl.getGatekeeperFacet,
        traceAgentActionApproval: impl.traceAgentActionApproval.bind(impl),
        drainAutoApprovals: impl.drainAutoApprovals.bind(impl),
      } });
      // The provider call proves rejectAction already captured its pre-approval snapshot.
      let rejection = Promise.resolve(client.rejectAction(record.id));
      await rejectionEntered.promise;
      try {
        let approval = impl.applyPendingAction(record, PROFILE, false, undefined, OWNER);
        if (outcome === "unknown outcome") {
          await expect(approval).rejects.toThrow(/unknown publication outcome/);
        } else {
          await approval;
        }
        let afterApproval = impl.storage.actions.get(record.id);
        expect(afterApproval.manualOwnerDecision.userId).toBe(OWNER.userId);
        expect(afterApproval.state).toBe(outcome === "unknown outcome" ? "pending" : "approved");
        releaseRejection.resolve();
        await rejection;
        let afterRejection = impl.storage.actions.get(record.id);
        expect(afterRejection.manualOwnerDecision).toEqual(afterApproval.manualOwnerDecision);
        expect(afterRejection.state).toBe(outcome === "unknown outcome" ? "rejected" : "approved");
        if (outcome === "confirmed approval") {
          expect(afterRejection.resolvedBy).toEqual(PROFILE);
          expect(afterRejection.appliedAt).toEqual(afterApproval.appliedAt);
        }
        expect(gatekeeper.applyAction).not.toHaveBeenCalled();
      } finally {
        releaseRejection.resolve();
        await rejection;
      }
    });
  });

  it("reloads a failed dispatch's original durable decision after a real DO abort", async () => {
    let name = "restart-durability";
    let saved: any;
    let actionId!: number;
    await inOverseer(name, async impl => {
      let record = await submit(impl);
      actionId = record.id;
      let gatekeeper = facet();
      gatekeeper.applyActionWithManualOwnerApproval.mockImplementation(async (_action, _cache, verifier) => {
        await verifier.getDecision();
        throw new Error("dispatch result unavailable");
      });
      impl.getGatekeeperFacet = () => gatekeeper;
      await expect(impl.applyPendingAction(record, PROFILE, false, undefined, OWNER))
          .rejects.toThrow(/dispatch result unavailable/);
      saved = structuredClone(impl.storage.actions.get(record.id).manualOwnerDecision);
    });

    await abortAllDurableObjects();
    // Mint a fresh namespace stub and read the actual SQLite record in a new invocation. No
    // fixture restores the record or the connection, and the previous facet override is gone.
    await runInDurableObject(env.TEST_OVERSEER.getByName(`manual-owner-${name}`),
        async (instance: OverseerDurableObject) => {
          let impl = (instance as unknown as { impl: any }).impl;
          let record = impl.storage.actions.get(actionId);
          expect(record.state).toBe("pending");
          expect(record.manualOwnerDecision).toEqual(saved);
          let gatekeeper = facet();
          gatekeeper.applyActionWithManualOwnerApproval.mockImplementation(async (_action, _cache, verifier) => {
            expect(await verifier.getDecision()).toEqual(saved.decision);
          });
          impl.getGatekeeperFacet = () => gatekeeper;
          await impl.applyPendingAction(record, { ...PROFILE, name: "New session profile" }, false,
              undefined, OWNER);
          let approved = impl.storage.actions.get(actionId);
          expect(approved.state).toBe("approved");
          expect(approved.manualOwnerDecision).toEqual(saved);
          expect(approved.resolvedBy).toEqual(PROFILE);
          expect(gatekeeper.applyAction).not.toHaveBeenCalled();
        });
  });

  it.each([
    null,
    {},
    { formatVersion: 2, payloadHash: HASH },
    { formatVersion: 1, payloadHash: "short" },
    { formatVersion: 1, payloadHash: "g".repeat(64) },
    { formatVersion: 1, payloadHash: HASH, extra: true },
  ])("rejects a malformed approval marker at submission: %j", async marker => {
    await inOverseer(`malformed-${JSON.stringify(marker)}`, async impl => {
      let value = { ...description(), manualOwnerApproval: marker } as any;
      await expect(impl.submitAction(GK, 19, value, { from: "user" }))
          .rejects.toThrow(/manual owner-approval requirement/);
      expect(Array.from(impl.storage.actions.list())).toEqual([]);
    });
  });

  it("rejects automatic and unauthenticated protected applies without reserving a decision", async () => {
    await inOverseer("automatic", async impl => {
      let record = await submit(impl);
      let gatekeeper = facet();
      impl.getGatekeeperFacet = () => gatekeeper;
      await expect(impl.applyPendingAction(record, PROFILE, true, undefined, OWNER))
          .rejects.toThrow(/manual owner approval/);
      await expect(impl.applyPendingAction(record, PROFILE, false))
          .rejects.toThrow(/manual owner approval/);
      expect(impl.storage.actions.get(record.id).manualOwnerDecision).toBeUndefined();
      expect(gatekeeper.verifyManualOwnerAction).not.toHaveBeenCalled();
      expect(gatekeeper.applyActionWithManualOwnerApproval).not.toHaveBeenCalled();
      expect(gatekeeper.applyAction).not.toHaveBeenCalled();
    });
  });

  it("does not let a foreign owner reserve or poison the rightful owner's decision", async () => {
    await inOverseer("foreign", async impl => {
      let record = await submit(impl);
      let gatekeeper = facet();
      impl.getGatekeeperFacet = () => gatekeeper;
      await expect(impl.applyPendingAction(record, PROFILE, false, undefined, FOREIGN))
          .rejects.toThrow(/Not the connection owner/);
      expect(impl.storage.actions.get(record.id).manualOwnerDecision).toBeUndefined();
      expect(gatekeeper.applyActionWithManualOwnerApproval).not.toHaveBeenCalled();
      await impl.applyPendingAction(record, PROFILE, false, undefined, OWNER);
      expect(impl.storage.actions.get(record.id).state).toBe("approved");
      expect(impl.storage.actions.get(record.id).manualOwnerDecision.userId).toBe(OWNER.userId);
      expect(gatekeeper.applyActionWithManualOwnerApproval).toHaveBeenCalledTimes(1);
      expect(gatekeeper.applyAction).not.toHaveBeenCalled();
    });
  });

  it("persists before dispatch, retains a failed decision, and retries its original identity and profile", async () => {
    await inOverseer("retry", async impl => {
      let record = await submit(impl);
      let gatekeeper = facet();
      let decisions: ManualOwnerActionDecision[] = [];
      gatekeeper.applyActionWithManualOwnerApproval.mockImplementation(async (action, _cache, verifier) => {
        expect(action).toBe(19);
        let decision = await verifier.getDecision();
        let stored = impl.storage.actions.get(record.id);
        expect(stored.state).toBe("pending");
        expect(stored.manualOwnerDecision).toEqual({ userId: OWNER.userId, profile: PROFILE, decision });
        decisions.push(decision);
        if (decisions.length === 1) throw new Error("transport failed after dispatch");
      });
      impl.getGatekeeperFacet = () => gatekeeper;
      await expect(impl.applyPendingAction(record, PROFILE, false, undefined, OWNER))
          .rejects.toThrow(/transport failed/);
      let failed = impl.storage.actions.get(record.id);
      expect(failed.state).toBe("pending");
      expect(failed.manualOwnerDecision.decision).toEqual(decisions[0]);
      expect(decisions[0]).toMatchObject({
        formatVersion: 1, mode: "manual", connectionPrincipal: OWNER.connectionPrincipal,
        vendorId: "serspace", workspaceId: impl.ctx.id.toString(), gatekeeperId: GK,
        workshopActionId: record.id, actionId: 19, payloadHash: HASH,
      });
      expect(decisions[0].decisionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(decisions[0].decidedAt).toISOString()).toBe(decisions[0].decidedAt);

      // Even the same connection principal cannot replace the authenticated user on retry.
      await expect(impl.applyPendingAction(failed, PROFILE, false, undefined,
          { ...OWNER, userId: "replacement-id" })).rejects.toThrow(/cannot be replaced/);
      expect(impl.storage.actions.get(record.id).manualOwnerDecision).toEqual(failed.manualOwnerDecision);
      await impl.applyPendingAction(failed, { ...PROFILE, name: "Changed profile" }, false, undefined, OWNER);
      expect(decisions).toEqual([decisions[0], decisions[0]]);
      let approved = impl.storage.actions.get(record.id);
      expect(approved.state).toBe("approved");
      expect(approved.resolvedBy).toEqual(PROFILE);
      expect(approved.autoApproved).toBe(false);
      expect(gatekeeper.applyAction).not.toHaveBeenCalled();
    });
  });

  it("coalesces only the same actor's in-flight apply", async () => {
    await inOverseer("single-flight", async impl => {
      let record = await submit(impl);
      let gatekeeper = facet();
      let entered = deferred();
      let release = deferred();
      gatekeeper.applyActionWithManualOwnerApproval.mockImplementation(async (_action, _cache, verifier) => {
        await verifier.getDecision();
        entered.resolve();
        await release.promise;
      });
      impl.getGatekeeperFacet = () => gatekeeper;
      let first = impl.applyPendingAction(record, PROFILE, false, undefined, OWNER);
      await entered.promise;
      try {
        let second = impl.applyPendingAction(record, PROFILE, false, undefined, OWNER);
        await expect(impl.applyPendingAction(record, PROFILE, false, undefined, FOREIGN))
            .rejects.toThrow(/already in progress/);
        await expect(impl.applyPendingAction(record, PROFILE, false, undefined,
            { ...OWNER, userId: "another-user" })).rejects.toThrow(/already in progress/);
        expect(gatekeeper.applyActionWithManualOwnerApproval).toHaveBeenCalledTimes(1);
        release.resolve();
        await Promise.all([first, second]);
        expect(gatekeeper.verifyManualOwnerAction).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await first;
      }
    });
  });

  it.each(["payload", "rejected", "removed connection"])(
      "rejects an action whose %s changes during the effect-free precheck", async change => {
    await inOverseer(`precheck-${change}`, async impl => {
      let record = await submit(impl);
      let gatekeeper = facet();
      gatekeeper.verifyManualOwnerAction.mockImplementation(async () => {
        if (change === "removed connection") {
          impl.storage.gatekeepers.delete(GK);
        } else {
          let fresh = impl.storage.actions.get(record.id);
          if (change === "payload") fresh.description.manualOwnerApproval.payloadHash = "d".repeat(64);
          else fresh.state = "rejected";
          impl.storage.actions.put(fresh);
        }
      });
      impl.getGatekeeperFacet = () => gatekeeper;
      await expect(impl.applyPendingAction(record, PROFILE, false, undefined, OWNER))
          .rejects.toThrow(/changed during owner verification/);
      expect(impl.storage.actions.get(record.id).manualOwnerDecision).toBeUndefined();
      expect(gatekeeper.applyActionWithManualOwnerApproval).not.toHaveBeenCalled();
      expect(gatekeeper.applyAction).not.toHaveBeenCalled();
    });
  });

  it.each(["withdrawn action", "removed connection"])(
      "invalidates a retained verifier after a %s", async change => {
    await inOverseer(`invalid-verifier-${change}`, async impl => {
      let record = await submit(impl);
      let gatekeeper = facet();
      gatekeeper.applyActionWithManualOwnerApproval.mockImplementation(async (_action, _cache, verifier) => {
        expect((await verifier.getDecision()).payloadHash).toBe(HASH);
        if (change === "withdrawn action") impl.storage.actions.delete(record.id);
        else impl.storage.gatekeepers.delete(GK);
        // Still inside dispatch, so this is a live RPC capability, not a disposed-stub error.
        // Attach the rejection handler directly to the native RPC promise before asserting it.
        let result = await verifier.getDecision().then(
            () => ({ error: undefined }), (error: Error) => ({ error }));
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toMatch(/no longer available/);
        throw new Error("publication withdrawn");
      });
      impl.getGatekeeperFacet = () => gatekeeper;
      await expect(impl.applyPendingAction(record, PROFILE, false, undefined, OWNER))
          .rejects.toThrow(/publication withdrawn/);
      if (change === "withdrawn action") expect(impl.storage.actions.get(record.id)).toBeUndefined();
      else expect(impl.storage.actions.get(record.id).state).toBe("pending");
      expect(gatekeeper.applyAction).not.toHaveBeenCalled();
    });
  });

  it("does not fall back to ordinary apply when the protected gatekeeper method is missing", async () => {
    await inOverseer("no-fallback", async impl => {
      let record = await submit(impl);
      let gatekeeper = facet();
      impl.getGatekeeperFacet = () => ({ applyAction: gatekeeper.applyAction });
      await expect(impl.applyPendingAction(record, PROFILE, false, undefined, OWNER)).rejects.toThrow();
      expect(gatekeeper.applyAction).not.toHaveBeenCalled();
      expect(impl.storage.actions.get(record.id).state).toBe("pending");
      expect(impl.storage.actions.get(record.id).manualOwnerDecision).toBeUndefined();
    });
  });

  it("keeps ordinary action approval on its existing applyAction path", async () => {
    await inOverseer("ordinary", async impl => {
      let value = description();
      delete value.manualOwnerApproval;
      let record = await submit(impl, value);
      let gatekeeper = facet();
      impl.getGatekeeperFacet = () => gatekeeper;
      await impl.applyPendingAction(record, PROFILE, false);
      expect(gatekeeper.applyAction).toHaveBeenCalledTimes(1);
      expect(gatekeeper.applyAction.mock.calls[0]?.[0]).toBe(19);
      expect(gatekeeper.verifyManualOwnerAction).not.toHaveBeenCalled();
      expect(gatekeeper.applyActionWithManualOwnerApproval).not.toHaveBeenCalled();
      expect(impl.storage.actions.get(record.id).manualOwnerDecision).toBeUndefined();
      expect(impl.storage.actions.get(record.id).state).toBe("approved");
    });
  });
});
