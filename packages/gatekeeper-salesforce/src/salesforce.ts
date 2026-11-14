// The Salesforce gatekeeper.
//
// SCAFFOLDING: the connect flow, the account, the resource model and the observer contract are
// wired end to end; the Session read and write methods are stubs pending the API review this
// package's README asks for (see "Step 3: STOP" in the write-gatekeeper skill). Every stub is
// reached through #authorizeRead or the action path, so filling one in cannot bypass the
// observation or approval contract by accident.

import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  type AccountDescription,
  type ActionKind,
  type ApprovalQueue,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ObservationDescription,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
  workerVersionTag,
} from "@gadgets/workshop-shared/gatekeeper";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  clearCredentialExpiryLatch, notifyCredentialsExpiredOnce,
} from "@gadgets/gatekeeper-kit/credential-expiry";
import { createPkce, pkceChallenge } from "@gadgets/gatekeeper-kit/oauth-client";
import { mapLimit, observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import type {
  Cursor,
  SalesforceActivity,
  SalesforceAddNoteOptions,
  SalesforceFieldValues,
  SalesforceLogActivityOptions,
  SalesforceNote,
  SalesforceObject,
  SalesforceObjectDescription,
  SalesforceObjectSummary,
  SalesforceOrg,
  SalesforceOrgMetadata,
  SalesforcePageOptions,
  SalesforceRecord,
  SalesforceRecordDetailOptions,
  SalesforceRecordDetails,
  SalesforceRecordFilter,
  SalesforceRecordSummary,
  SalesforceRelationshipSummary,
  SalesforceRow,
  SalesforceSearch,
  SalesforceUser,
} from "./types";
import TYPES_CODE from "./types.txt";
import SALESFORCE_LOGO_SVG from "./salesforce-logo.svg";
import {
  API_VERSION,
  DEFAULT_LOGIN_URL,
  OAUTH_SCOPES,
  SalesforceApi,
  SalesforceApiError,
  type SalesforceGrant,
  buildAuthorizeUrl,
  exchangeAuthCode,
  refreshAccessToken,
  revokeToken,
} from "./salesforce-api";
import {
  isObjectName,
  objectSubresourceId,
  orgSubresourceId,
  parseSalesforceSubresource,
  recordSubresourceId,
  toCaseSafeId,
} from "./salesforce-subresources";
import { obsContext } from "./observability.js";

const VENDOR_ID = "salesforce";

const logger = obsContext.createLogger({
  component: "gatekeeper.salesforce", vendorId: VENDOR_ID,
});

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 3600 * 1000;
const SUBRESOURCE_ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const SUBRESOURCE_ACCESS_DENIED_TTL_MS = 15_000;
const SUBRESOURCE_ACCESS_CONCURRENCY = 4;

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  /**
   * Where the connect flow sends the browser to authorize. Defaults to Salesforce production;
   * a deployment that connects sandboxes sets https://test.salesforce.com. API calls never use
   * it — they go to each account's own instance_url.
   */
  SALESFORCE_LOGIN_URL?: string;
};

// Canonical resource URLs. Salesforce's own URLs live on a per-org My Domain host that an admin can
// rename, so the canonical form names the org by its Id instead and the configurator maps a pasted
// Lightning URL (https://<myDomain>.lightning.force.com/lightning/r/Account/<id>/view) onto it.
// Declared narrowest first, because Workshop's grant check takes the first type whose pattern
// matches a URL.
const RECORD_RESOURCE: SupportedResource = {
  urlPattern: "https://salesforce.com/org/:orgId/object/:objectName/record/:recordId",
  title: "Salesforce record",
  description:
    "One record — an account, contact, opportunity, lead or case — with the related records, " +
    "activities and notes Salesforce shows beneath it.",
};

const OBJECT_RESOURCE: SupportedResource = {
  urlPattern: "https://salesforce.com/org/:orgId/object/:objectName",
  title: "Salesforce object",
  description:
    "Every record of one object, such as all opportunities, that the connected user can see.",
};

