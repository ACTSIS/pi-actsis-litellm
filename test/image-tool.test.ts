import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  extractImageModelIds,
  resolveImageModel,
  imageToolTimeoutMs,
  resolveImageInput,
  ImageSessionStore,
  fetchImageEdit,
  buildGenerateImageTool,
  toolDescription,
  IMAGE_TOOL_NAME,
} from "../extensions/lib/image-tool.ts";
import { CommandError, ImageError } from "../extensions/lib/errors.ts";

const PNG_B64 = Buffer.from("fake-png").toString("base64");
const BASE_URL = "https://gateway.example.com";

describe("extractImageModelIds", () => {
  it("keeps only mode=image_generation entries (top-level and model_info fallback)", () => {
    const body = {
      data: [
        { id: "sdxl-pixel-art", mode: "image_generation" },
        { id: "qwen-image-edit", model_info: { mode: "image_generation" } },
        { id: "gpt-oss-120b", mode: "chat" },
        { id: "nomic-embed", mode: "embedding" },
        { id: "no-mode" },
        { noIdAtAll: true, mode: "image_generation" },
      ],
    };
    assert.deepEqual(extractImageModelIds(body), ["sdxl-pixel-art", "qwen-image-edit"]);
  });

  it("returns [] for malformed bodies", () => {
    assert.deepEqual(extractImageModelIds(null), []);
    assert.deepEqual(extractImageModelIds({}), []);
    assert.deepEqual(extractImageModelIds({ data: "nope" }), []);
  });
});

describe("resolveImageModel (S2 policy)", () => {
  it("explicit param wins (validated/prefixed against discovered list)", () => {
    assert.equal(
      resolveImageModel("qwen-image-edit", false, ["sdxl-pixel-art", "qwen-image-edit"]).model,
      "qwen-image-edit",
    );
    assert.equal(
      resolveImageModel("qwen", false, ["sdxl-pixel-art", "qwen-image-edit-2511"]).model,
      "qwen-image-edit-2511",
    );
  });

  it("image input present -> the editing-capable model", () => {
    assert.equal(
      resolveImageModel(undefined, true, ["sdxl-pixel-art", "qwen-image-edit"]).model,
      "qwen-image-edit",
    );
    assert.equal(resolveImageModel(undefined, true, []).askedHint, true);
  });

  it("plain request -> gateway default when it is discoverable or the list is empty", () => {
    assert.equal(resolveImageModel(undefined, false, ["sdxl-pixel-art"]).model, "sdxl-pixel-art");
    assert.equal(resolveImageModel(undefined, false, []).model, "sdxl-pixel-art");
  });

  it("plain request with the default unavailable -> first discovered model (graceful fallback)", () => {
    const got = resolveImageModel(undefined, false, ["first-model", "second-model"]);
    assert.equal(got.model, "first-model");
    assert.equal(got.askedHint, true);
  });
});

describe("imageToolTimeoutMs (S4)", () => {
  it("scales by model family and width", () => {
    assert.equal(imageToolTimeoutMs("qwen-image-edit", "1024x1024"), 600_000);
    assert.equal(imageToolTimeoutMs("qwen-image-edit", "512x512"), 300_000);
    assert.equal(imageToolTimeoutMs("sdxl-pixel-art", "512x512").valueOf(), 180_000);
    assert.equal(imageToolTimeoutMs("sdxl-pixel-art", "1024x1024").valueOf(), 180_000);
  });
});

describe("resolveImageInput / session store (S3/S5)", () => {
  it("'last' without history throws a CommandError", async () => {
    await assert.rejects(
      () => resolveImageInput("last", new ImageSessionStore()),
      CommandError,
    );
  });

  it("'last' with history returns the stored image", async () => {
    const store = new ImageSessionStore();
    store.set({ data: PNG_B64, mimeType: "image/png", filePath: "/tmp/x.png" });
    const got = await resolveImageInput("last", store);
    assert.equal(got.data, PNG_B64);
  });

  it("reads a file path with png/jpg/webp mime mapping", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "imgtool-"));
    const file = path.join(dir, "input.png");
    await writeFile(file, Buffer.from(PNG_B64, "base64"));
    const got = await resolveImageInput(file, new ImageSessionStore());
    assert.equal(got.mimeType, "image/png");
    assert.equal(Buffer.from(got.data, "base64").toString(), "fake-png");
  });

  it("rejects unsupported extensions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "imgtool-"));
    const file = path.join(dir, "input.tiff");
    await writeFile(file, "x");
    await assert.rejects(() => resolveImageInput(file, new ImageSessionStore()), CommandError);
  });
});

