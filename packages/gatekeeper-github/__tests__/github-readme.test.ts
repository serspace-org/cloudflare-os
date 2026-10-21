import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi, GitHubApiError } from "../src/github-api";

afterEach(() => vi.unstubAllGlobals());

function apiReturning(response: Response) {
  const fetch = vi.fn(async (_input: string, _options?: RequestInit) => response);
  vi.stubGlobal("fetch", fetch);
  return { api: new GitHubApi(async () => "test-token"), fetch };
}

describe("GitHubApi.readReadme", () => {
  it("uses authenticated, repository-scoped raw README access without guessing a branch", async () => {
    const { api, fetch } = apiReturning(new Response("# Private README\n"));
    expect(await api.readReadme("serspace-org", "serspace-mcp")).toBe("# Private README\n");
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/serspace-org/serspace-mcp/readme");
    expect(options?.method).toBe("GET");
    expect(options?.redirect).toBe("manual");
    const headers = new Headers(options?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(headers.get("Accept")).toBe("application/vnd.github.raw+json");
  });

  it("encodes repository path segments", async () => {
    const { api, fetch } = apiReturning(new Response("README"));
    await api.readReadme("owner/other", "repo?ref=other");
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/owner%2Fother/repo%3Fref%3Dother/readme");
  });

  it.each([301, 302, 307, 308])("rejects HTTP %s without following redirects or exposing their target", async status => {
    const { api, fetch } = apiReturning(new Response(null, {
      status, headers: { Location: "https://other.example/private-content" },
    }));
    await expect(api.readReadme("owner", "repo")).rejects.toMatchObject({
      status, message: `GitHub README unavailable or access denied (HTTP ${status}).`,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it.each([401, 403, 404, 429, 500])("propagates HTTP %s without exposing the response body", async status => {
    const { api } = apiReturning(new Response("sensitive upstream content", { status }));
    await expect(api.readReadme("owner", "repo")).rejects.toMatchObject({
      name: "GitHubApiError", status,
      message: `GitHub README unavailable or access denied (HTTP ${status}).`,
    });
  });

  it("preserves auth-error classification", async () => {
    const { api } = apiReturning(new Response(null, { status: 401 }));
    await expect(api.readReadme("owner", "repo")).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("accepts exactly 256 KiB", async () => {
    const text = "x".repeat(256 * 1024);
    const { api } = apiReturning(new Response(text));
    expect(await api.readReadme("owner", "repo")).toBe(text);
  });

  it("rejects oversize bytes even with an inaccurate Content-Length and cancels the stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const { api } = apiReturning(new Response(body, { headers: { "Content-Length": "1" } }));
    await expect(api.readReadme("owner", "repo")).rejects.toThrow("256 KiB");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("decodes multibyte UTF-8 split between chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xe2]));
        controller.enqueue(new Uint8Array([0x82, 0xac]));
        controller.close();
      },
    });
    const { api } = apiReturning(new Response(body));
    expect(await api.readReadme("owner", "repo")).toBe("€");
  });

  it("rejects invalid UTF-8 rather than silently replacing bytes", async () => {
    const { api } = apiReturning(new Response(new Uint8Array([0xff])));
    await expect(api.readReadme("owner", "repo")).rejects.toThrow();
  });
});