const ORG_RESOURCE: SupportedResource = {
  urlPattern: "https://salesforce.com/org/:orgId",
  title: "Salesforce org",
  description: "Every object and record in the org that the connected user can see.",
};

const SUPPORTED_RESOURCES: SupportedResource[] = [RECORD_RESOURCE, OBJECT_RESOURCE, ORG_RESOURCE];

const SALESFORCE_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(SALESFORCE_LOGO_SVG)}`;

// Action kinds. A user enables a kind once and it covers every action that declares it, so a tag is
// never renamed after shipping and a newly auto-approvable action never joins an existing tag.
const CREATE_RECORD_KIND: ActionKind = { tag: "create-record", label: "Create records" };
const UPDATE_RECORD_KIND: ActionKind = { tag: "update-record", label: "Edit records" };
const LOG_ACTIVITY_KIND: ActionKind = { tag: "log-activity", label: "Log calls, tasks and meetings" };
const ADD_NOTE_KIND: ActionKind = { tag: "add-note", label: "Add notes" };
// Deleting a record has no kind: it opts out of auto-approval under rule 1 (deletes content).

const AUTO_APPROVABLE_KINDS: ActionKind[] = [
  CREATE_RECORD_KIND, UPDATE_RECORD_KIND, LOG_ACTIVITY_KIND, ADD_NOTE_KIND,
];

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <p>This Salesforce connection link has expired or has already been used. Please start the
    connection again from Cloudflare OS.
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <p>This deployment has no Salesforce Connected App configured. An administrator must set the
    gatekeeper's CLIENT_ID and CLIENT_SECRET before accounts can be connected.
  </body>
</html>`;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function getBaseUrl(env: Env): string {
  return (env.BASE_URL || "http://localhost:8787/gatekeeper/salesforce").replace(/\/+$/, "");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function getLoginUrl(env: Env): string {
  return (env.SALESFORCE_LOGIN_URL || DEFAULT_LOGIN_URL).replace(/\/+$/, "");
}

/**
 * Thrown by every Session method the API review has not yet settled. Reaching one is a bug in this
 * package, not in the caller's code.
 */
function notYetImplemented(method: string): never {
  throw new Error(
    `${method} is not implemented yet: the Salesforce gatekeeper's agent-facing API is awaiting ` +
    `review (see packages/gatekeeper-salesforce/README.md).`);
}

// ---------------------------------------------------------------------------
// HTTP handler — the browser OAuth flow.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Step 1: the user opens the connect link (<doId>/<nonce>) -> Salesforce's consent screen.
    // The DO id must be 64 hex characters, not merely 64 characters, so idFromString can't throw.
    if (path.length === 2 && /^[0-9a-f]{64}$/.test(path[0]) && /^[0-9a-f]{64}$/.test(path[1])) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return htmlResponse(NOT_CONFIGURED_HTML);
      }
      const doId = path[0];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(path[1]);
      if (begun === null) return htmlResponse(INVALID_LINK_HTML);

      return Response.redirect(buildAuthorizeUrl({
        loginUrl: getLoginUrl(env),
        clientId: env.CLIENT_ID,
        redirectUri: `${getBaseUrl(env)}/oauth`,
        state: `${doId}:${begun.oauthNonce}`,
        codeChallenge: begun.codeChallenge,
        scopes: OAUTH_SCOPES,
      }), 302);
    }

    // Step 2: Salesforce redirects back here with code + state.
    if (relPath === "/oauth") {
      if (url.searchParams.get("error")) {
        return badRequest(
          "Salesforce authorization failed. Please restart the connection from Cloudflare OS.");
      }
      const state = url.searchParams.get("state");
      if (!state) return badRequest("Error: no 'state' provided");
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return badRequest("Error: malformed state");
      const code = url.searchParams.get("code");
      if (!code) return badRequest("Error: no 'code' provided");

      const doId = state.slice(0, colonIndex);
      if (!/^[0-9a-f]{64}$/.test(doId)) return htmlResponse(INVALID_LINK_HTML);

      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const handoff = await stub.acceptAuthCode(code, state.slice(colonIndex + 1));
      if (!handoff) return htmlResponse(INVALID_LINK_HTML);
      return htmlResponse(connectHandoffPageHtml(handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Salesforce",
      url: "https://www.salesforce.com",
      logo: { url: SALESFORCE_LOGO_URL },
      color: "#eaf5fe",
      tagline: "Read and update CRM records",
      description:
        "Connect your Salesforce org so Cloudflare OS can look up accounts, contacts, leads and " +
        "opportunities, log activity against them, and keep their fields up to date.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — OAuth credentials, token refresh, and this account's own access answers.

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  /** The PKCE verifier for this flow, carried from initiation to the code exchange. */
  codeVerifier?: string;
  /**
   * Set when this flow reconnects an existing account, so its grant is staged rather than made
   * live. The mode travels with the flow, so committing one reconnect cannot change how another
   * in flight lands.
   */
  reconnect?: true;
};

export class UserAccount extends DurableObject<Env> {
  // This account's answers about its own access to Salesforce subresources, partitioned by the
  // credentials that learned them, so an answer cannot outlive a disconnect that left storage
  // behind, nor survive a reconnect that may sign in as another user or to another org.
  #access = new KvTtlCache(this.ctx.storage.kv, () => this.#credentialsId(), { name: "access" });

  // Names the grant installed now, or undefined while there is none.
  #credentialsId(): string | undefined {
    const kv = this.ctx.storage.kv;
    if (!kv.get<SalesforceGrant>("grant")) return undefined;
    let id = kv.get<string>("credentialsId");
    if (id === undefined) {
      id = crypto.randomUUID();
      kv.put<string>("credentialsId", id);
    }
    return id;
  }

  async setCallback(
    callback: Fetcher<GatekeeperConnectCallback>,
    initiationNonce: string,
  ): Promise<void> {
    if (!this.ctx.storage.kv.get<SalesforceGrant>("grant")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    clearCredentialExpiryLatch(this.ctx.storage.kv);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  /** Consumes the initiation nonce and mints the PKCE pair this flow's code exchange will prove. */
  async beginOAuthFlow(
    initiationNonce: string,
  ): Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const pkce = await createPkce();
    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      codeVerifier: pkce.codeVerifier,
      reconnect: stored.reconnect,
    });
    return { oauthNonce, codeChallenge: await pkceChallenge(pkce.codeVerifier) };
  }

  /**
   * Finishes the code exchange and returns the handoff for the page the browser lands on, or null
   * when the callback's nonce does not match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce) || !stored.codeVerifier) {
      return null;
    }
    this.ctx.storage.kv.delete("nonce");

    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("Salesforce OAuth is not configured.");
    }
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Took too long to complete authorization. Please try again.");

    const grant = await exchangeAuthCode({
      loginUrl: getLoginUrl(this.env),
      clientId: this.env.CLIENT_ID,
      clientSecret: this.env.CLIENT_SECRET,
      redirectUri: `${getBaseUrl(this.env)}/oauth`,
      code,
      codeVerifier: stored.codeVerifier,
    });

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the
      // Workshop confirms the browser that finished the flow is the owner's. Bound gadgets keep
      // reading through the current credentials meanwhile.
      handoff = await callback.reconnectComplete(
        stageCredentials(this.ctx.storage.kv, grant, Date.now()));
    } else {
      this.#install(grant);
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("grant");
        throw err;
      }
    }
    await this.ctx.storage.deleteAlarm();
    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitStagedCredentials<SalesforceGrant>(this.ctx.storage.kv, Date.now(), stageId);
    if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.#install(grant);
  }

  #install(grant: SalesforceGrant): void {
    this.ctx.storage.kv.put<SalesforceGrant>("grant", grant);
    this.ctx.storage.kv.put<string>("credentialsId", crypto.randomUUID());
    clearCredentialExpiryLatch(this.ctx.storage.kv);
  }

  /** The org and API host this account's credentials belong to. */
  async getConnection(): Promise<{ orgId: string; userId: string; instanceUrl: string }> {
    const grant = this.#grant();
    return { orgId: grant.orgId, userId: grant.userId, instanceUrl: grant.instanceUrl };
  }

  /**
   * A usable access token. Salesforce access tokens carry no expiry — a session simply stops
   * working — so there is nothing to pre-emptively refresh against; {@link refreshCredentials}
   * is called once a request comes back with an expired session instead.
   */
  async getAccessToken(): Promise<string> {
    return this.#grant().accessToken;
  }

  /**
   * Trades the refresh token for a new access token after a request failed with an expired
   * session, and returns it. A refresh that a reconnect or revoke overtook is discarded, so one
   * account's tokens can never land under another installation's name.
   */
  async refreshCredentials(): Promise<string> {
    const grant = this.#grant();
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("Salesforce OAuth is not configured.");
    }
    const installed = this.#credentialsId();
    try {
      const refreshed = await refreshAccessToken({
        loginUrl: getLoginUrl(this.env),
        clientId: this.env.CLIENT_ID,
        clientSecret: this.env.CLIENT_SECRET,
        refreshToken: grant.refreshToken,
      });
      if (this.ctx.storage.kv.get<string>("credentialsId") !== installed) {
        return this.#grant().accessToken;
      }
      this.ctx.storage.kv.put<SalesforceGrant>("grant", { ...grant, ...refreshed });
      return refreshed.accessToken;
    } catch (err) {
      if (this.ctx.storage.kv.get<string>("credentialsId") !== installed) {
        return this.#grant().accessToken;
      }
      // A revoked or expired refresh token means the connection is dead. Note it here, since the
      // error type is lost when it crosses the RPC boundary to the caller.
      if (err instanceof SalesforceApiError) {
        await this.noteCredentialsExpired();
        throw new Error(
          "Salesforce credentials have expired or been revoked. Please reconnect the account.",
          { cause: err });
      }
      throw err;
    }
  }

  async noteCredentialsExpired(): Promise<void> {
    await notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID);
  }

  /**
   * Whether this account can read each Salesforce subresource, in order: an org when its token
   * belongs to it; an object when, in addition, Salesforce describes it for this token; a record
   * when Salesforce returns it, which its row-level sharing decides. An allowed answer is reused
   * for up to SUBRESOURCE_ACCESS_ALLOWED_TTL_MS and a denial for up to
   * SUBRESOURCE_ACCESS_DENIED_TTL_MS, until credentials are next installed. Throws for an ID it
   * cannot check, or when access cannot be determined (no or expired credentials, a rate limit,
   * an outage), which is never reused.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    // Parsed before anything is asked, so an ID this account cannot check is refused outright.
    const resources = subresources.map(parseSalesforceSubresource);
    const installed = this.#credentialsId();
    const connection = await this.getConnection();
    const api = new SalesforceApi(connection.instanceUrl, () => this.getAccessToken());

    const answers = await mapLimit([...subresources.entries()], SUBRESOURCE_ACCESS_CONCURRENCY,
      ([index, subresource]) => this.#access.cached<boolean>(subresource,
        allowed => allowed ? SUBRESOURCE_ACCESS_ALLOWED_TTL_MS : SUBRESOURCE_ACCESS_DENIED_TTL_MS,
        async () => {
          const resource = resources[index];
          // A grant is for one org, so an ID naming another org is denied without asking
          // Salesforce anything.
          if (resource.orgId !== connection.orgId) return false;
          try {
            switch (resource.kind) {
              case "org":
                return true;
              case "object":
                await api.describeObject(resource.objectName);
                return true;
              case "record":
                // Salesforce answers a record outside this user's sharing with 404, the same as
                // one that never existed, so a successful read is the only proof of access.
                await api.getRecord(resource.objectName, resource.recordId, ["Id"]);
                return true;
            }
          } catch (error) {
            if (error instanceof SalesforceApiError) {
              if (error.isDenial) return false;
              // An expired session says nothing about what this account may read.
              if (error.isExpiredSession) {
                throw new Error(
                  "This collaborator's Salesforce credentials have expired or been revoked, so " +
                  "their access can't be checked.", { cause: error });
              }
            }
            throw error;
          }
        }));

    if (this.ctx.storage.kv.get<string>("credentialsId") !== installed) {
      throw new Error(
        "This collaborator's Salesforce connection changed while their access was being checked.");
    }
    return answers;
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<SalesforceGrant>("grant")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    const grant = this.ctx.storage.kv.get<SalesforceGrant>("grant");
    if (grant) {
      try {
        await revokeToken(getLoginUrl(this.env), grant.refreshToken);
      } catch (err) {
        logger.error("failed to revoke Salesforce token", {
          event: "oauth.token.revoke.failed", error: err,
        });
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  #grant(): SalesforceGrant {
    const grant = this.ctx.storage.kv.get<SalesforceGrant>("grant");
    if (!grant) throw new Error("Salesforce credentials have not been configured for this account.");
    return grant;
  }
}

// ---------------------------------------------------------------------------
// Account-bound API client
//
// Salesforce access tokens have no expiry to pre-empt: a session simply stops working. Every call
// therefore retries once through the account's refresh, and an account whose refresh token is gone
// reports the connection expired.

type AccountStub = DurableObjectStub<UserAccount>;

function apiFor(account: AccountStub, instanceUrl: string): SalesforceApi {
  return new SalesforceApi(instanceUrl, () => account.getAccessToken());
}

async function withRefresh<T>(account: AccountStub, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof SalesforceApiError) || !error.isExpiredSession) throw error;
    await account.refreshCredentials();
    return await fn();
  }
}

// ---------------------------------------------------------------------------
// GatekeeperUserImpl — maps resource URLs to gatekeeper DO classes

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
    implements GatekeeperUser {
  #account(): AccountStub {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const account = this.#account();
    const { instanceUrl } = await account.getConnection();
    const identity = await withRefresh(account, () => apiFor(account, instanceUrl).getIdentity());
    return {
      displayName: identity.name,
      uniqueName: identity.username,
      avatar: { url: "" },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // This vendor does not advertise providesAuth, so this is never used for sign-in.
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.hostname !== "salesforce.com" || parsed.search || parsed.hash) {
      throw new Error(`Unsupported Salesforce URL: ${url}`);
    }
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== "org" || !segments[1]) throw new Error(`Unsupported Salesforce URL: ${url}`);

    const orgId = toCaseSafeId(segments[1]);
    // A binding may only name the org this account's credentials belong to; otherwise its reads
    // would report subresources no observer check could ever satisfy.
    const connection = await this.#account().getConnection();
    if (orgId !== connection.orgId) {
      throw new Error("That Salesforce org is not the one this account is connected to.");
    }

    const props: SalesforceGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      orgId,
      instanceUrl: connection.instanceUrl,
      resourceKind: "org",
    };
    let resource = ORG_RESOURCE;

    if (segments[2] === "object" && segments[3]) {
      if (!isObjectName(segments[3])) throw new Error(`Unsupported Salesforce URL: ${url}`);
      props.resourceKind = "object";
      props.objectName = segments[3];
      resource = OBJECT_RESOURCE;

      if (segments[4] === "record" && segments[5]) {
        props.resourceKind = "record";
        props.recordId = toCaseSafeId(segments[5]);
        resource = RECORD_RESOURCE;
      } else if (segments.length > 4) {
        throw new Error(`Unsupported Salesforce URL: ${url}`);
      }
    } else if (segments.length > 2) {
      throw new Error(`Unsupported Salesforce URL: ${url}`);
    }

    return { class: this.ctx.exports.SalesforceGatekeeperImpl({ props }), resource };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    // TODO(step 6): a HierarchyPicker over objects and their records, plus
    // initialValuesFromResourceUrl mapping a pasted Lightning URL onto the canonical form.
    throw new Error(
      `The Salesforce resource configurator for ${resourceUrlPattern} is not implemented yet.`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  /**
   * Mints a verifier representing this account, which SalesforceGatekeeperImpl.verifyObserverAccess
   * asks whether an observer may read the org, objects and records a binding's reads reported. The
   * verifier carries this user's own account id, so every check runs against the observer's own
   * Salesforce credentials.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: SalesforceVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.SalesforceVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier

type SalesforceVerifierProps = {
  userObjectId: string;
};

/**
 * The non-standard method the Salesforce gatekeeper calls on its own verifier. Not part of the
 * generic GatekeeperUserVerifier contract; the overseer only ever hands this verifier back to a
 * Salesforce gatekeeper, which may therefore trust its answers.
 */
