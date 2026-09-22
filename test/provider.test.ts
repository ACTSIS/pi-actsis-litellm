import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type {
  OAuthLoginCallbacks,
  OAuthCredentials,
} from "@earendil-works/pi-ai/compat";
import { buildProviderConfig } from "../extensions/lib/provider.ts";

type PromptItem = { type: "prompt"; value: string | null | undefined };
type SelectItem = { type: "select"; value: string | null | undefined };

describe("buildProviderConfig oauth.login", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  before(async () => {
    tmpDir = await mkdtemp(
      path.join(os.tmpdir(), "actsis-litellm-provider-test-"),
    );
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    originalFetch = globalThis.fetch;
  });

  after(async () => {
    process.env.HOME = originalHome;
    globalThis.fetch = originalFetch;
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.ACTSIS_LITELLM_URL;
  });

  function mockFetch(statusByHref: Record<string, Response>) {
    globalThis.fetch = (async (url) => {
      const href = typeof url === "string" ? url : (url as URL).href;
      for (const [needle, response] of Object.entries(statusByHref)) {
        if (href.includes(needle)) return response.clone();
      }
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
  }

  function makeCallbacks(
    sequence: Array<PromptItem | SelectItem>,
  ): OAuthLoginCallbacks & {
    prompts: string[];
    selects: string[];
    progresses: string[];
  } {
    const prompts: string[] = [];
    const selects: string[] = [];
    const progresses: string[] = [];
    let step = 0;

    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onDeviceCode: () => {},
      onPrompt: async ({ message }: { message: string }) => {
        prompts.push(message);
        const item = sequence[step++];
        if (!item || item.type !== "prompt") return "";
        return item.value ?? "";
      },
      onSelect: async ({ message }: { message: string; options: unknown[] }) => {
        selects.push(message);
        const item = sequence[step++];
        if (!item || item.type !== "select") return undefined;
        return item.value ?? undefined;
      },
      onProgress: (message) => {
        progresses.push(message);
      },
    };

    return { ...callbacks, prompts, selects, progresses };
  }

  it("api key path returns synthetic long-lived credentials", async () => {
    mockFetch({
      "/v1/models": new Response(
        JSON.stringify({ data: [{ id: "gpt-4" }] }),
        { status: 200 },
      ),
      "/key/info": new Response(JSON.stringify({}), { status: 200 }),
    });

    const provider = await buildProviderConfig(null);
    const cbs = makeCallbacks([
      { type: "prompt", value: "https://gateway.example.com" },
      { type: "select", value: "api_key" },
      { type: "prompt", value: "sk-test-key" },
    ]);

    const credentials = await provider.oauth.login(cbs);

    assert.equal(
      cbs.prompts[0],
      "Gateway base URL (e.g. https://gateway.example.com)",
    );
    assert.equal(cbs.selects[0], "Sign in to the LiteLLM gateway:");
    assert.equal(cbs.prompts[1], "LiteLLM API key (sk-...)");
    assert.equal(credentials.access, "sk-test-key");
    assert.equal(credentials.refresh, "");
    assert.equal(credentials.authMode, "api_key");
    assert.ok(typeof credentials.expires === "number");
    assert.ok(credentials.expires > Date.now() + 9 * 365 * 24 * 60 * 60 * 1000);
  });

  it("throws clean error when method selection is cancelled", async () => {
    const provider = await buildProviderConfig(null);
    const cbs = makeCallbacks([
      { type: "prompt", value: "https://gateway.example.com" },
      { type: "select", value: undefined },
    ]);

    await assert.rejects(() => provider.oauth.login(cbs), {
      message: "Login cancelled.",
    });
  });

  it("throws clean error when API key prompt is cancelled", async () => {
    const provider = await buildProviderConfig(null);
    const cbs = makeCallbacks([
      { type: "prompt", value: "https://gateway.example.com" },
      { type: "select", value: "api_key" },
      { type: "prompt", value: "" },
    ]);

    await assert.rejects(() => provider.oauth.login(cbs), {
      message: "Login cancelled.",
    });
  });

  it("rejects invalid API keys with a clear message", async () => {
    mockFetch({
      "/v1/models": new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      }),
    });

    const provider = await buildProviderConfig(null);
    const cbs = makeCallbacks([
      { type: "prompt", value: "https://gateway.example.com" },
      { type: "select", value: "api_key" },
      { type: "prompt", value: "bad-key" },
    ]);

    await assert.rejects(() => provider.oauth.login(cbs), {
      message: "API key rejected by gateway. Verify the key and try again.",
    });
  });

  it("refreshToken returns api_key credentials unchanged", async () => {
    const provider = await buildProviderConfig(null);
    const credentials = {
      access: "sk-test-key",
      refresh: "",
      authMode: "api_key",
      expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
      tokenEndpoint: "",
      revocationEndpoint: "",
      resource: "https://gateway.example.com",
      clientId: "",
    } as unknown as OAuthCredentials;

    const refreshed = await provider.oauth.refreshToken(
      credentials,
      new AbortController().signal,
    );
    assert.equal(refreshed.access, credentials.access);
    assert.equal(refreshed.refresh, credentials.refresh);
    assert.equal(refreshed.expires, credentials.expires);
  });

  it("invokes onLoginSuccess with the resolved gateway URL", async () => {
    mockFetch({
      "/v1/models": new Response(
        JSON.stringify({ data: [{ id: "gpt-4" }] }),
        { status: 200 },
      ),
      "/key/info": new Response(JSON.stringify({}), { status: 200 }),
    });

    const successUrls: string[] = [];
    const provider = await buildProviderConfig(null, {
      onLoginSuccess: async (url) => {
        successUrls.push(url);
      },
    });

    const cbs = makeCallbacks([
      { type: "prompt", value: "https://gateway.example.com" },
      { type: "select", value: "api_key" },
      { type: "prompt", value: "sk-test-key" },
    ]);

    await provider.oauth.login(cbs);
    assert.deepEqual(successUrls, ["https://gateway.example.com"]);
  });
});
