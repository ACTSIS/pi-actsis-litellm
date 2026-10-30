import { fetchOrThrow } from "./client.ts";
import { AuthError, CommandError, ImageError } from "./errors.ts";
import { fetchImageGeneration, saveImageB64, IMAGE_DEFAULT_MODEL, IMAGE_CUSTOM_TYPE } from "./image.ts";
import { ImageJobRegistry, IMAGE_JOB_STATUS_KEY, type ImageJob } from "./image-jobs.ts";
import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/**
 * Model-callable image generation/editing tool (issue #47 v2 — natural chat
 * requests; owner spec S1-S5 in odd/tasks/agent-image-tool.md).
 *
 * The tool description carries the DISCOVERED image models so the agent can
 * ask the user which one to use; selection policy (S2) is applied inside:
 * explicit param > heuristic (an image input present -> editing model) >
 * gateway default (sdxl-pixel-art).
 */

export interface ImageModelOption {
  id: string;
}

interface ModelEntry {
  id?: unknown;
  mode?: unknown;
  model_info?: { mode?: unknown };
}

export const EDIT_MODEL_HINT = "edit";
// Model-safe name: only [a-zA-Z0-9_-] (ChatGPT Responses input[].name and
// Claude tool names reject ":" — ":" in a session history 400s the whole
// request against openai-sub/claude-sub; the /actsis-litellm:* prefix stays
// for COMMANDS which models never see)
export const IMAGE_TOOL_NAME = "actsis-litellm_generate_image";

/** Adaptive timeout by model family and actual edit size (S2): generation is synchronous. */
export function imageToolTimeoutMs(model: string, size: string): number {
  const [w = 512, h = 512] = size.split("x").map((s) => parseInt(s, 10));
  const longest = Math.max(Number.isFinite(w) ? w : 512, Number.isFinite(h) ? h : 512);
  if (model.toLowerCase().includes("qwen")) return longest >= 768 ? 1_500_000 : 300_000;
  return 180_000;
}

/** Maximum seconds between in-flight progress updates for slow image renders (S3). */
export const IMAGE_HEARTBEAT_CADENCE_MS = 30_000;

/** Reports elapsed seconds via onUpdate while a promise is in flight (S3). */
export function withHeartbeat<T>(
  promise: Promise<T>,
  onUpdate: AgentToolUpdateCallback | undefined,
  cadenceMs = IMAGE_HEARTBEAT_CADENCE_MS,
  startedAt = Date.now(),
): Promise<T> {
  if (!onUpdate || cadenceMs <= 0) return promise;
  let timer: ReturnType<typeof setInterval> | undefined;
  timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    onUpdate({
      content: [{ type: "text", text: `Still waiting... ${elapsed}s elapsed` }],
      details: {},
    });
  }, cadenceMs);
  return promise.finally(() => {
    if (timer) clearInterval(timer);
  });
}

/** Map the gateway's /v1/models to the available image model ids. */
export function extractImageModelIds(body: unknown): string[] {
  const data =
    body !== null && typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).data)
      ? ((body as Record<string, unknown>).data as unknown[])
      : [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as ModelEntry;
    const id = typeof e.id === "string" ? e.id : "";
    if (!id) continue;
    let mode: unknown = e.mode;
    if (mode === undefined && e.model_info && typeof e.model_info === "object") {
      mode = (e.model_info as { mode?: unknown }).mode;
    }
    if (mode === "image_generation") ids.push(id);
  }
  return ids;
}

export async function discoverImageModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<ImageModelOption[]> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const response = await fetchOrThrow(
    `${normalized}/v1/models?include_metadata=true`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs ?? 15_000),
    },
    (message, cause) => new ImageError(message, { cause }),
    "Failed to discover image models",
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  return extractImageModelIds(body).map((id) => ({ id }));
}

/**
 * S2 policy: explicit param (validated against the discovered list when the
 * gateway answers) > heuristic (image input -> the editing-capable model) >
 * IMAGE_DEFAULT_MODEL.
 */