export interface SalesforceVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether the observer's account can read each Salesforce subresource, in order, reusing recent
   * answers (see UserAccount.checkSubresourceAccess). Throws for an ID it cannot check, or when
   * access cannot be determined (expired credentials, a rate limit, an outage).
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}

@validateRpc()
export class SalesforceVerifier extends WorkerEntrypoint<Env, SalesforceVerifierProps>
    implements SalesforceVerifierApi {
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    const accounts = this.ctx.exports.UserAccount;
    return await accounts.get(accounts.idFromString(this.ctx.props.userObjectId))
      .checkSubresourceAccess(subresources);
  }
}

// Admits an observer only if their own account can read every org, object and record a binding's
// reads reported (see UserAccount.checkSubresourceAccess).
const verifySalesforceAccess = observerAccessVerifier({
  hasCollectionAccess: (verifier: Fetcher<SalesforceVerifierApi>, subresources: readonly string[]) =>
    verifier.checkSubresourceAccess([...subresources]),
});

// ---------------------------------------------------------------------------
// SalesforceGatekeeperImpl DO — one binding, pinned to an org, object or record

type SalesforceGatekeeperImplProps = {
  userObjectId: string;
  /** The org this binding reads, pinned at bind time; a session never reaches another. */
  orgId: string;
  /** The API host that org's grant reported at bind time. */
  instanceUrl: string;
  resourceKind: "org" | "object" | "record";
  objectName?: string;
  recordId?: string;
};

