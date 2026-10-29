import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  parseImageArgs,
  imageTimeoutMs,
  fetchImageGeneration,
  saveImageB64,
  IMAGE_DEFAULT_MODEL,
} from "../extensions/lib/image.ts";
import { buildImageCommandHandler, type CommandDeps } from "../extensions/lib/commands.ts";
import { AuthError, CommandError } from "../extensions/lib/errors.ts";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

const BASE_URL = "https://gateway.example.com";
const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

let originalFetch: typeof globalThis.fetch;
before(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

describe("parseImageArgs", () => {
  it("defaults the size to 512x512 and keeps the full prompt", () => {
    const parsed = parseImageArgs("a dragon");
    assert.equal(parsed.prompt, "a dragon");
    assert.equal(parsed.size, "512x512");
    assert.equal(parsed.model, IMAGE_DEFAULT_MODEL);
  });

  it("accepts --size 512|768|1024 anywhere in the args", () => {
    assert.equal(parseImageArgs("--size 1024 a dragon").size, "1024x1024");
    assert.equal(parseImageArgs("a dragon --size 768").size, "768x768");
  });

  it("rejects unsupported sizes before any fetch", () => {
    assert.throws(() => parseImageArgs("--size 256 a dragon"), CommandError);
    assert.throws(() => parseImageArgs("--size abc a dragon"), CommandError);
  });

  it("rejects an empty prompt", () => {
    assert.throws(() => parseImageArgs(""), CommandError);
    assert.throws(() => parseImageArgs("   "), CommandError);
    assert.throws(() => parseImageArgs("--size 512"), CommandError);
  });
});

describe("imageTimeoutMs", () => {
  it("never drops below the 180s generation guard", () => {
    assert.equal(imageTimeoutMs(30_000), 180_000);
    assert.equal(imageTimeoutMs(undefined), 180_000);
  });

  it("keeps a caller-provided timeout above the guard", () => {
    assert.equal(imageTimeoutMs(300_000), 300_000);
  });
});

describe("fetchImageGeneration", () => {
  it("posts the OpenAI images request shape (issue #47 S1)", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response(
        JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await fetchImageGeneration(BASE_URL, "sk-test", {
      prompt: "a dragon",
      model: IMAGE_DEFAULT_MODEL,
      size: "512x512",
    });

    assert.equal(seenUrl, `${BASE_URL}/v1/images/generations`);
    assert.equal(seenInit?.method, "POST");
    const headers = seenInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk-test");
    const body = JSON.parse(String(seenInit?.body));
    assert.deepEqual(body, {
      model: "sdxl-pixel-art",
      prompt: "a dragon",
      n: 1,
      size: "512x512",
      output_format: "png",
    });
    assert.deepEqual(result.images, [PNG_B64]);
  });

  it("maps 401/403 to AuthError with a re-login message", async () => {
    globalThis.fetch = jsonFetch(401, { error: { message: "bad key" } });
    await assert.rejects(
      () =>
        fetchImageGeneration(BASE_URL, "sk-test", {
          prompt: "x",
          model: IMAGE_DEFAULT_MODEL,
          size: "512x512",
        }),
      (err: unknown) =>
        err instanceof AuthError && /login again/i.test(err.message),
    );
  });

  it("reports gateway 500 failures with a friendly message", async () => {
    globalThis.fetch = jsonFetch(500, { error: { message: "boom" } });
    await assert.rejects(
      () =>
        fetchImageGeneration(BASE_URL, "sk-test", {
          prompt: "x",
          model: IMAGE_DEFAULT_MODEL,
          size: "512x512",
        }),
      (err: unknown) => /500/.test((err as Error).message),
    );
  });

  it("rejects a response without data[].b64_json", async () => {
    globalThis.fetch = jsonFetch(200, { data: [{}] });
    await assert.rejects(
      () =>
        fetchImageGeneration(BASE_URL, "sk-test", {
          prompt: "x",
          model: IMAGE_DEFAULT_MODEL,
          size: "512x512",
        }),
      /b64_json/,
    );
  });
});

describe("saveImageB64", () => {
  it("writes the decoded png and returns the path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "img-"));
    const p = await saveImageB64(PNG_B64, dir);
    assert.match(p, /\.png$/);
    assert.equal(
      Buffer.from(await readFile(p)).toString("hex"),
      Buffer.from("fake-png-bytes", "utf8").toString("hex"),
    );
  });
});