export function resolveImageModel(
  explicit: string | undefined,
  hasImageInput: boolean,
  discovered: string[] = [],
): { model: string; askedHint: boolean } {
  if (explicit && explicit.length > 0) {
    const id = discovered.includes(explicit)
      ? explicit
      : (discovered.find((m) => m.startsWith(explicit)) ?? explicit);
    return { model: id, askedHint: false };
  }
  if (hasImageInput) {
    const editModel = discovered.find((m) => m.toLowerCase().includes(EDIT_MODEL_HINT))
      ?? `qwen-image-${EDIT_MODEL_HINT}`;
    return { model: editModel, askedHint: true };
  }
  if (discovered.includes(IMAGE_DEFAULT_MODEL) || discovered.length === 0) {
    return { model: IMAGE_DEFAULT_MODEL, askedHint: false };
  }
  // The documented default isn't available in this gateway: fall back to the
  // first discovered image model instead of failing the request.
  return { model: discovered[0], askedHint: true };
}

/** Session store for follow-up edits ("last" reference, S3/S5). */
export interface SessionImage {
  data: string; // base64 png
  mimeType: string;
  filePath?: string;
}

export class ImageSessionStore {
  private last_: SessionImage | null = null;
  set(image: SessionImage): void {
    this.last_ = image;
  }
  get(): SessionImage | null {
    return this.last_;
  }
  clear(): void {
    this.last_ = null;
  }
}