export class SalesforceGatekeeperImpl extends DurableObject<Env, SalesforceGatekeeperImplProps>
    implements Gatekeeper<SalesforceOrg | SalesforceObject | SalesforceRecord> {

  #account(): AccountStub {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #run<T>(fn: (api: SalesforceApi) => Promise<T>): Promise<T> {
    const account = this.#account();
    return withRefresh(account, () => fn(apiFor(account, this.ctx.props.instanceUrl)));
  }

  async describe(): Promise<ResourceDescription> {
    const { orgId, objectName, recordId, resourceKind } = this.ctx.props;
    switch (resourceKind) {
      case "record":
        return {
          url: `https://salesforce.com/org/${orgId}/object/${objectName}/record/${recordId}`,
          title: `${objectName} ${recordId}`,
          snippet: `One ${objectName} record in Salesforce.`,
          suggestedBindingName: "SALESFORCE_RECORD",
          tsType: "SalesforceRecord",
        };
      case "object":
        return {
          url: `https://salesforce.com/org/${orgId}/object/${objectName}`,
          title: `${objectName} records`,
          snippet: `Every ${objectName} record in Salesforce this account can see.`,
          suggestedBindingName: "SALESFORCE_OBJECT",
          tsType: "SalesforceObject",
        };
      case "org":
        return {
          url: `https://salesforce.com/org/${orgId}`,
          title: "Salesforce org",
          snippet: "Every object and record in Salesforce this account can see.",
          suggestedBindingName: "SALESFORCE_ORG",
          tsType: "SalesforceOrg",
        };
    }
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // A record binding can log activity, add notes and edit its own record, but creates nothing.
    if (this.ctx.props.resourceKind === "record") {
      return [UPDATE_RECORD_KIND, LOG_ACTIVITY_KIND, ADD_NOTE_KIND];
    }
    return AUTO_APPROVABLE_KINDS;
  }

  async startSession(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<SalesforceOrg | SalesforceObject | SalesforceRecord> {
    // dup() because Cap'n Web disposes stubs passed as arguments when the call returns.
    const queue = approvalQueue.dup();
    switch (this.ctx.props.resourceKind) {
      case "record":
        return new SalesforceRecordSession(
          this, queue, this.ctx.props.objectName!, this.ctx.props.recordId!);
      case "object":
        return new SalesforceObjectSession(this, queue, this.ctx.props.objectName!);
      case "org":
        return new SalesforceOrgSession(this, queue);
    }
  }

  /**
   * Authorizes one observation. The shared `ObservationDescription` still makes `subresources`
   * optional; requiring it here makes omitting it a type error on every read path in this package.
   */
  async authorizeRead(
    queue: RpcStub<ApprovalQueue>,
    description: ObservationDescription & { subresources: string[] },
  ): Promise<void> {
    await queue.authorizeObservation(description);
  }

  /** The org this binding is pinned to, reported by every read on an org binding. */
  orgSubresource(): string {
    return orgSubresourceId(this.ctx.props.orgId);
  }

  /** The object `objectName` in this binding's org. */
  objectSubresource(objectName: string): string {
    return objectSubresourceId(this.ctx.props.orgId, objectName);
  }

  /** Record `recordId` of `objectName` in this binding's org. */
  recordSubresource(objectName: string, recordId: string): string {
    return recordSubresourceId(this.ctx.props.orgId, objectName, toCaseSafeId(recordId));
  }

  run<T>(fn: (api: SalesforceApi) => Promise<T>): Promise<T> {
    return this.#run(fn);
  }

  async applyAction(actionId: number): Promise<void> {
    // TODO(phase 2): look the action up in this binding's own storage and perform it.
    throw new Error(`Unknown action: ${actionId}`);
  }

  async rejectAction(_actionId: number): Promise<void | { restart?: boolean }> {
    // TODO(phase 2): drop this action's simulated state.
  }

  async revertAction(_actionId: number): Promise<void | {
    message?: string; canRetry?: boolean; restart?: boolean;
  }> {
    throw new Error("Revert is not implemented yet.");
  }

  /**
   * Required, though the current Gatekeeper interface does not declare it. This gatekeeper is new,
   * so it observed nothing under the legacy observer protocol: the export is empty and reads no
   * state.
   */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    // Refuse an ID this binding never reports rather than guessing what it names. Every ID a read
    // here reports is in this binding's own org, and no binding reports outside its own resource.
    for (const subresource of subresources) {
      const resource = parseSalesforceSubresource(subresource);
      if (resource.orgId !== this.ctx.props.orgId) {
        throw new Error("This connection was asked about an org it never reported.");
      }
    }
    return verifySalesforceAccess(observers, subresources);
  }

  /**
   * Compatibility only: the current interface requires this. All access dependencies are explicit
   * on observations, and observer authorization happens in `verifyObserverAccess()`, never here.
   */
  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Compatibility only; there is no observer state to remove. */
  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Sessions