describe("/image command", () => {
  let originalEnv: string | undefined;
  before(() => {
    originalEnv = process.env.ACTSIS_LITELLM_URL;
  });
  beforeEach(() => {
    // Set per test: the suite-level afterEach must not leak a restore that
    // leaves later tests without a gateway URL (CI has no ~/.pi files).
    process.env.ACTSIS_LITELLM_URL = BASE_URL;
  });
  after(() => {
    if (originalEnv === undefined) delete process.env.ACTSIS_LITELLM_URL;
    else process.env.ACTSIS_LITELLM_URL = originalEnv;
  });

  function makeCtx(opts: {
    apiKey?: string;
    hasUI?: boolean;
    notify?: (message: string, level?: string) => void;
  }) {
    const notifications: Array<{ message: string; level?: string }> = [];
    const notify =
      opts.notify ??
      ((message: string, level?: string) => notifications.push({ message, level }));
    return {
      notifications,
      ctx: {
        hasUI: opts.hasUI ?? true,
        notify,
        ui: { notify, setStatus: () => {}, setWidget: () => {} },
        modelRegistry: {
          getProviderAuth: async () =>
            opts.apiKey === undefined ? null : { auth: { apiKey: opts.apiKey } },
          getRegisteredProviderIds: () => ["actsis-litellm"],
          getAll: () => [],
        },
      } as unknown as Parameters<ReturnType<typeof buildImageCommandHandler>>[1],
      notify,
    };
  }

  function makeDeps(over: Partial<CommandDeps> = {}): CommandDeps {
    return {
      getState: () => ({}),
      cachePath: path.join(os.tmpdir(), "img-cmd-cache.json"),
      authPath: path.join(os.tmpdir(), "img-cmd-auth.json"),
      prefsPath: path.join(os.tmpdir(), "img-cmd-prefs.json"),
      requestTimeoutMs: 30_000,
      ...over,
    };
  }

  it("renders the image into the session when sendMessage is available", async () => {
    globalThis.fetch = jsonFetch(200, { data: [{ b64_json: PNG_B64 }] });
    const sent: Array<{
      customType: string;
      content: Array<TextContent | ImageContent> | string;
      display: boolean;
    }> = [];
    const dir = await mkdtemp(path.join(os.tmpdir(), "img-render-"));
    const { ctx } = makeCtx({ apiKey: "sk-x" });
    const deps = makeDeps({
      sendMessage: (message) => {
        sent.push(message);
      },
      imageSaveDir: dir,
    });
    await buildImageCommandHandler(deps)("a dragon", ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "actsis-litellm:image");
    assert.equal(sent[0].display, true);
    const parts = sent[0].content as Array<TextContent | ImageContent>;
    const image = parts.find((p) => (p as ImageContent).type === "image");
    assert.ok(image, "session message contains an image part");
    assert.equal((image as ImageContent).data, PNG_B64);
    assert.equal((image as ImageContent).mimeType, "image/png");
    const text = parts.find((p) => (p as TextContent).type === "text");
    assert.match((text as TextContent).text, /dragon/);
    // Persistent file copy was also written.
    const files = (await import("node:fs")).readdirSync(dir);
    assert.equal(files.length, 1);
  });

  it("falls back to a saved file path when there is no session render", async () => {
    globalThis.fetch = jsonFetch(200, { data: [{ b64_json: PNG_B64 }] });
    const dir = await mkdtemp(path.join(os.tmpdir(), "img-fallback-"));
    const { ctx } = makeCtx({ apiKey: "sk-x" });
    const deps = makeDeps({ imageSaveDir: dir });
    await buildImageCommandHandler(deps)("a dragon", ctx);
    const files = (await import("node:fs")).readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /\.png$/);
  });

  it("fails friendly without credentials and never fetches", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { ctx } = makeCtx({ apiKey: undefined });
    await buildImageCommandHandler(makeDeps())("a dragon", ctx);
    assert.equal(called, false);
  });
});