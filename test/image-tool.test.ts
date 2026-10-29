import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
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
  withHeartbeat,
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

describe("imageToolTimeoutMs (S2)", () => {
  it("budgets by model family and the longest side actually requested", () => {
    assert.equal(imageToolTimeoutMs("qwen-image-edit", "512x512"), 300_000);
    assert.equal(imageToolTimeoutMs("Qwen-Image-Edit", "768x768"), 1_500_000);
    assert.equal(imageToolTimeoutMs("qwen-image-edit", "1024x1024"), 1_500_000);
    assert.equal(imageToolTimeoutMs("sdxl-pixel-art", "512x512"), 180_000);
    assert.equal(imageToolTimeoutMs("sdxl-pixel-art", "1024x1024"), 180_000);
    assert.equal(imageToolTimeoutMs("some-other-family", "768x768"), 180_000);
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
  it("uses the image[] field name — required by the LiteLLM passthrough (regression for the 400)", async () => {
    const originalFetch = globalThis.fetch;
    let formData: FormData | null = null;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      assert.match(String(url), /\/v1\/images\/edits$/);
      const req = new Request(String(url), init as RequestInit);
      formData = await req.formData();
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as Response;
    }) as unknown as typeof globalThis.fetch;
    try {
      await fetchImageEdit(BASE_URL, "k", {
        model: "qwen-image-edit",
        prompt: "replace the cabin",
        image: { data: PNG_B64, mimeType: "image/png" },
      }, 5000);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const typed = formData as FormData | null;
    assert.ok(typed, "multipart body expected");
    assert.ok(typed.get("image[]"), "the image must travel as the image[] field");
    assert.equal(typed.get("files"), null, "the files field is UNKNOWN to the LiteLLM images/edits passthrough (root cause of the 400)");
    assert.equal(typed.get("prompt"), "replace the cabin");
  });

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
        () => fetchImageEdit(BASE_URL, "k", { model: "m", prompt: "p", image: { data: PNG_B64, mimeType: "image/png" }, size: "512x512" }, 5000),
        (err: unknown) => err instanceof Error && err instanceof ImageError && /usage/.test(err.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("S1: sends the target size as a multipart size field (512 default and 1024)", async () => {
    const originalFetch = globalThis.fetch;
    const forms: FormData[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      assert.match(String(url), /\/v1\/images\/edits$/);
      const req = new Request(String(url), init as RequestInit);
      forms.push(await req.formData());
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as Response;
    }) as unknown as typeof globalThis.fetch;
    try {
      await fetchImageEdit(BASE_URL, "k", {
        model: "qwen-image-edit",
        prompt: "p",
        image: { data: PNG_B64, mimeType: "image/png" },
      }, 5000);
      await fetchImageEdit(BASE_URL, "k", {
        model: "qwen-image-edit",
        prompt: "p",
        image: { data: PNG_B64, mimeType: "image/png" },
        size: "1024x1024",
      }, 5000);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(forms.length, 2);
    assert.equal(forms[0].get("size"), "512x512");
    assert.equal(forms[1].get("size"), "1024x1024");
  });

  it("S4: rewrites a client-side timeout as an abandoned-render message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
      throw err;
    }) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(
        () => fetchImageEdit(BASE_URL, "k", {
          model: "qwen-image-edit",
          prompt: "p",
          image: { data: PNG_B64, mimeType: "image/png" },
          size: "512x512",
        }, 5_000),
        (err: unknown) => {
          assert.ok(err instanceof ImageError);
          assert.match((err as Error).message, /abandoned by the client after \d+s of a 5s budget/);
          assert.match((err as Error).message, /render may still be running in the backend and keeps the GPU busy/);
          assert.doesNotMatch((err as Error).message, /Failed to reach gateway images edits endpoint/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("S4: keeps the gateway-unreachable wording for non-timeout network failures", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new TypeError("fetch failed") as unknown as Error & { cause: Error };
      err.cause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      throw err;
    }) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(
        () => fetchImageEdit(BASE_URL, "k", {
          model: "qwen-image-edit",
          prompt: "p",
          image: { data: PNG_B64, mimeType: "image/png" },
          size: "512x512",
        }, 5_000),
        (err: unknown) => {
          assert.ok(err instanceof ImageError);
          assert.match((err as Error).message, /Failed to reach gateway images edits endpoint/);
          assert.doesNotMatch((err as Error).message, /abandoned after/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("withHeartbeat (S3)", () => {
  it("reports elapsed seconds while pending and clears the timer on success and error", async () => {
    const updates: string[] = [];
    const onUpdate = ((u: { content: Array<{ type: string; text?: string }> }) => {
      const text = (u.content as Array<{ type: string; text?: string }>)[0]?.text;
      if (text) updates.push(text);
    }) as unknown as AgentToolUpdateCallback;

    const success = await withHeartbeat(
      new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 120)),
      onUpdate,
      50,
    );
    assert.equal(success, "ok");
    assert.ok(
      updates.some((t) => /\d+s elapsed/.test(t)),
      `expected elapsed seconds in heartbeat, got: ${updates.join(", ")}`,
    );

    // Ensure the interval is cleared after settlement: no more updates arrive.
    const countAfterSuccess = updates.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(updates.length, countAfterSuccess, "heartbeat leaked after success");

    updates.length = 0;
    await assert.rejects(
      withHeartbeat(
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("boom")), 80)),
        onUpdate,
        50,
      ),
      /boom/,
    );
    assert.ok(updates.some((t) => /\d+s elapsed/.test(t)), "heartbeat expected on rejected promise");
    const countAfterError = updates.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(updates.length, countAfterError, "heartbeat leaked after error");
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

  it("states that Edit-named models also generate from scratch (regression: local agent misread it as edit-only)", () => {
    const desc = toolDescription(["sdxl-pixel-art", "qwen-image-edit"]);
    assert.match(desc, /FROM SCRATCH/);
    assert.match(desc, /does NOT restrict it to editing/);
    assert.match(desc, /BAKED IN/);        // sdxl style is fixed
    assert.match(desc, /3D\/realistic/); // style-driven routing guidance
  });

  it("falls back to discover-at-call-time wording when the list is empty", () => {
    assert.match(toolDescription([]), /discover at call time/);
  });

  it("keeps a model-safe tool name (no colon: ChatGPT/Claude reject it in history)", () => {
    assert.equal(IMAGE_TOOL_NAME, "actsis-litellm_generate_image");
    assert.match(IMAGE_TOOL_NAME, /^[a-zA-Z0-9_-]+$/);
  });
});