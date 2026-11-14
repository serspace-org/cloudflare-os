// Salesforce's OAuth 2.0 web-server flow and the slice of its REST API this gatekeeper calls.
//
// Two hosts are in play and must not be confused. Authorization happens on a *login* host, which
// the deployment configures once (production, or https://test.salesforce.com for sandboxes). Every
// API call afterwards goes to the `instance_url` that account's own token grant reported, which is
// per-org and may change when an org is migrated, so it is stored with the credentials and
// refreshed from every token response rather than derived from configuration.

import { toCaseSafeId } from "./salesforce-subresources";

/** The Salesforce REST API version this gatekeeper targets. */
export const API_VERSION = "v62.0";

/** Where authorization happens when the deployment configures no other login host. */
export const DEFAULT_LOGIN_URL = "https://login.salesforce.com";

/**
 * The OAuth scopes the connect flow asks for: `api` to call the REST API, `refresh_token` and
 * `offline_access` so the connection survives a session timeout, and `id` so the account can name
 * its org and user.
 */
export const OAUTH_SCOPES = ["api", "refresh_token", "offline_access", "id"];

/** The credentials one connected account holds. */
export type SalesforceGrant = {
  accessToken: string;
  refreshToken: string;
  /** The org's API host, e.g. `https://acme.my.salesforce.com`, from the token response. */
  instanceUrl: string;
  /** The org's 18-character Id, from the token response's identity URL. */
  orgId: string;
  /** The connected user's 18-character Id, from the token response's identity URL. */
  userId: string;
  scopes: string[];
};

/** A Salesforce error response, which the API returns as a list of one or more errors. */
export type SalesforceErrorBody = {
  message?: string;
  errorCode?: string;
  fields?: string[];
};

/** An unsuccessful Salesforce API response. */
export class SalesforceApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly fields: string[] = [],
  ) {
    super(message);
    this.name = "SalesforceApiError";
  }

  /**
   * True when Salesforce definitely refused this caller the resource, rather than failing for a
   * reason that says nothing about access. Only these answers may become a `false` from an
   * observer check; everything else — an expired session, a rate limit, an outage — is
   * indeterminate and must propagate.
   *
   * Salesforce answers a record outside the caller's sharing with `NOT_FOUND`, exactly as it
   * answers a record that never existed, so the two are indistinguishable here by design.
   */
  get isDenial(): boolean {
    return (
      this.status === 403 ||
      this.status === 404 ||
      this.errorCode === "INSUFFICIENT_ACCESS" ||
      this.errorCode === "INSUFFICIENT_ACCESS_OR_READONLY" ||
      this.errorCode === "NOT_FOUND" ||
      this.errorCode === "ENTITY_IS_DELETED" ||
      this.errorCode === "INVALID_TYPE"
    );
  }

  /** True when the access token is no longer usable and the credentials should be refreshed. */
  get isExpiredSession(): boolean {
    return this.status === 401 || this.errorCode === "INVALID_SESSION_ID";
  }
}

