import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLimitError,
  formatBudgetWarning,
  formatThrottleWarning,
  budgetUsagePercent,
  classify429,
  normalizeLimitError,
} from "../extensions/lib/limit-errors.ts";

const BUDGET_EXCEEDED_MESSAGE =
  '429: {"message":"Budget has been exceeded! Key=TESTUSER (sk-...Y3mA) Current cost: 128.91354257719996, Max budget: 100.0","type":"budget_exceeded","param":null,"code":"429"}';

const THROTTLING_ERROR_MESSAGE =
  '429: {"message":"Rate limit exceeded for api_key: f115... Limit type: tokens. Current limit: 100000, Remaining: 100000. Limit resets at: 2026-09-22 19:15:54 UTC","type":"throttling_error","param":null,"code":"429"}';

describe("limit-errors", () => {
  describe("parseLimitError", () => {
    it("parses a budget_exceeded error", () => {
      const info = parseLimitError(BUDGET_EXCEEDED_MESSAGE);
      assert.ok(info);
      assert.equal(info!.kind, "budget_exceeded");
      assert.equal(info!.currentSpend, 128.91354257719996);
      assert.equal(info!.maxBudget, 100);
    });

    it("parses a throttling_error error", () => {
      const info = parseLimitError(THROTTLING_ERROR_MESSAGE);
      assert.ok(info);
      assert.equal(info!.kind, "throttling_error");
      assert.equal(info!.limitType, "tokens");
      assert.equal(
        info!.resetsAt,
        Date.parse("2026-09-22 19:15:54 UTC"),
      );
    });

    it("returns rate_limit_other for malformed JSON that still looks like a 429", () => {
      const info = parseLimitError('429: {"broken');
      assert.ok(info);
      assert.equal(info!.kind, "rate_limit_other");
    });

    it("returns null for non-429 text", () => {
      assert.equal(parseLimitError("Something went wrong"), null);
    });

    it("handles text before the JSON payload", () => {
      const info = parseLimitError(
        `Upstream error: ${BUDGET_EXCEEDED_MESSAGE}`,
      );
      assert.ok(info);
      assert.equal(info!.kind, "budget_exceeded");
      assert.equal(info!.currentSpend, 128.91354257719996);
    });
  });

  describe("formatBudgetWarning", () => {
    it("formats the warning with spend and max budget", () => {
      const warning = formatBudgetWarning({
        kind: "budget_exceeded",
        currentSpend: 128.91354257719996,
        maxBudget: 100,
        raw: "",
      });
      assert.ok(warning.includes("Budget exceeded: $128.91 of $100.00 used"));
      assert.ok(warning.includes("top up the key budget"));
    });
  });

  describe("formatThrottleWarning", () => {
    it("formats the warning with limit type and reset time", () => {
      const now = Date.now();
      const resetsAt = now + 35 * 60 * 1000;
      const warning = formatThrottleWarning({
        kind: "throttling_error",
        limitType: "tokens",
        resetsAt,
        raw: "",
      });
      assert.ok(warning.includes("Rate limit reached (tokens)"));
      assert.ok(warning.includes("Resets at"));
      assert.ok(warning.includes("~35 min"));
      assert.ok(warning.includes("pi will retry automatically"));
    });

    it("omits reset details when resetsAt is missing", () => {
      const warning = formatThrottleWarning({
        kind: "throttling_error",
        limitType: "tokens",
        raw: "",
      });
      assert.ok(warning.includes("Rate limit reached (tokens)"));
      assert.ok(warning.includes("pi will retry automatically"));
    });
  });

  describe("budgetUsagePercent", () => {
    it("returns 90 when spend is 90% of max", () => {
      assert.equal(budgetUsagePercent(90, 100), 90);
    });

    it("returns 0 when maxBudget is 0", () => {
      assert.equal(budgetUsagePercent(50, 0), 0);
    });

    it("returns 0 when maxBudget is negative", () => {
      assert.equal(budgetUsagePercent(50, -10), 0);
    });

    it("handles null values", () => {
      assert.equal(budgetUsagePercent(null, 100), 0);
      assert.equal(budgetUsagePercent(50, null), 0);
    });
  });

  describe("classify429", () => {
    it("classifies budget_exceeded", () => {
      assert.equal(classify429(BUDGET_EXCEEDED_MESSAGE), "budget_exceeded");
    });

    it("classifies throttling_error", () => {
      assert.equal(classify429(THROTTLING_ERROR_MESSAGE), "throttling_error");
    });

    it("returns none for non-429 text", () => {
      assert.equal(classify429("some other error"), "none");
    });
  });

  describe("normalizeLimitError", () => {
    const providerId = "actsis-litellm";

    it("rewrites a budget_exceeded error without a rate-limit phrase", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: BUDGET_EXCEEDED_MESSAGE,
        provider: providerId,
      } as const;
      const result = normalizeLimitError(providerId, message);
      assert.ok(result);
      assert.equal(result!.role, "assistant");
      assert.ok(result!.errorMessage?.includes("Budget exceeded:"));
      assert.ok(!result!.errorMessage?.toLowerCase().includes("rate limit"));
      assert.ok(result!.errorMessage?.startsWith("[litellm]"));
    });

    it("rewrites a throttling_error error while preserving the rate-limit prefix", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: THROTTLING_ERROR_MESSAGE,
        provider: providerId,
      } as const;
      const result = normalizeLimitError(providerId, message);
      assert.ok(result);
      assert.ok(
        result!.errorMessage?.includes("Rate limit exceeded for api_key"),
      );
      assert.ok(result!.errorMessage?.includes("pi will retry automatically"));
      assert.ok(result!.errorMessage?.startsWith("[litellm]"));
    });

    it("returns null when the provider does not match", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: BUDGET_EXCEEDED_MESSAGE,
        provider: "other-provider",
      } as const;
      assert.equal(normalizeLimitError(providerId, message), null);
    });

    it("falls back to activeModelProvider when message.provider is missing", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: THROTTLING_ERROR_MESSAGE,
        provider: undefined,
      } as const;
      const result = normalizeLimitError(providerId, message, providerId);
      assert.ok(result);
      assert.ok(result!.errorMessage?.includes("pi will retry automatically"));
    });

    it("is idempotent via [litellm] marker", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "[litellm] Budget exceeded: $10 of $10 used.",
        provider: providerId,
      } as const;
      assert.equal(normalizeLimitError(providerId, message), null);
    });

    it("returns null for rate_limit_other", () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: '429: {"broken',
        provider: providerId,
      } as const;
      assert.equal(normalizeLimitError(providerId, message), null);
    });

    it("returns null for non-assistant role", () => {
      const message = {
        role: "user",
        stopReason: "error",
        errorMessage: BUDGET_EXCEEDED_MESSAGE,
        provider: providerId,
      } as const;
      assert.equal(normalizeLimitError(providerId, message), null);
    });

    it("returns null when stopReason is not error", () => {
      const message = {
        role: "assistant",
        stopReason: "stop",
        errorMessage: BUDGET_EXCEEDED_MESSAGE,
        provider: providerId,
      } as const;
      assert.equal(normalizeLimitError(providerId, message), null);
    });
  });
});