//
// SCAFFOLDING: each method below is a stub. Implementing one means fetching through
// `gatekeeper.run()`, then awaiting `gatekeeper.authorizeRead()` with the subresources the answer
// depends on before returning anything — the org for org-wide metadata and listings, the object for
// a listing or search over it, and each record whose data the answer carries.

class SalesforceOrgSession extends RpcTarget implements SalesforceOrg {
  constructor(
    private readonly gatekeeper: SalesforceGatekeeperImpl,
    private readonly queue: RpcStub<ApprovalQueue>,
  ) {
    super();
  }

  async getMetadata(): Promise<SalesforceOrgMetadata> {
    notYetImplemented("SalesforceOrg.getMetadata");
  }

  async listObjects(): Promise<SalesforceObjectSummary[]> {
    notYetImplemented("SalesforceOrg.listObjects");
  }

  async getObject(_objectName: string): Promise<SalesforceObject> {
    notYetImplemented("SalesforceOrg.getObject");
  }

  async getRecord(_recordId: string): Promise<SalesforceRecord> {
    notYetImplemented("SalesforceOrg.getRecord");
  }

  async search(_query: SalesforceSearch): Promise<Cursor<SalesforceRecordSummary>> {
    notYetImplemented("SalesforceOrg.search");
  }

  async query(_soql: string): Promise<Cursor<SalesforceRow>> {
    notYetImplemented("SalesforceOrg.query");
  }

