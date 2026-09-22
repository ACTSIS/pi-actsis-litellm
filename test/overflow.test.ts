import assert from "node:assert";
import { describe, it } from "node:test";
import {
  isOverflowErrorMessage,
  normalizeOverflowError,
} from "../extensions/lib/overflow.ts";

describe("overflow", () => {
  describe("isOverflowErrorMessage", () => {
    it("matches 'maximum context length'", () => {
      assert.ok(
        isOverflowErrorMessage(
          "This model's maximum context length is 8192 tokens",
        ),
      );
    });

    it("matches 'input is too long'", () => {
      assert.ok(
        isOverflowErrorMessage(
          "Input is too long for requested model gpt-x",
        ),
      );
    });

    it("matches 'prompt is too long'", () => {
      assert.ok(isOverflowErrorMessage("Prompt is too long"));
    });

    it("matches 'context window'", () => {
      assert.ok(
        isOverflowErrorMessage("exceeds the model's context window"),
      );
    });

    it("matches an already-prefixed message", () => {
      assert.ok(
        isOverflowErrorMessage("context_length_exceeded: something"),
      );
    });

    it("is case-insensitive", () => {
      assert.ok(isOverflowErrorMessage("MAXIMUM CONTEXT LENGTH EXCEEDED"));
    });

    it("rejects undefined", () => {
      assert.strictEqual(isOverflowErrorMessage(undefined), false);
    });

    it("rejects empty string", () => {
      assert.strictEqual(isOverflowErrorMessage(""), false);
    });

    it("rejects rate-limit phrases", () => {
      assert.strictEqual(
        isOverflowErrorMessage("Rate limit exceeded"),
        false,
      );
      assert.strictEqual(
        isOverflowErrorMessage("Too many requests"),
        false,
      );
      assert.strictEqual(isOverflowErrorMessage("429 throttle"), false);
    });
  });

  describe("normalizeOverflowError", () => {
    const providerId = "actsis-litellm";

    it("rewrites a matching assistant error", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "This model's maximum context length is 8192 tokens",
        provider: providerId,
      } as const;
      const result = normalizeOverflowError(providerId, message);
      assert.deepStrictEqual(result, {
        ...message,
        errorMessage:
          "context_length_exceeded: This model's maximum context length is 8192 tokens",
      });
    });

    it("is idempotent (already prefixed -> null)", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "context_length_exceeded: already normalized",
        provider: providerId,
      } as const;
      assert.strictEqual(normalizeOverflowError(providerId, message), null);
    });

    it("returns null for non-assistant role", () => {
      const message = {
        role: "user",
        stopReason: "error",
        errorMessage: "maximum context length exceeded",
        provider: providerId,
      } as const;
      assert.strictEqual(normalizeOverflowError(providerId, message), null);
    });

    it("returns null when stopReason is not error", () => {
      const message = {
        role: "assistant",
        stopReason: "stop",
        errorMessage: "maximum context length exceeded",
        provider: providerId,
      } as const;
      assert.strictEqual(normalizeOverflowError(providerId, message), null);
    });

    it("returns null when provider does not match", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "maximum context length exceeded",
        provider: "some-other-provider",
      } as const;
      assert.strictEqual(normalizeOverflowError(providerId, message), null);
    });

    it("returns null when providerId is undefined", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "maximum context length exceeded",
        provider: undefined,
      } as const;
      assert.strictEqual(normalizeOverflowError(undefined, message), null);
    });

    it("falls back to activeModelProvider when message.provider differs", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Prompt is too long",
        provider: undefined,
      } as const;
      const result = normalizeOverflowError(
        providerId,
        message,
        providerId,
      );
      assert.deepStrictEqual(result, {
        ...message,
        errorMessage: "context_length_exceeded: Prompt is too long",
      });
    });

    it("does not rewrite when neither provider matches", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Prompt is too long",
        provider: "openai",
      } as const;
      assert.strictEqual(
        normalizeOverflowError(providerId, message, "openai"),
        null,
      );
    });

    it("does not rewrite rate-limit errors", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Too many requests",
        provider: providerId,
      } as const;
      assert.strictEqual(normalizeOverflowError(providerId, message), null);
    });
  });
});