describe("fetchImageEdit", () => {
  it("posts multipart to /v1/images/edits and extracts b64_json", async () => {
    let capturedMethod = "";
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedMethod = (init?.method ?? "GET").valueOf();
      capturedUrl = String(url);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const result = await fetchImageEdit(BASE_URL, "k", {
        model: "qwen-image-edit",
        prompt: "replace the cabin",
        image: { data: PNG_B64, mimeType: "image/png" },
      }, 5000);
      assert.equal(capturedUrl, `${BASE_URL}/v1/images/edits`);
      assert.equal(capturedMethod, "POST");
      assert.deepEqual(result.images, [PNG_B64]);
      assert.equal(result.model, "qwen-image-edit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces 401 as AuthError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("unauth", { status: 401 })) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(
        () => fetchImageEdit(BASE_URL, "k", { model: "m", prompt: "p", image: { data: PNG_B64, mimeType: "image/png" } }, 5000),
        (err: unknown) => err instanceof Error && /login/i.test(err.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces 500 as ImageError with the /usage hint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(
        () => fetchImageEdit(BASE_URL, "k", { model: "m", prompt: "p", image: { data: PNG_B64, mimeType: "image/png" } }, 5000),
        (err: unknown) => err instanceof Error && err instanceof ImageError && /usage/.test(err.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("buildGenerateImageTool.execute", () => {
  type ToolShape = ReturnType<typeof buildGenerateImageTool> & {
    execute: (
      id: string,
      params: { prompt: string; size?: string; model?: string; image?: string },
      signal: AbortSignal | undefined,
      onUpdate: ((u: { content: Array<{ type: string; text?: string }> }) => void) | undefined,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;
  };

  function makeTool(overrides?: Partial<Parameters<typeof buildGenerateImageTool>[0]>) {
    const store = new ImageSessionStore();
    const sent: unknown[] = [];
    const tool = buildGenerateImageTool({
      getProviderId: () => "actsis-litellm",
      authPath: "/nonexistent/auth.json",
      store,
      sendMessage: (message) => sent.push(message),
      resolveStatusConfig: async () => ({ baseUrl: BASE_URL }),
      getUsableApiKey: async () => "key-123",
      ...overrides,
    }) as unknown as ToolShape & { description: string };
    return { tool, store, sent };
  }

  function stubCatalogFetch(modelId: string): void {
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("/v1/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: modelId, mode: "image_generation" },
            { id: "other", mode: "chat" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } }) as Response;
      }
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as Response;
    }) as unknown as typeof globalThis.fetch;
  }

  it("generates (no image input) with the gateway default model and renders the result", async () => {
    const { tool, store, sent } = makeTool();
    stubCatalogFetch("sdxl-pixel-art");
    const res = await tool.execute("t1", { prompt: "a dragon" }, undefined, undefined, { modelRegistry: {} });
    assert.match(res.content[0].text ?? "", /sdxl-pixel-art/);
    assert.match(res.content[0].text ?? "", /image="last"/);
    assert.equal(res.details.model, "sdxl-pixel-art");
    assert.equal(store.get()?.data, PNG_B64);
    const rendered = sent.find((m) => (m as { customType?: string }).customType === "actsis-litellm:image");
    assert.ok(rendered, "displayed custom image message expected");
  });

  it("with image input it routes to the edit-capable model via multipart edits", async () => {
    const { tool, store } = makeTool();
    stubCatalogFetch("qwen-image-edit");
    const dir = await mkdtemp(path.join(os.tmpdir(), "imgtool-"));
    const input = path.join(dir, "in.png");
    await writeFile(input, Buffer.from(PNG_B64, "base64"));
    let editEndpointHit = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/v1/images/edits")) {
        editEndpointHit = (init?.method ?? "GET") === "POST";
        return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
          status: 200, headers: { "content-type": "application/json" },
        }) as Response;
      }
      return (originalFetch as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      const res = await tool.execute("t2", { prompt: "replace the cabin", image: input }, undefined, undefined, { modelRegistry: {} });
      assert.equal(editEndpointHit, true);
      assert.equal(res.details.model, "qwen-image-edit");
      assert.equal(store.get()?.data, PNG_B64);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("follow-up edit with image='last' resolves the session image (S3)", async () => {
    const { tool } = makeTool();
    stubCatalogFetch("qwen-image-edit");
    await tool.execute("t3a", { prompt: "first image" }, undefined, undefined, { modelRegistry: {} });
    const res = await tool.execute("t3b", { prompt: "now edit it", image: "last" }, undefined, undefined, { modelRegistry: {} });
    assert.equal(res.details.model, "qwen-image-edit");
  });

  it("reports progress through onUpdate before the gateway call (S4)", async () => {
    const { tool } = makeTool();
    stubCatalogFetch("sdxl-pixel-art");
    const updates: string[] = [];
    await tool.execute("t4", { prompt: "a dragon" }, undefined, (u) => {
      const first = (u.content as Array<{ type: string; text?: string }>)[0];
      updates.push(first && first.type === "text" ? (first.text ?? "") : "");
    }, { modelRegistry: {} });
    assert.equal(updates.length, 1);
    assert.match(updates[0] ?? "", /Generating/);
  });
});

describe("toolDescription", () => {
  it("lists discovered models and explains the ask-the-user policy", () => {
    const desc = toolDescription(["sdxl-pixel-art", "qwen-image-edit"]);
    assert.match(desc, /sdxl-pixel-art/);
    assert.match(desc, /qwen-image-edit/);
    assert.match(desc, /ask the user/);
  });

  it("falls back to discover-at-call-time wording when the list is empty", () => {
    assert.match(toolDescription([]), /discover at call time/);
  });

  it("keeps a stable tool name", () => {
    assert.equal(IMAGE_TOOL_NAME, "actsis-litellm:generate_image");
  });
});