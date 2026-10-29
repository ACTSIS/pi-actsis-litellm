import { fetchOrThrow } from "./client.ts";
import { AuthError, CommandError, ImageError } from "./errors.ts";

export const IMAGE_DEFAULT_MODEL = "sdxl-pixel-art";
export const IMAGE_OUTPUT_FORMAT = "png";

/** customType for the displayed session image message (issue #47 S2). */
export const IMAGE_CUSTOM_TYPE = "actsis-litellm:image";

/** Allowed --size values (issue #47 S3); rendered as WIDTHxHEIGHT. */
const IMAGE_SIZE_MAP = new Map<string, string>([
  ["512", "512x512"],
  ["768", "768x768"],
  ["1024", "1024x1024"],
]);

/**
 * Generation is synchronous and slow (512² ≈ 14 s, 1024² ≈ 48 s measured);
 * the chat request timeout is far too small, so guard with at least 180 s
 * (issue #47 S4).
 */
export function imageTimeoutMs(requestTimeoutMs?: number): number {
  const MIN_IMAGE_TIMEOUT_MS = 180_000;
  return Math.max(requestTimeoutMs ?? 0, MIN_IMAGE_TIMEOUT_MS);
}

export interface ParsedImageArgs {
  prompt: string;
  size: string;
  model: string;
}

/** Parse `/image` args: an optional `--size 512|768|1024` flag and the prompt. */
export function parseImageArgs(args: string): ParsedImageArgs {
  const words = args.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || words.every((w) => w === "--")) {
    throw new CommandError(
      "Usage: /image <prompt> [--size 512|768|1024]",
    );
  }

  let size = "512";
  const promptWords: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--size") {
      const value = words[i + 1] ?? "";
      if (!IMAGE_SIZE_MAP.has(value)) {
        throw new CommandError(
          `Unsupported size "${value}" (allowed: 512, 768, 1024)`,
        );
      }
      size = value;
      i++;
      continue;
    }
    promptWords.push(words[i]);
  }

  const prompt = promptWords.join(" ").trim();
  if (!prompt) {
    throw new CommandError(
      "Usage: /image <prompt> [--size 512|768|1024]",
    );
  }
  return { prompt, size: IMAGE_SIZE_MAP.get(size) ?? "512x512", model: IMAGE_DEFAULT_MODEL };
}

export interface ImageGenerationOptions {
  prompt: string;
  model: string;
  size: string;
}

export interface ImageGenerationResult {
  images: string[];
  model: string;
  size: string;
}

export async function fetchImageGeneration(
  baseUrl: string,
  apiKey: string,
  options: ImageGenerationOptions,
  timeoutMs?: number,
): Promise<ImageGenerationResult> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const response = await fetchOrThrow(
    `${normalized}/v1/images/generations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        n: 1,
        size: options.size,
        output_format: IMAGE_OUTPUT_FORMAT,
      }),
      signal: AbortSignal.timeout(imageTimeoutMs(timeoutMs)),
    },
    (message, cause) => new ImageError(message, { cause }),
    "Failed to reach gateway images endpoint",
  );

  if (response.status === 401 || response.status === 403) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }

  if (!response.ok) {
    throw new ImageError(
      `Image generation failed: ${response.status}: ${response.statusText}` +
        ` (spend, if any, shows in /usage)`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new ImageError(
      `Images response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const data =
    body !== null &&
    typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).data)
      ? ((body as Record<string, unknown>).data as unknown[])
      : null;
  if (!data || data.length === 0) {
    throw new ImageError(
      "Images response contained no data[] entries",
    );
  }

  const images: string[] = [];
  for (const entry of data) {
    if (typeof entry === "object" && entry !== null) {
      const b64 = (entry as Record<string, unknown>).b64_json;
      if (typeof b64 === "string" && b64.length > 0) images.push(b64);
    }
  }
  if (images.length === 0) {
    throw new ImageError(
      "Images response had no b64_json payloads (model may have failed after billing)",
    );
  }

  return { images, model: options.model, size: options.size };
}

/** Fallback when the session cannot render images: decode to a png file. */
export async function saveImageB64(data: string, dir: string): Promise<string> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const fileName = `actsis-image-${Date.now()}.png`;
  const filePath = `${dir}/${fileName}`;
  await writeFile(filePath, Buffer.from(data, "base64"));
  return filePath;
}