import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import {
  fetchCatalogModels,
  loadCachedModels,
  saveCachedModels,
  computeCacheAge,
  isChatModelId,
} from "../extensions/lib/catalog.ts";
import { buildProviderConfig } from "../extensions/lib/provider.ts";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";

const BASE_URL = "https://gateway.example.com";

let originalFetch: typeof globalThis.fetch;

before(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function modelInfoFixture(id: string): Record<string, unknown> {
  return {
    id,
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000015,
    cache_creation_input_token_cost: 0.0000025,
    max_input_tokens: 128000,
    max_output_tokens: 4096,
  };
}

function makeFetchConfig(): Parameters<typeof fetchCatalogModels>[0] {
  return {
    baseUrl: BASE_URL,
    providerId: "actsis-litellm",
    catalogTtlMs: 15 * 60 * 1000,
    requestTimeoutMs: 30_000,
  };
}

describe("isChatModelId", () => {
  const cases: [string, string | null | undefined, boolean][] = [
    ["gpt-oss-120b", undefined, true],
    ["qwen3-vl-8b", undefined, true],
    ["claude-x", undefined, true],
    ["nomic-embed", undefined, false],
    ["whisper-1", undefined, false],
    ["whisper-diarize", undefined, false],
    ["my-tts", undefined, false],
    ["openai/audio-transcription-hd", undefined, false],
    ["gpt-4o-audio-preview", undefined, true],
    ["gpt-4", "chat", true],
    ["text-embedding-ada-002", "embedding", false],
    ["whisper-large-v3", "audio_transcription", false],
    ["dall-e-3", "image_generation", false],
    ["some-weird-model", "completion", true],
    ["unknown-mode-model", "batch", true],
  ];

  for (const [id, mode, expected] of cases) {
    it(`${id} (mode=${String(mode)}) -> ${expected}`, () => {
      assert.equal(isChatModelId(id, mode), expected);
    });
  }
});

describe("fetchCatalogModels filtering", () => {
  it("excludes non-chat models from /v1/models by heuristic", async () => {
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "gpt-oss-120b" },
              { id: "qwen3-coder-next" },
              { id: "nomic-embed" },
              { id: "whisper-1" },
              { id: "qwen3-vl-8b" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/model/info")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    assert.deepEqual(models.map((m) => m.id).sort(), [
      "gpt-oss-120b",
      "qwen3-coder-next",
      "qwen3-vl-8b",
    ]);
  });

  it("uses /model/info mode metadata to override heuristic", async () => {
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "gpt-oss-120b" },
              { id: "qwen3-coder-next" },
              { id: "qwen3-vl-8b" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/model/info")) {
        return new Response(
          JSON.stringify([
            {
              id: "qwen3-coder-next",
              mode: "embedding",
            },
            modelInfoFixture("gpt-oss-120b"),
            modelInfoFixture("qwen3-vl-8b"),
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    assert.deepEqual(models.map((m) => m.id).sort(), [
      "gpt-oss-120b",
      "qwen3-vl-8b",
    ]);
  });
});

describe("fetchCatalogModels mapping", () => {
  it("converts per-token costs to per-million and applies defaults", async () => {
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "claude-sonnet" },
              { id: "gpt-4" },
              { id: "" },
              { id: "claude-sonnet" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/model/info")) {
        return new Response(
          JSON.stringify([
            modelInfoFixture("gpt-4"),
            modelInfoFixture("claude-sonnet"),
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");

    assert.equal(models.length, 2);
    assert.deepEqual(models.map((m) => m.id), ["claude-sonnet", "gpt-4"]);

    const gpt4 = models.find((m) => m.id === "gpt-4")!;
    assert.equal(gpt4.name, "gpt-4");
    assert.equal(gpt4.reasoning, true);
    assert.deepEqual(gpt4.input, ["text"]);
    assert.equal(gpt4.cost.input, 3);
    assert.equal(gpt4.cost.output, 15);
    assert.equal(gpt4.cost.cacheRead, 1.5);
    assert.equal(gpt4.cost.cacheWrite, 2.5);
    assert.equal(gpt4.contextWindow, 128000);
    assert.equal(gpt4.maxTokens, 4096);
    assert.deepEqual(gpt4.compat, { supportsDeveloperRole: false });
  });

  it("falls back to defaults when model info is missing fields", async () => {
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "minimal-model" }] }), {
          status: 200,
        });
      }
      if (url.includes("/model/info")) {
        return new Response(
          JSON.stringify([
            {
              id: "minimal-model",
              input_cost_per_token: null,
              output_cost_per_token: null,
              cache_read_input_token_cost: null,
              cache_creation_input_token_cost: null,
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    assert.equal(models.length, 1);
    const m = models[0];
    assert.equal(m.cost.input, 0);
    assert.equal(m.cost.output, 0);
    assert.equal(m.cost.cacheRead, 0);
    assert.equal(m.cost.cacheWrite, 0);
    assert.equal(m.contextWindow, 128000);
    assert.equal(m.maxTokens, 16384);
  });

  it("uses max_input_tokens when max_output_tokens is absent", async () => {
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "input-only" }] }), {
          status: 200,
        });
      }
      if (url.includes("/model/info")) {
        return new Response(
          JSON.stringify([
            {
              id: "input-only",
              max_input_tokens: 32000,
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    assert.equal(models.length, 1);
    assert.equal(models[0].contextWindow, 32000);
    assert.equal(models[0].maxTokens, 16384);
  });

  it("continues when /model/info fails", async () => {
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "fallback" }] }), {
          status: 200,
        });
      }
      if (url.includes("/model/info")) {
        throw new Error("network down");
      }
      return new Response("not found", { status: 404 });
    };

    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "fallback");
    assert.equal(models[0].cost.input, 0);
  });

  it("throws CatalogError when /v1/models has no data array", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), { status: 200 });
    await assert.rejects(
      () => fetchCatalogModels(makeFetchConfig(), "api-key"),
      (err) => (err as Error).message.includes("data array"),
    );
  });
});

