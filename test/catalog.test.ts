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

function modelInfoFixture(name: string): Record<string, unknown> {
  return {
    model_name: name,
    litellm_params: { model: name },
    model_info: {
      id: `opaque-deployment-hash-${name}`,
      key: name,
      db_model: false,
      mode: "chat",
      max_input_tokens: 128000,
      max_output_tokens: 4096,
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 0.0000015,
      cache_creation_input_token_cost: 0.0000025,
      supports_reasoning: false,
      supports_vision: false,
      supports_function_calling: true,
    },
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
              model_name: "qwen3-coder-next",
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
              model_name: "minimal-model",
              model_info: {
                key: "minimal-model",
                input_cost_per_token: null,
                output_cost_per_token: null,
                cache_read_input_token_cost: null,
                cache_creation_input_token_cost: null,
              },
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
              model_name: "input-only",
              model_info: { key: "input-only", max_input_tokens: 32000 },
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

describe("fetchCatalogModels enrichment", () => {
  function makeFetch(): typeof globalThis.fetch {
    return async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "gpt-oss-120b" },
              { id: "oc/gemma4:31b" },
              { id: "oc/glm-5.1" },
              { id: "tiered-model" },
              { id: "key-only-model" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v2/model/info")) {
        throw new Error("v2 must not be fetched when /model/info succeeds");
      }
      if (url.includes("/model/info")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                // /v1/models id equals model_name, NOT the opaque model_info.id.
                model_name: "gpt-oss-120b",
                litellm_params: { model: "gpt-oss-120b" },
                model_info: {
                  id: "deployment-hash-abc123",
                  key: "gpt-oss-120b",
                  mode: "chat",
                  max_input_tokens: 131072,
                  max_output_tokens: 131072,
                  input_cost_per_token: 7.47e-8,
                  output_cost_per_token: 1.11e-6,
                  supports_reasoning: true,
                  reasoning_effort_levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
                },
              },
              {
                model_name: "oc/gemma4:31b",
                model_info: {
                  id: "deployment-hash-def456",
                  key: "oc/gemma4:31b",
                  mode: "chat",
                  max_input_tokens: 131072,
                  max_output_tokens: 262144,
                  supports_vision: true,
                  supports_reasoning: true,
                  reasoning_effort_levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
                },
              },
              {
                model_name: "oc/glm-5.1",
                model_info: {
                  id: "deployment-hash-ghi789",
                  key: "oc/glm-5.1",
                  mode: "chat",
                  max_input_tokens: 202752,
                  supports_vision: false,
                  supports_reasoning: true,
                  reasoning_effort_levels: ["none", "high"],
                },
              },
              {
                model_name: "tiered-model",
                model_info: {
                  id: "deployment-hash-jkl012",
                  key: "tiered-model",
                  mode: "chat",
                  input_cost_per_token: 0.000003,
                  output_cost_per_token: 0.000015,
                  input_cost_per_token_above_128k_tokens: 0.0000015,
                  output_cost_per_token_above_128k_tokens: 0.0000075,
                  input_cost_per_token_above_200k_tokens: 0.000001,
                  input_cost_per_token_above_512k_tokens: 0.0000005,
                  output_cost_per_token_above_512k_tokens: 0.000005,
                },
              },
              {
                // No model_name: fallback key is model_info.key.
                model_info: {
                  id: "deployment-hash-mno345",
                  key: "key-only-model",
                  mode: "chat",
                  max_input_tokens: 8192,
                  max_output_tokens: 2048,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };
  }

  it("applies enrichment keyed by model_name, not the opaque model_info.id", async () => {
    globalThis.fetch = makeFetch();
    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    assert.deepEqual(models.map((m) => m.id).sort(), [
      "gpt-oss-120b",
      "key-only-model",
      "oc/gemma4:31b",
      "oc/glm-5.1",
      "tiered-model",
    ]);

    const gpt = models.find((m) => m.id === "gpt-oss-120b")!;
    assert.equal(gpt.contextWindow, 131072);
    assert.equal(gpt.maxTokens, 131072);
    assert.equal(gpt.reasoning, true);
    assert.equal(gpt.cost.input, 7.47e-8 * 1_000_000);
    assert.equal(gpt.cost.output, 1.11e-6 * 1_000_000);
  });

  it("matches an entry that only has model_info.key (no model_name)", async () => {
    globalThis.fetch = makeFetch();
    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    const m = models.find((m) => m.id === "key-only-model")!;
    assert.ok(m, "key-only entry must be applied");
    assert.equal(m.contextWindow, 8192);
    assert.equal(m.maxTokens, 2048);
  });

  it("adds image input when supports_vision is true", async () => {
    globalThis.fetch = makeFetch();
    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    assert.deepEqual(models.find((m) => m.id === "oc/gemma4:31b")!.input, [
      "text",
      "image",
    ]);
    assert.deepEqual(models.find((m) => m.id === "oc/glm-5.1")!.input, ["text"]);
  });

  it("derives thinkingLevelMap from reasoning_effort_levels", async () => {
    globalThis.fetch = makeFetch();
    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");

    const glm = models.find((m) => m.id === "oc/glm-5.1")!;
    assert.deepEqual(glm.thinkingLevelMap, {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });

    const gpt = models.find((m) => m.id === "gpt-oss-120b")!;
    assert.deepEqual(gpt.thinkingLevelMap, {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });

    // No reasoning_effort_levels -> no thinkingLevelMap.
    const tiered = models.find((m) => m.id === "tiered-model")!;
    assert.equal(tiered.thinkingLevelMap, undefined);
  });

  it("builds cost tiers from above-threshold fields, sorted ascending", async () => {
    globalThis.fetch = makeFetch();
    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    const tiered = models.find((m) => m.id === "tiered-model")!;
    assert.deepEqual(tiered.cost.tiers, [
      {
        input: 1.5,
        output: 7.5,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokensAbove: 128000,
      },
      {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokensAbove: 200000,
      },
      {
        input: 0.5,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokensAbove: 512000,
      },
    ]);

    // Model without tier fields gets no tiers key.
    const gpt = models.find((m) => m.id === "gpt-oss-120b")!;
    assert.equal(gpt.cost.tiers, undefined);
  });

  it("falls back to /v2/model/info with pagination when /model/info fails", async () => {
    const v2Pages = [
      {
        data: [
          {
            model_name: "v2-model-a",
            model_info: {
              id: "hash-a",
              key: "v2-model-a",
              mode: "chat",
              max_input_tokens: 4096,
              max_output_tokens: 1024,
            },
          },
        ],
        total_count: 2,
        current_page: 1,
        total_pages: 2,
        size: 100,
      },
      {
        data: [
          {
            model_name: "v2-model-b",
            model_info: {
              id: "hash-b",
              key: "v2-model-b",
              mode: "chat",
              max_input_tokens: 8192,
            },
          },
        ],
        total_count: 2,
        current_page: 2,
        total_pages: 2,
        size: 100,
      },
    ];

    const requestedPages: string[] = [];
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "v2-model-a" }, { id: "v2-model-b" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/v2/model/info")) {
        const page = new URL(url).searchParams.get("page");
        requestedPages.push(page ?? "");
        return new Response(JSON.stringify(v2Pages[Number(page) - 1]), {
          status: 200,
        });
      }
      if (url.includes("/model/info")) {
        return new Response("Server Error", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    };

    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    assert.deepEqual(requestedPages, ["1", "2"]);
    assert.deepEqual(models.map((m) => m.id), ["v2-model-a", "v2-model-b"]);
    assert.equal(models[0].contextWindow, 4096);
    assert.equal(models[0].maxTokens, 1024);
    assert.equal(models[1].contextWindow, 8192);
  });

  it("returns models with fallback defaults when both info endpoints fail", async () => {
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "fallback" }] }), {
          status: 200,
        });
      }
      if (url.includes("/model/info") || url.includes("/v2/model/info")) {
        return new Response("Server Error", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    };

    const models = await fetchCatalogModels(makeFetchConfig(), "api-key");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "fallback");
    assert.equal(models[0].contextWindow, 128000);
    assert.equal(models[0].maxTokens, 16384);
    assert.equal(models[0].cost.input, 0);
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

  it("rejects a version 1 cache file after the schema bump", async () => {
    const cachePath = path.join(tmpDir, "cache-v1.json");
    const legacy = {
      version: 1,
      fetchedAt: Date.now(),
      models: [
        {
          id: "stale",
          name: "stale",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    };
    await writeFile(cachePath, JSON.stringify(legacy), "utf8");
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
