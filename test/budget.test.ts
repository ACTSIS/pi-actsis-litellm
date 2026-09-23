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
    it("parses the nested { key, info } shape returned by LiteLLM >= 1.100.1", async () => {
      mockFetch(async () =>
        new Response(
          JSON.stringify({
            key: "<hashed-token>",
            info: {
              spend: 3.99,
              max_budget: 100.0,
              tpm_limit: 2000000,
              rpm_limit: 600,
              budget_reset_at: "2026-10-01T00:00:00+00:00",
              key_alias: "TESTUSER",
            },
          }),
          { status: 200 },
        ),
      );

      const info = await fetchBudgetInfo(
        "https://gateway.example.com",
        "sk-test",
        30_000,
      );

      assert.equal(info.spend, 3.99);
      assert.equal(info.maxBudget, 100);
      assert.equal(info.tpmLimit, 2000000);
      assert.equal(info.rpmLimit, 600);
      assert.equal(info.budgetResetAt, Date.parse("2026-10-01T00:00:00+00:00"));
      assert.equal(info.keyAlias, "TESTUSER");
    });

    it("keeps parsing the legacy flat /key/info shape", async () => {
      mockFetch(async () =>
        new Response(JSON.stringify(VALID_BODY), { status: 200 }),
      );

      const info = await fetchBudgetInfo(
        "https://gateway.example.com",
        "sk-test",
        30_000,
      );

      assert.equal(info.spend, 128.91);
      assert.equal(info.maxBudget, 100);
    });

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

    it("reports route-permission 403 without telling the user to re-login", async () => {
      mockFetch(async () =>
        new Response(
          JSON.stringify({
            detail:
              "Virtual key is not allowed to call this route. Key team does not have group route permissions: /key/info",
          }),
          { status: 403 },
        ),
      );

      await assert.rejects(
        fetchBudgetInfo("https://gateway.example.com", "key", 30_000),
        (err) => {
          assert.ok(err instanceof AuthError);
          const message = (err as AuthError).message;
          assert.ok(message.includes("info_routes"), message);
          assert.ok(!message.includes("Run /login again"), message);
          return true;
        },
      );
    });

    it("falls back to /user/info when /key/info rejects an SSO credential", async () => {
      const urls: string[] = [];
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        if (url.endsWith("/key/info")) {
          return new Response(
            JSON.stringify({
              error: { message: "Key not found in database" },
            }),
            { status: 404 },
          );
        }
        return new Response(
          JSON.stringify({
            user_info: {
              user_alias: "RPINTO",
              spend: 35.63,
              max_budget: null,
            },
          }),
          { status: 200 },
        );
      });

      const info = await fetchBudgetInfo(
        "https://gateway.example.com",
        "sso-token",
        30_000,
      );

      assert.deepEqual(
        urls.map((url) => url.replace("https://gateway.example.com", "")),
        ["/key/info", "/user/info"],
      );
      assert.equal(info.spend, 35.63);
      assert.equal(info.maxBudget, null);
      assert.equal(info.keyAlias, "RPINTO");
      assert.equal(info.tpmLimit, null);
      assert.equal(info.rpmLimit, null);
      assert.equal(info.budgetResetAt, null);
    });

    it("does not fall back to /user/info on credential rejection", async () => {
      const urls: string[] = [];
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        return new Response("Unauthorized", { status: 401 });
      });

      await assert.rejects(
        fetchBudgetInfo("https://gateway.example.com", "key", 30_000),
        (err) => err instanceof AuthError,
      );

      assert.equal(urls.length, 1);
      assert.ok(urls[0].endsWith("/key/info"));
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