const MIME_MAP = new Map<string, string>([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

/** Resolve the tool's image input: "last" (S3) or a filesystem path. */
export async function resolveImageInput(
  input: string,
  store: ImageSessionStore,
): Promise<SessionImage> {
  if (input === "last" || input === "última" || input === "last_image") {
    const prev = store.get();
    if (!prev) {
      throw new CommandError(
        'No previous image in this session: generate one first or pass a file path.',
      );
    }
    return prev;
  }
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const ext = path.extname(input).toLowerCase();
  const mimeType = MIME_MAP.get(ext);
  if (!mimeType) {
    throw new CommandError(
      `Unsupported image type "${ext || "(none)"}" (png/jpg/jpeg/webp expected)`,
    );
  }
  const data = (await readFile(input)).toString("base64");
  return { data, mimeType, filePath: input };
}

function isClientTimeoutError(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let i = 0; i < 5 && current instanceof Error; i++) {
    if (seen.has(current)) break;
    seen.add(current);
    const name = current.name;
    const code = (current as { code?: unknown }).code;
    if (name === "TimeoutError" || code === 23 || code === "23") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Multipart edit request (S3) — mirrors fetchImageGeneration's error shapes. */
export async function fetchImageEdit(
  baseUrl: string,
  apiKey: string,
  options: { model: string; prompt: string; image: SessionImage; size?: string },
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ImageGenerationResultShape> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const size = options.size ?? "512x512";
  const form = new FormData();
  form.append("model", options.model);
  form.append("prompt", options.prompt);
  form.append("n", "1");
  form.append("size", size);
  // Field name matters all the way through LiteLLM's images/edits passthrough:
  // "files" is unknown there and the request reaches the upstream without the
  // multipart body (400 "Content-Type must be multipart/form-data"). The
  // sd-server/OpenAI-compatible preferred field is "image[]" (legacy: "image").
  form.append(
    "image[]",
    new Blob([Buffer.from(options.image.data, "base64")], { type: options.image.mimeType }),
    "input.png",
  );
  const budgetMs = timeoutMs ?? 180_000;
  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(budgetMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchOrThrow(
      `${normalized}/v1/images/edits`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: combinedSignal,
      },
      (message, cause) => new ImageError(message, { cause }),
      "Failed to reach gateway images edits endpoint",
    );
  } catch (err) {
    if (isClientTimeoutError(err)) {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const budgetSeconds = Math.round(budgetMs / 1000);
      throw new ImageError(
        `Image edit abandoned by the client after ${elapsedSeconds}s of a ${budgetSeconds}s budget: the render may still be running in the backend and keeps the GPU busy.`,
      );
    }
    throw err;
  }
  if (response.status === 401 || response.status === 403) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }
  if (!response.ok) {
    throw new ImageError(
      `Image edit failed: ${response.status}: ${response.statusText} (spend, if any, shows in /usage)`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new ImageError(
      `Images edits response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const data =
    body !== null && typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).data)
      ? ((body as Record<string, unknown>).data as unknown[])
      : null;
  const images: string[] = [];
  if (data) {
    for (const entry of data) {
      if (typeof entry === "object" && entry !== null) {
        const b64 = (entry as Record<string, unknown>).b64_json;
        if (typeof b64 === "string" && b64.length > 0) images.push(b64);
      }
    }
  }
  if (images.length === 0) {
    throw new ImageError("Images edits response had no b64_json payloads");
  }
  return { images, model: options.model };
}

interface ImageGenerationResultShape {
  images: string[];
  model: string;
  size?: string;
}

export function toolDescription(models: string[]): string {
  const options = models.length > 0
    ? models.map((m) => `- ${m}`).join("\n")
    : "- (discover at call time — the gateway catalog defines the options)";
  return [
    "Generate an image through the ACTSIS gateway (stable-diffusion.cpp models",
    "on the Strix Halo workstation). Use this tool when the user asks for an",
    "image in natural language, or to edit an existing image.",
    "EVERY model here accepts BOTH use cases unless its own description below",
    "says otherwise: text-to-image generation FROM SCRATCH (no image param)",
    "AND instruction-based editing (with the image param). A model id with",
    "'Edit' in the name does NOT restrict it to editing.",
    "Known capabilities:",
    "- sdxl-pixel-art: text-to-image AND image inputs; style is BAKED IN",
    "  (always pixel-art, the prompt's style keywords don't change it) — use",
    "  it when the user wants pixel-art, or a fast/cheap render.",
    "- qwen-image-edit: text-to-image (free style — realistic, 3D, flat,",
    "  anything the prompt asks) AND instruction editing of a reference image;",
    "  slower and heavier (512 ~1 min, 1024 ~5.5 min per image).",
    "Style requests like 3D/realistic MUST go to a prompt-driven model",
    "(qwen-image-edit), never to sdxl-pixel-art.",
    "Discovered image models (ask the user which one they want when it is not",
    "obvious; edits need a reference image):",
    options,
    "Selection rules: an explicit `model` param wins; with an `image` input",
    "default to the editing-capable model (qwen-image-edit); otherwise the",
    "gateway default (sdxl-pixel-art). Report the rendered result and mention",
    "that large sizes are slower.",
  ].join("\n");
}

export interface GenerateImageToolDeps {
  providerId?: string;
  getProviderId?: () => string;
  authPath: string;
  requestTimeoutMs?: number;
  sendMessage: (message: unknown) => void;
  imageSaveDir?: string;
  store?: ImageSessionStore;
  /** Shared detached-image job registry (T1/T2). */
  registry: ImageJobRegistry;
  /** Override heartbeat cadence for tests (S3). */
  heartbeatCadenceMs?: number;
  /** Discovered image model ids for the tool description (S2 — never
   *  hardcoded; empty list falls back to a discover-at-call-time text). */
  descriptionModels?: string[];
  /** Resolved gateway URL, same source as /image (/status config). */
  resolveStatusConfig: (
    providerId: string,
    authPath: string,
  ) => Promise<{ baseUrl: string } | null>;
  getUsableApiKey: (providerId: string, ctx: unknown) => Promise<string | null>;
}

const toolParams = () =>
  Type.Object({
    prompt: Type.String({ description: "Image description or edit instruction" }),
    size: Type.Optional(Type.String({ description: "512 (default), 768 or 1024 — rendered as WIDTHxHEIGHT" })),
    model: Type.Optional(Type.String({ description: "Image model id from this description's list (e.g. sdxl-pixel-art, qwen-image-edit)" })),
    image: Type.Optional(Type.String({ description: "Optional image input for edits: 'last' for the last generated image in this session, or a file path (png/jpg/webp)" })),
    background: Type.Optional(Type.Boolean({ description: "Run the render in the background and return a job id immediately" })),
  });

interface DetachedRenderCtx {
  ui?: {
    setStatus?(key: string, text: string | undefined): void;
    notify?(message: string, level?: string): void;
  };
}

interface DetachedRenderOptions {
  sendMessage: (message: {
    customType: string;
    content: Array<TextContent | ImageContent> | string;
    display: boolean;
    details?: { filePath?: string };
  }) => void;
  notify?: (message: string, level?: "error" | "info" | "warning") => void;
  setStatus?: (key: string, text: string | undefined) => void;
  store?: ImageSessionStore;
  imageSaveDir?: string;
  registry: ImageJobRegistry;
}

/** Run an image job detached from the active turn (T4/T6). */
export async function runDetachedImageJob(
  job: ImageJob,
  options: DetachedRenderOptions,
  prompt: string,
  fetcher: () => Promise<{ images: string[]; model: string; size?: string }>,
): Promise<void> {
  const { registry, sendMessage, notify, setStatus, store, imageSaveDir } = options;

  function refreshStatus(): void {
    const running = registry.running();
    if (running.length === 0) {
      setStatus?.(IMAGE_JOB_STATUS_KEY, undefined);
      return;
    }
    const lines = running.map((j) => {
      const elapsed = Math.floor((Date.now() - j.startedAt) / 1000);
      return `${j.id}: ${j.model} ${j.size} (${elapsed}s)`;
    });
    setStatus?.(IMAGE_JOB_STATUS_KEY, lines.join(" · "));
  }

  const statusInterval = setInterval(refreshStatus, 1_000);

  try {
    registry.start(job.id);
    refreshStatus();
    const result = await fetcher();
    const data = result.images[0];
    let filePath: string | undefined;
    try {
      filePath = await saveImageB64(data, imageSaveDir ?? (await import("node:os")).tmpdir());
    } catch {
      // best-effort copy (R4-001); the image still renders
    }
    store?.set({ data, mimeType: "image/png", filePath });
    sendMessage({
      customType: IMAGE_CUSTOM_TYPE,
      content: [
        { type: "text", text: `${job.id}: generate_image "${prompt}" — ${result.model} ${result.size}` },
        { type: "image", data, mimeType: "image/png" },
      ],
      display: true,
      details: { filePath },
    });
    registry.settle(job.id, "done");
  } catch (err) {
    const current = registry.get(job.id);
    if (current?.status === "cancelled") {
      // Cancellation was already reported by /cancel-image; just release the slot.
      registry.remove(job.id);
      refreshStatus();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendMessage({
      customType: IMAGE_CUSTOM_TYPE,
      content: [{ type: "text", text: `${job.id} failed: ${message}` }],
      display: true,
    });
    notify?.(`${job.id} failed: ${message}`, "error");
    registry.settle(job.id, "failed");
    registry.remove(job.id);
  } finally {
    clearInterval(statusInterval);
    refreshStatus();
  }
}

/**
 * Built tool registration object for pi.registerTool (T3). execute() returns
 * the tool result (text summary + metadata); the rendered image travels as
 * the displayed custom message via deps.sendMessage, like /image does.
 */
export function buildGenerateImageTool(deps: GenerateImageToolDeps) {
  const store = deps.store ?? new ImageSessionStore();
  const registry = deps.registry;
  return {
    name: IMAGE_TOOL_NAME,
    label: "Generate image (ACTSIS gateway)",
    description: toolDescription(deps.descriptionModels ?? []),
    parameters: toolParams(),
    async execute(
      _toolCallId: string,
      params: Static<ReturnType<typeof toolParams>>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: unknown,
    ): Promise<{ content: Array<TextContent>; details: Record<string, unknown> }> {
      const size = `${parseInt(params.size ?? "512", 10) || 512}x${parseInt(params.size ?? "512", 10) || 512}`;
      const providerId = deps.getProviderId?.() ?? deps.providerId ?? "actsis-litellm";
      const cfg = await deps.resolveStatusConfig(providerId, deps.authPath);
      if (!cfg) throw new CommandError("Gateway not configured. Run /login first.");
      const apiKey = await deps.getUsableApiKey(providerId, _ctx);
      if (!apiKey) throw new CommandError("No usable credential. Run /login first.");

      const ctx = _ctx as DetachedRenderCtx;

      if (params.image === "last" || params.image === "última" || params.image === "last_image") {
        const pending = registry.running()[0];
        if (pending) {
          throw new CommandError(
            `An image render is still in flight as ${pending.id}. Wait for it to finish before referencing image="last".`,
          );
        }
      }

      const imageInput = params.image
        ? await resolveImageInput(params.image, store)
        : null;
      const discoveredModels: string[] = await discoverImageModels(
        cfg.baseUrl,
        apiKey,
      )
        .then((options) => options.map((o) => o.id))
        .catch(() => []);
      const { model } = resolveImageModel(
        params.model,
        imageInput !== null,
        discoveredModels,
      );
      if (!model) throw new CommandError("No suitable image model found in the gateway catalog.");

      onUpdate?.({
        content: [{
          type: "text",
          text: `Generating ${size} image with ${model}${imageInput ? " (edit)" : ""} — this takes a while...`,
        }],
        details: {},
      });

      const timeout = imageToolTimeoutMs(model, size);

      if (params.background) {
        const job = registry.create(model, size);
        const fetcher = imageInput
          ? () => fetchImageEdit(cfg.baseUrl, apiKey, { model, prompt: params.prompt, image: imageInput, size }, timeout, job.controller.signal)
          : () => fetchImageGeneration(cfg.baseUrl, apiKey, { prompt: params.prompt, model, size }, timeout, job.controller.signal);

        runDetachedImageJob(
          job,
          {
            sendMessage: deps.sendMessage as DetachedRenderOptions["sendMessage"],
            notify: ctx.ui?.notify as DetachedRenderOptions["notify"],
            setStatus: ctx.ui?.setStatus,
            store,
            imageSaveDir: deps.imageSaveDir,
            registry,
          },
          params.prompt,
          fetcher,
        ).catch(() => {
          // Errors are delivered through sendMessage/ui.notify inside the runner.
        });

        return {
          content: [{
            type: "text",
            text: `Image render queued as ${job.id} (${model} ${size}). The image will appear in the conversation by itself when it is ready. Do not call generate_image again for the same prompt.`,
          }],
          details: { jobId: job.id, model, size, background: true },
        };
      }

      const startedAt = Date.now();
      const result = await withHeartbeat(
        imageInput
          ? fetchImageEdit(cfg.baseUrl, apiKey, { model, prompt: params.prompt, image: imageInput, size }, timeout, signal)
          : fetchImageGeneration(cfg.baseUrl, apiKey, { prompt: params.prompt, model, size }, timeout, signal),
        onUpdate,
        deps.heartbeatCadenceMs ?? IMAGE_HEARTBEAT_CADENCE_MS,
        startedAt,
      );

      const data = result.images[0];
      let filePath: string | undefined;
      try {
        filePath = await saveImageB64(data, deps.imageSaveDir ?? (await import("node:os")).tmpdir());
      } catch {
        // best-effort copy (R4-001); the image still renders
      }
      store.set({ data, mimeType: "image/png", filePath });
      deps.sendMessage({
        customType: IMAGE_CUSTOM_TYPE,
        content: [
          { type: "text", text: `generate_image "${params.prompt}" — ${model} ${size}` },
          { type: "image", data, mimeType: "image/png" },
        ] satisfies Array<TextContent | ImageContent>,
        display: true,
        details: { filePath },
      });

      return {
        content: [{
          type: "text",
          text: `Image ready: ${model} ${size}` + (filePath ? ` (saved: ${filePath})` : "")
            + `. The image is rendered in the conversation. Reference it as image="last" for edits.`,
        }],
        details: { model, size, filePath },
      };
    },
  };
}