  async findUsers(_query?: string): Promise<SalesforceUser[]> {
    notYetImplemented("SalesforceOrg.findUsers");
  }
}

class SalesforceObjectSession extends RpcTarget implements SalesforceObject {
  constructor(
    private readonly gatekeeper: SalesforceGatekeeperImpl,
    private readonly queue: RpcStub<ApprovalQueue>,
    private readonly objectName: string,
  ) {
    super();
  }

  async describe(): Promise<SalesforceObjectDescription> {
    notYetImplemented("SalesforceObject.describe");
  }

  async listRecords(_filter?: SalesforceRecordFilter): Promise<Cursor<SalesforceRecordSummary>> {
    notYetImplemented("SalesforceObject.listRecords");
  }

  async search(_query: SalesforceSearch): Promise<Cursor<SalesforceRecordSummary>> {
    notYetImplemented("SalesforceObject.search");
  }

  async getRecord(_recordId: string): Promise<SalesforceRecord> {
    notYetImplemented("SalesforceObject.getRecord");
  }

  async createRecord(_fields: SalesforceFieldValues): Promise<SalesforceRecord> {
    notYetImplemented("SalesforceObject.createRecord");
  }
}

class SalesforceRecordSession extends RpcTarget implements SalesforceRecord {
  constructor(
    private readonly gatekeeper: SalesforceGatekeeperImpl,
    private readonly queue: RpcStub<ApprovalQueue>,
    readonly objectName: string,
    readonly id: string,
  ) {
    super();
  }