/** Builds the URL the connect flow sends the user's browser to. */
export function buildAuthorizeUrl(options: {
  loginUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  const url = new URL(`${stripSlash(options.loginUrl)}/services/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", (options.scopes ?? OAUTH_SCOPES).join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Exchanges the authorization code Salesforce redirected back with for a grant. */
export async function exchangeAuthCode(options: {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<SalesforceGrant> {
  return parseTokenResponse(
    await postToken(options.loginUrl, {
      grant_type: "authorization_code",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      code: options.code,
      code_verifier: options.codeVerifier,
    }),
  );
}

/**
 * Trades the refresh token for a fresh access token. Salesforce does not rotate refresh tokens,
 * and omits one from this response, so the caller keeps the refresh token it already holds.
 */
export async function refreshAccessToken(options: {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<Omit<SalesforceGrant, "refreshToken">> {
  const body = await postToken(options.loginUrl, {
    grant_type: "refresh_token",
    client_id: options.clientId,
    client_secret: options.clientSecret,
    refresh_token: options.refreshToken,
  });
  const { refreshToken: _unused, ...rest } = parseTokenResponse({
    ...body,
    refresh_token: options.refreshToken,
  });
  return rest;
}

/** Revokes the refresh token, ending the connection on Salesforce's side. */
export async function revokeToken(loginUrl: string, token: string): Promise<void> {
  const response = await fetch(`${stripSlash(loginUrl)}/services/oauth2/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  await response.body?.cancel();
  // Salesforce answers an already-revoked token with 400; treating that as failure would leave a
  // disconnect stuck on an account that is already gone.
  if (!response.ok && response.status !== 400) {
    throw new SalesforceApiError(response.status, "REVOKE_FAILED", "Could not revoke the token.");
  }
}

type TokenResponseBody = {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  id?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postToken(loginUrl: string, form: Record<string, string>): Promise<TokenResponseBody> {
  const response = await fetch(`${stripSlash(loginUrl)}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as TokenResponseBody;
  if (!response.ok || body.error) {
    throw new SalesforceApiError(
      response.status,
      body.error ?? "TOKEN_REQUEST_FAILED",
      body.error_description ?? "Salesforce refused the token request.",
    );
  }
  return body;
}

/**
 * Reads a grant out of a token response. The org and user Ids come from the identity URL
 * Salesforce returns as `id`, which ends in `/id/<orgId>/<userId>`.
 */
export function parseTokenResponse(body: TokenResponseBody): SalesforceGrant {
  const { access_token, refresh_token, instance_url, id, scope } = body;
  if (!access_token || !refresh_token || !instance_url || !id) {
    throw new SalesforceApiError(
      200,
      "TOKEN_RESPONSE_INCOMPLETE",
      "Salesforce returned a token response without the fields this connection needs.",
    );
  }
  const identity = /\/id\/([A-Za-z0-9]{15,18})\/([A-Za-z0-9]{15,18})$/.exec(new URL(id).pathname);
  if (!identity) {
    throw new SalesforceApiError(
      200,
      "TOKEN_RESPONSE_INCOMPLETE",
      "Salesforce returned a token response whose identity URL named no org and user.",
    );
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    instanceUrl: stripSlash(instance_url),
    orgId: toCaseSafeId(identity[1]),
    userId: toCaseSafeId(identity[2]),
    scopes: scope ? scope.split(" ") : [],
  };
}

/** One page of a SOQL query result. */
export type QueryPage = {
  totalSize: number;
  done: boolean;
  /** The path to the next page, when `done` is false. */
  nextRecordsUrl?: string;
  records: SalesforceRestRecord[];
};

/** A record as the REST API returns it, including the `attributes` block naming its object. */
export type SalesforceRestRecord = {
  attributes?: { type: string; url?: string };
  Id?: string;
  [field: string]: unknown;
};

/** One object in the org, as the describe-global call reports it. */
export type GlobalDescribeObject = {
  name: string;
  label: string;
  labelPlural: string;
  custom: boolean;
  queryable: boolean;
  searchable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  /** The three characters every Id of this object starts with, or null for objects without one. */
  keyPrefix: string | null;
};

/** The identity Salesforce reports for whoever holds the access token. */
export type SalesforceIdentity = {
  organizationId: string;
  userId: string;
  name: string;
  email: string | null;
  username: string;
};

/**
 * A read/write client for one connected account, bound to the account's instance host. It holds no
 * credentials: `getAccessToken` is called per request so a refreshed token is picked up without
 * rebuilding the client.
 */
export class SalesforceApi {
  constructor(
    private readonly instanceUrl: string,
    private readonly getAccessToken: () => Promise<string>,
  ) {}

  /** Who the access token belongs to, and in which org. */
  async getIdentity(): Promise<SalesforceIdentity> {
    const body = await this.request<{
      organization_id: string;
      user_id: string;
      name: string;
      email?: string;
      preferred_username: string;
    }>("GET", "/services/oauth2/userinfo");
    return {
      organizationId: toCaseSafeId(body.organization_id),
      userId: toCaseSafeId(body.user_id),
      name: body.name,
      email: body.email ?? null,
      username: body.preferred_username,
    };
  }

  /** Every object in the org, including ones that hold no CRM data. */
  async describeGlobal(): Promise<GlobalDescribeObject[]> {
    const body = await this.request<{ sobjects: GlobalDescribeObject[] }>(
      "GET",
      `/services/data/${API_VERSION}/sobjects/`,
    );
    return body.sobjects;
  }

  /** One object's fields, picklists and relationships. */
  async describeObject(objectName: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectName)}/describe`,
    );
  }

  /** Runs a SOQL query and returns its first page. */
  async query(soql: string): Promise<QueryPage> {
    return this.request(
      "GET",
      `/services/data/${API_VERSION}/query/?q=${encodeURIComponent(soql)}`,
    );
  }

  /** Follows a page's `nextRecordsUrl`. */
  async queryMore(nextRecordsUrl: string): Promise<QueryPage> {
    return this.request("GET", nextRecordsUrl);
  }

  /**
   * Reads selected fields of one record. `fields` must be non-empty; Salesforce returns every
   * field when none is given, which is more than any caller here asks for.
   */
  async getRecord(
    objectName: string,
    recordId: string,
    fields: readonly string[],
  ): Promise<SalesforceRestRecord> {
    const query = `?fields=${encodeURIComponent(fields.join(","))}`;
    return this.request(
      "GET",
      `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectName)}/` +
        `${encodeURIComponent(recordId)}${query}`,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.instanceUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    if (!response.ok) {
      await throwApiError(response);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

async function throwApiError(response: Response): Promise<never> {
  let errors: SalesforceErrorBody[] = [];
  try {
    const parsed = await response.json();
    errors = Array.isArray(parsed) ? (parsed as SalesforceErrorBody[]) : [parsed as SalesforceErrorBody];
  } catch {
    await response.body?.cancel();
  }
  const first = errors[0] ?? {};
  throw new SalesforceApiError(
    response.status,
    first.errorCode ?? `HTTP_${response.status}`,
    first.message ?? `Salesforce returned HTTP ${response.status}.`,
    first.fields ?? [],
  );
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
