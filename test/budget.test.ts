import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  fetchBudgetInfo,
  formatBudgetLine,
  type BudgetInfo,
} from "../extensions/lib/budget.ts";
import { AuthError } from "../extensions/lib/errors.ts";

const VALID_BODY = {
  spend: 128.91,
  max_budget: 100,
  budget_reset_at: "2026-09-23T00:00:00Z",
  key_alias: "TESTUSER",
};

describe("budget", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: { url: string; init: RequestInit } | null = null;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(
    impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  ) {
    globalThis.fetch = async (input, init) => {
      lastRequest = {
        url: typeof input === "string" ? input : input.toString(),
        init: init ?? {},
      };
      return impl(input, init);
    };
  }

  describe("fetchBudgetInfo", () => {
    it("parses a typical /key/info body", async () => {
      mockFetch(async () =>
        new Response(JSON.stringify(VALID_BODY), { status: 200 }),
      );

      const info = await fetchBudgetInfo(
        "https://gateway.example.com/",
        "sk-test",
        30_000,
      );

      assert.equal(info.spend, 128.91);
      assert.equal(info.maxBudget, 100);
      assert.equal(info.tpmLimit, null);
      assert.equal(info.rpmLimit, null);
      assert.equal(
        info.budgetResetAt,
        Date.parse("2026-09-23T00:00:00Z"),
      );
      assert.equal(info.keyAlias, "TESTUSER");
      assert.equal(lastRequest?.url, "https://gateway.example.com/key/info");
      assert.equal(
        (lastRequest?.init.headers as Record<string, string>).Authorization,
        "Bearer sk-test",
      );
    });

    it("accepts budget_reset_at as epoch seconds", async () => {
      const epochSeconds = 1_777_862_400;
      mockFetch(async () =>
        new Response(
          JSON.stringify({
            spend: 10,
            max_budget: 50,
            budget_reset_at: epochSeconds,
            key_alias: "test",
          }),
          { status: 200 },
        ),
      );

      const info = await fetchBudgetInfo(
        "https://gateway.example.com",
        "key",
        30_000,
      );
      assert.equal(info.budgetResetAt, epochSeconds * 1000);
    });

    it("throws AuthError on 401", async () => {
      mockFetch(async () =>
        new Response("Unauthorized", { status: 401 }),
      );

      await assert.rejects(
        fetchBudgetInfo("https://gateway.example.com", "key", 30_000),
        (err) => {
          assert.ok(err instanceof AuthError);
          assert.ok((err as AuthError).message.includes("Credential rejected"));
          return true;
        },
      );
    });

    it("throws AuthError on 403", async () => {
      mockFetch(async () =>
        new Response("Forbidden", { status: 403 }),
      );

      await assert.rejects(
        fetchBudgetInfo("https://gateway.example.com", "key", 30_000),
        (err) => err instanceof AuthError,
      );
    });
  });

  describe("formatBudgetLine", () => {
    it("formats a budget with a cap", () => {
      const line = formatBudgetLine({
        spend: 90,
        maxBudget: 100,
        budgetResetAt: null,
        tpmLimit: null,
        rpmLimit: null,
        keyAlias: null,
      });
      assert.equal(line, "$90.00 / $100.00 used (90%)");
    });

    it("formats a budget without a cap", () => {
      const line = formatBudgetLine({
        spend: 90,
        maxBudget: null,
        budgetResetAt: null,
        tpmLimit: null,
        rpmLimit: null,
        keyAlias: null,
      });
      assert.equal(line, "$90.00 used (no budget cap)");
    });

    it("appends a reset time", () => {
      const line = formatBudgetLine({
        spend: 50,
        maxBudget: 100,
        budgetResetAt: Date.parse("2026-09-23T00:00:00Z"),
        tpmLimit: null,
        rpmLimit: null,
        keyAlias: null,
      });
      assert.ok(line?.startsWith("$50.00 / $100.00 used (50%) | resets "));
    });

    it("returns null when spend is null", () => {
      const line = formatBudgetLine({
        spend: null,
        maxBudget: 100,
        budgetResetAt: null,
        tpmLimit: null,
        rpmLimit: null,
        keyAlias: null,
      });
      assert.equal(line, null);
    });
  });
});
