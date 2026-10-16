import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  fetchBudgetInfo,
  formatBudgetLine,
  formatBudgetStatusText,
  type BudgetInfo,
} from "../extensions/lib/budget.ts";
import {
  GAUGE_ANSI_RESET_DIM,
  GAUGE_ANSI_RESET_FG,
  gaugeColorAnsi,
} from "../extensions/lib/gauge-color.ts";
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

describe("gauge-color thresholds", () => {
  it("selects green <=50, yellow <=75, orange <=90, red >90", () => {
    assert.equal(gaugeColorAnsi(0), "\x1b[38;2;34;197;94m");
    assert.equal(gaugeColorAnsi(50), "\x1b[38;2;34;197;94m");
    assert.equal(gaugeColorAnsi(51), "\x1b[38;2;234;179;8m");
    assert.equal(gaugeColorAnsi(75), "\x1b[38;2;234;179;8m");
    assert.equal(gaugeColorAnsi(76), "\x1b[38;2;249;115;22m");
    assert.equal(gaugeColorAnsi(90), "\x1b[38;2;249;115;22m");
    assert.equal(gaugeColorAnsi(91), "\x1b[38;2;239;68;68m");
    assert.equal(gaugeColorAnsi(100), "\x1b[38;2;239;68;68m");
  });
});

describe("formatBudgetLine color option", () => {
  it("colors the capped run at the used% threshold", () => {
    const line = formatBudgetLine(
      { spend: 95, maxBudget: 100, budgetResetAt: null, tpmLimit: null, rpmLimit: null, keyAlias: null },
      { color: true },
    );
    assert.equal(line, `\x1b[38;2;239;68;68m$95.00 / $100.00 used (95%)${GAUGE_ANSI_RESET_DIM}`);
  });

  it("keeps the reset suffix outside the colored run", () => {
    const line = formatBudgetLine(
      { spend: 50, maxBudget: 100, budgetResetAt: Date.parse("2026-09-23T00:00:00Z"), tpmLimit: null, rpmLimit: null, keyAlias: null },
      { color: true },
    );
    assert.ok(line?.startsWith(`${gaugeColorAnsi(50)}$50.00 / $100.00 used (50%)${GAUGE_ANSI_RESET_DIM} | resets `));
  });

  it("stays neutral without a cap even with color requested", () => {
    const line = formatBudgetLine(
      { spend: 90, maxBudget: null, budgetResetAt: null, tpmLimit: null, rpmLimit: null, keyAlias: null },
      { color: true },
    );
    assert.equal(line, "$90.00 used (no budget cap)");
  });
});

describe("formatBudgetStatusText (budget widget)", () => {
  it("mirrors the previous plain widget text without color", () => {
    const text = formatBudgetStatusText(
      { spend: 2.5, maxBudget: 10, budgetResetAt: null, tpmLimit: null, rpmLimit: null, keyAlias: null },
    );
    assert.equal(text, `Budget \u25b0\u25b0\u25b1\u25b1\u25b1\u25b1\u25b1\u25b1 25% \u00b7 $2.50/$10.00`);
  });

  it("colors the gauge+percent run by threshold (green)", () => {
    const text = formatBudgetStatusText(
      { spend: 2.5, maxBudget: 10, budgetResetAt: null, tpmLimit: null, rpmLimit: null, keyAlias: null },
      { color: true },
    );
    assert.equal(
      text,
      `Budget ${gaugeColorAnsi(25)}\u25b0\u25b0\u25b1\u25b1\u25b1\u25b1\u25b1\u25b1 25%${GAUGE_ANSI_RESET_FG} \u00b7 $2.50/$10.00`,
    );
  });

  it("crosses thresholds as used% rises", () => {
    const status = (spend: number, maxBudget: number) =>
      formatBudgetStatusText(
        { spend, maxBudget, budgetResetAt: null, tpmLimit: null, rpmLimit: null, keyAlias: null },
        { color: true },
      );
    assert.ok(status(5, 10)!.includes(gaugeColorAnsi(50)));
    assert.ok(status(5.1, 10)!.includes(gaugeColorAnsi(51)));
    assert.ok(status(7.5, 10)!.includes(gaugeColorAnsi(75)));
    assert.ok(status(7.6, 10)!.includes(gaugeColorAnsi(76)));
    assert.ok(status(9, 10)!.includes(gaugeColorAnsi(90)));
    assert.ok(status(9.1, 10)!.includes(gaugeColorAnsi(91)));
  });

  it("stays neutral with color even without a cap", () => {
    const text = formatBudgetStatusText(
      { spend: 3, maxBudget: null, budgetResetAt: null, tpmLimit: null, rpmLimit: null, keyAlias: null },
      { color: true },
    );
    assert.equal(text, "Budget $3.00 used (no cap)");
    assert.ok(!text.includes("\x1b["));
  });

  it("returns undefined when spend is null", () => {
    const text = formatBudgetStatusText(
      { spend: null, maxBudget: 10, budgetResetAt: null, tpmLimit: null, rpmLimit: null, keyAlias: null },
      { color: true },
    );
    assert.equal(text, undefined);
  });
});