describe("catalog cache helpers", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-test-"));
  });

  it("round-trips a catalog through the cache file", async () => {
    const cachePath = path.join(tmpDir, "cache.json");
    const models: ProviderModelConfig[] = [
      {
        id: "m1",
        name: "m1",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 500,
      },
    ];

    await saveCachedModels(cachePath, models);
    const loaded = await loadCachedModels(cachePath);
    assert.deepEqual(loaded, models);
  });

  it("returns null for a corrupt cache file", async () => {
    const cachePath = path.join(tmpDir, "cache.json");
    await writeFile(cachePath, "not json", "utf8");
    const loaded = await loadCachedModels(cachePath);
    assert.equal(loaded, null);
  });

  it("computes cache age in ms", async () => {
    const cachePath = path.join(tmpDir, "cache.json");
    const before = Date.now();
    await saveCachedModels(cachePath, []);
    const age = await computeCacheAge(cachePath);
    assert.ok(age !== null && age >= 0);
    assert.ok(age <= Date.now() - before + 100);
  });
});

describe("buildProviderConfig", () => {
  const baseCfg = {
    baseUrl: BASE_URL,
    providerId: "actsis-litellm",
    catalogTtlMs: 15 * 60 * 1000,
    requestTimeoutMs: 30_000,
  };

  function makeStored(id: string): ProviderModelConfig {
    return {
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 500,
    };
  }

  function mockRefreshContext(options: {
    allowNetwork: boolean;
    stored?: ProviderModelConfig[];
    credential?: { type: "oauth"; access: string; refresh: string; expires: number };
    force?: boolean;
  }): RefreshModelsContext {
    return {
      allowNetwork: options.allowNetwork,
      stored: options.stored ? { models: options.stored } : undefined,
      credential: options.credential,
      force: options.force,
      publish: async () => false,
      signal: new AbortController().signal,
    } as RefreshModelsContext;
  }

  it("initial models come from cache", async () => {
    const cached: ProviderModelConfig[] = [makeStored("cached-model")];

    const provider = await buildProviderConfig(baseCfg, {
      loadCachedModels: () => Promise.resolve(cached),
      saveCachedModels: async () => {},
      computeCacheAge: async () => null,
    });

    const initial = provider.models;
    assert.equal(initial.length, 1);
    assert.equal(initial[0].id, "cached-model");
  });

  it("getApiKey returns the access token", async () => {
    const provider = await buildProviderConfig(baseCfg);
    assert.equal(
      provider.oauth.getApiKey({
        access: "token-123",
        refresh: "refresh-123",
        expires: Date.now() + 3600_000,
      } as import("@earendil-works/pi-ai/compat").OAuthCredentials),
      "token-123",
    );
  });

  it("refreshModels returns stored models when offline", async () => {
    const stored = [makeStored("offline")];
    const provider = await buildProviderConfig(baseCfg, {
      loadCachedModels: () => Promise.resolve(stored),
      saveCachedModels: async () => {},
      computeCacheAge: async () => null,
    });

    const result = await provider.refreshModels(
      mockRefreshContext({ allowNetwork: false, stored }),
    );

    assert.deepEqual(result, stored);
  });

  it("refreshModels short-circuits when cache is fresh and not forced", async () => {
    const stored = [makeStored("fresh")];

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    const provider = await buildProviderConfig(
      { ...baseCfg, catalogTtlMs: 60_000 },
      {
        loadCachedModels: () => Promise.resolve(stored),
        saveCachedModels: async () => {},
        computeCacheAge: async () => 10_000,
      },
    );

    const credential = {
      type: "oauth" as const,
      access: "key",
      refresh: "refresh",
      expires: Date.now() + 3600_000,
    };

    const result = await provider.refreshModels(
      mockRefreshContext({ allowNetwork: true, credential, stored }),
    );

    assert.equal(fetchCalled, false);
    assert.deepEqual(result, stored);
  });

  it("refreshModels degrades to stored models on AuthError", async () => {
    const stored = [makeStored("kept")];

    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    };

    const provider = await buildProviderConfig(
      { ...baseCfg, catalogTtlMs: 0 },
      {
        loadCachedModels: () => Promise.resolve(stored),
        saveCachedModels: async () => {},
        computeCacheAge: async () => null,
      },
    );

    const credential = {
      type: "oauth" as const,
      access: "key",
      refresh: "refresh",
      expires: Date.now() + 3600_000,
    };

    const result = await provider.refreshModels(
      mockRefreshContext({ allowNetwork: true, credential, stored, force: true }),
    );

    assert.deepEqual(result, stored);
  });

  it("refreshModels degrades gracefully when cache save fails", async () => {
    const stored = [makeStored("kept")];
    // Expected mapped shape: fetchCatalogModels/infoToConfig defaults
    // (reasoning, contextWindow, maxTokens, compat) override the stored
    // fixture values for gateway-fetched models.
    const fresh: ProviderModelConfig[] = [
      {
        ...makeStored("fresh-from-gateway"),
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 16384,
        compat: { supportsDeveloperRole: false },
      },
    ];

    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "fresh-from-gateway" }] }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    };

    let saveCount = 0;
    const provider = await buildProviderConfig(
      { ...baseCfg, catalogTtlMs: 0 },
      {
        loadCachedModels: () => Promise.resolve(stored),
        saveCachedModels: async () => {
          saveCount++;
          throw new Error("EACCES: disk full");
        },
        computeCacheAge: async () => null,
      },
    );

    const credential = {
      type: "oauth" as const,
      access: "key",
      refresh: "refresh",
      expires: Date.now() + 3600_000,
    };

    // refreshModels must not reject: pi renders "Could not refresh <provider>;
    // showing cached models" whenever it throws, even with fresh models usable.
    const result = await provider.refreshModels(
      mockRefreshContext({ allowNetwork: true, credential, stored, force: true }),
    );

    assert.equal(saveCount, 1);
    assert.deepEqual(result, fresh);
  });

  it("refreshModels degrades gracefully when publish rejects", async () => {
    const stored = [makeStored("kept")];
    const fresh: ProviderModelConfig[] = [
      {
        ...makeStored("fresh-from-gateway"),
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 16384,
        compat: { supportsDeveloperRole: false },
      },
    ];

    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "fresh-from-gateway" }] }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    };

    const provider = await buildProviderConfig(
      { ...baseCfg, catalogTtlMs: 0 },
      {
        loadCachedModels: () => Promise.resolve(stored),
        saveCachedModels: async () => {},
        computeCacheAge: async () => null,
      },
    );

    const credential = {
      type: "oauth" as const,
      access: "key",
      refresh: "refresh",
      expires: Date.now() + 3600_000,
    };

    const context = mockRefreshContext({
      allowNetwork: true,
      credential,
      stored,
      force: true,
    });
    // Transient models-store write failure (lock contention between concurrent
    // pi sessions) must not surface as a catalog refresh error.
    context.publish = async () => {
      throw new Error("models-store lock contention");
    };

    const result = await provider.refreshModels(context);

    assert.deepEqual(result, fresh);
  });
});
