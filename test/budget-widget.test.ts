import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { refreshBudgetWidget, state } from "../extensions/index.ts";

/**
 * Regression test for the budget widget credential resolution: the widget
 * must extract the bearer token the same way /status does
 * (extractUsableApiKey), including the OAuth credential fallback. The
 * pre-fix inline extraction read only `auth.apiKey`, so OAuth/SSO
 * credentials silently produced no widget at all and a plain
 * `Budget refresh: no auth resolution ...` line in /budget.
 */

const OAUTH_AUTH_RESULT = {
  credential: { type: "oauth", access: "access-token" },
};

interface StatusCapture {
  key?: string;
  text?: string;
}

function makeCtx(authResult: unknown, capture: StatusCapture[]) {
  return {
    modelRegistry: {
      getProviderAuth: async (_providerId: string) => authResult,
      getAll: () => [],
    },
    ui: {
      setWidget: (_key: string, _content?: string[]) => {},
      setStatus: (key: string, text?: string) => {
        capture.push({ key, text });
      },
    },
    hasUI: true,
  } as unknown as Parameters<typeof refreshBudgetWidget>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetchCaptureAuth(
  impl: (url: string, authHeader: string | null) => Response | Promise<Response>,
): { restore: () => void; authHeaders: Array<string | null>; urls: string[] } {
  const original = globalThis.fetch;
  const authHeaders: Array<string | null> = [];
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input).toString();
    urls.push(url);
    let headers: Record<string, string> = {};
    if (input instanceof Request) headers = Object.fromEntries(input.headers) as Record<string, string>;
    else if (init?.headers instanceof Headers) headers = Object.fromEntries(init.headers) as Record<string, string>;
    else if (init?.headers && typeof init.headers === "object") headers = init.headers as Record<string, string>;
    const authHeader = headers.Authorization ?? headers.authorization ?? null;
    authHeaders.push(authHeader);
    return Promise.resolve(impl(url, authHeader));
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    authHeaders,
    urls,
  };
}

describe("refreshBudgetWidget credential resolution", () => {
  it("resolves OAuth credentials like /status and renders the colored widget", async () => {
    const capture: StatusCapture[] = [];
    state.providerId = "actsis-litellm";
    const recorder = mockFetchCaptureAuth((url, authHeader) => {
      assert.match(url, /\/(key\/info|user\/info)$/);
      assert.equal(authHeader, "Bearer access-token");
      return jsonResponse({ spend: 12.34, max_budget: 26 });
    });

    try {
      const outcome = await refreshBudgetWidget(makeCtx(OAUTH_AUTH_RESULT, capture), {
        baseUrl: "https://gateway.example",
        requestTimeoutMs: 1_000,
      });
      assert.match(recorder.authHeaders[0] ?? "", /Bearer access-token/);
      const statusText = capture.find((c) => c.key === "actsis-litellm:budget")?.text;
      assert.equal(statusText, outcome);
      // The widget text carries the threshold color like /status does.
      assert.match(statusText ?? "", /\x1b\[38;2;\d+;\d+;\d+m/);
      assert.match(statusText ?? "", /^Budget \x1b\[3/);
    } finally {
      recorder.restore();
      state.providerId = undefined;
    }
  });

  it("clears the widget and reports the reason when no credential resolves", async () => {
    const capture: StatusCapture[] = [];
    state.providerId = "actsis-litellm";
    const recorder = mockFetchCaptureAuth(() => {
      throw new Error("fetch must not be called without a credential");
    });
    try {
      const outcome = await refreshBudgetWidget(makeCtx(null, capture), {
        baseUrl: "https://gateway.example",
        requestTimeoutMs: 1_000,
      });
      assert.equal(recorder.urls.length, 0);
      assert.equal(capture.length, 0);
      assert.match(outcome ?? "", /no auth resolution/);
    } finally {
      recorder.restore();
      state.providerId = undefined;
    }
  });
});