  async getDetails(_options?: SalesforceRecordDetailOptions): Promise<SalesforceRecordDetails> {
    notYetImplemented("SalesforceRecord.getDetails");
  }

  async update(_fields: SalesforceFieldValues): Promise<void> {
    notYetImplemented("SalesforceRecord.update");
  }

  async delete(): Promise<void> {
    notYetImplemented("SalesforceRecord.delete");
  }

  async listRelationships(): Promise<SalesforceRelationshipSummary[]> {
    notYetImplemented("SalesforceRecord.listRelationships");
  }

  async listRelated(
    _relationshipName: string,
    _options?: SalesforcePageOptions,
  ): Promise<Cursor<SalesforceRecordSummary>> {
    notYetImplemented("SalesforceRecord.listRelated");
  }

  async listActivities(_options?: SalesforcePageOptions): Promise<Cursor<SalesforceActivity>> {
    notYetImplemented("SalesforceRecord.listActivities");
  }

  async logActivity(_options: SalesforceLogActivityOptions): Promise<void> {
    notYetImplemented("SalesforceRecord.logActivity");
  }

  async listNotes(_options?: SalesforcePageOptions): Promise<Cursor<SalesforceNote>> {
    notYetImplemented("SalesforceRecord.listNotes");
  }

  async addNote(_options: SalesforceAddNoteOptions): Promise<void> {
    notYetImplemented("SalesforceRecord.addNote");
  }
}

export { API_VERSION };
