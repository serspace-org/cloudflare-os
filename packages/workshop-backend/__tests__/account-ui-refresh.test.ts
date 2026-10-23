import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { UserDurableObject } from "../src/user.js";
import type { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";

type UserInternals = UserDurableObject & {
  env: Cloudflare.Env;
  vendors: Map<string, unknown>;
  storage: ReturnType<typeof makeUserStorage>;
};

function inUser<T>(name: string, f: (user: UserInternals) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_USER.getByName(name),
    (user: UserDurableObject) => f(user as UserInternals));
}

function hooks(): DurableObjectStub<GatekeeperUserPickerTestHooks> {
  return env.TEST_GATEKEEPER_USER_PICKER.getByName("");
}

const newDescription: AccountDescription = {
  avatar: { url: "https://example.com/new.png" },
  displayName: "New display name", uniqueName: "different-principal",
  grantedResourceUrlPatterns: ["https://example.com/*"],
  singleton: { tsType: "NewAuthority" }, providesUi: { title: "Models" },
};

async function setup() {
  const name = crypto.randomUUID().replaceAll("-", "");
  const config = new Map<string, string>();
  await inUser(name, user => {
    user.env = { ...user.env, BLUEPRINTS: {
      get: async (key: string) => config.get(key) ?? null,
    } as unknown as KVNamespace };
    user.vendors.clear(); // No provisioning: these are already connected OAuth accounts.
  });
  await hooks().createUser(name, "Owner");
  const id = await hooks().addAccount(name, "models", name);
  return { name, id, config };
}

describe("connected account UI metadata refresh", () => {
  it("discovers a newly provided UI without refreshing identity, grants, singleton or credentials", async () => {
    const { name, id } = await setup();
    await inUser(name, user => {
      const record = user.storage.connectedAccounts.get(id)!;
      record.description.grantedResourceUrlPatterns = [];
      record.credentialsExpired = true;
      user.storage.connectedAccounts.put(record);
    });
    await hooks().setAccountDescription(name, newDescription);
    const before = await inUser(name, user => {
      const { account, ...record } = user.storage.connectedAccounts.get(id)!;
      return record;
    });
    const apps = await env.TEST_USER.getByName(name).listProvidedAccounts();
    expect(apps).toEqual([{
      accountId: id, vendorId: "models",
      description: { ...before.description, providesUi: newDescription.providesUi },
    }]);
    await inUser(name, user => {
      const { account, ...after } = user.storage.connectedAccounts.get(id)!;
      expect(after).toEqual({ ...before, description: apps[0].description });
    });
    expect(await hooks().accountCalls(name)).toEqual(["describe", "describe"]);
    await inUser(name, async user => {
      let writes = 0;
      const countWrite = () => { writes++; };
      const subscriber = { add: countWrite, update: countWrite, remove: countWrite };
      user.storage.connectedAccounts.subscribe(subscriber);
      try {
        await user.listProvidedAccounts();
        expect(writes).toBe(0); // An unchanged UI must not churn connected-account subscriptions.
      } finally {
        user.storage.connectedAccounts.unsubscribe(subscriber);
      }
    });
  });

  it("retains failed accounts unchanged and still refreshes the other accounts", async () => {
    const { name, id } = await setup();
    const other = `${name}other`;
    await hooks().addAccount(name, "other", other);
    await hooks().setAccountDescription(name, null);
    await hooks().setAccountDescription(other, newDescription);
    const before = await inUser(name, user => user.storage.connectedAccounts.get(id)!.description);
    expect(await env.TEST_USER.getByName(name).listProvidedAccounts()).toMatchObject([
      { vendorId: "other", description: { providesUi: { title: "Models" } } },
    ]);
    await inUser(name, user => {
      expect(user.storage.connectedAccounts.get(id)!.description).toEqual(before);
    });
  });

  it.each([false, true])("never lists disabled vendors (autoProvisioned=%s)", async autoProvisioned => {
    const { name, id, config } = await setup();
    await inUser(name, user => {
      const record = user.storage.connectedAccounts.get(id)!;
      user.storage.connectedAccounts.put({ ...record, autoProvisioned });
    });
    await hooks().setAccountDescription(name, newDescription);
    config.set(ADMIN_CONFIG_KEY, JSON.stringify(autoProvisioned
      ? { ambientGatekeeperModes: { models: "disabled" } }
      : { disabledGatekeepers: ["models"] }));
    expect(await env.TEST_USER.getByName(name).listProvidedAccounts()).toEqual([]);
  });

  it.each(["revoke", "reconnect"])("discards a delayed describe raced by %s", async mutation => {
    const { name, id } = await setup();
    await hooks().setAccountDescription(name, newDescription, true);
    const listing = env.TEST_USER.getByName(name).listProvidedAccounts();
    await hooks().waitForAccountDescribe(name);
    if (mutation === "revoke") {
      await env.TEST_USER.getByName(name).disconnectAccount(id);
    } else {
      // Replace with another persisted capability under the same id, as login/reconnect can do.
      const replacement = `${name}replacement`;
      const replacementId = await hooks().addAccount(name, "models", replacement);
      await inUser(name, user => {
        const record = user.storage.connectedAccounts.get(replacementId)!;
        user.storage.connectedAccounts.delete(replacementId);
        user.storage.connectedAccounts.put({ ...record, id });
      });
    }
    await hooks().releaseAccountDescribe(name);
    expect(await listing).toEqual([]);
    await inUser(name, user => {
      const record = user.storage.connectedAccounts.get(id);
      if (mutation === "revoke") expect(record).toBeUndefined();
      else {
        expect(record!.description.uniqueName).toBe(`${name}replacement`);
        expect(record!.description.providesUi).toBeUndefined();
      }
    });
  });

  it("removes a UI declaration without replacing an existing singleton", async () => {
    const { name, id } = await setup();
    await inUser(name, user => {
      const record = user.storage.connectedAccounts.get(id)!;
      record.description.singleton = { tsType: "ExistingAuthority" };
      record.description.providesUi = { title: "Old UI" };
      user.storage.connectedAccounts.put(record);
    });
    await hooks().setAccountDescription(name, { avatar: newDescription.avatar });
    expect(await env.TEST_USER.getByName(name).listProvidedAccounts()).toMatchObject([
      { description: { singleton: { tsType: "ExistingAuthority" } } },
    ]);
    await inUser(name, user => {
      expect(user.storage.connectedAccounts.get(id)!.description.providesUi).toBeUndefined();
    });
  });
});
