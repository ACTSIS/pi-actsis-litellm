import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  fetchGatewayIdentity,
  fetchTeamAlias,
  formatTeamLine,
  formatUserLine,
  type GatewayIdentity,
  type IdentityState,
} from "../extensions/lib/identity.ts";
import { AuthError, CatalogError } from "../extensions/lib/errors.ts";

const TEAM_ID = "ad59169e-f0c9-45a3-aa73-eec187533bdf";
const USER_ID = "2ed0da75-556d-4c8f-99da-727d7e085fd4";

function identity(overrides: Partial<GatewayIdentity> = {}): GatewayIdentity {
  return {
    userId: null,
    userEmail: null,
    userAlias: null,
    userRole: null,
    teams: [],
    ...overrides,
  };
}

function ok(identityValue: Partial<GatewayIdentity>): IdentityState {
  return { kind: "ok", identity: identity(identityValue) };
}

describe("identity formatUserLine (S1)", () => {
  it("formats email, alias and role", () => {
    assert.equal(
      formatUserLine(ok({
        userEmail: "ricardo.pinto@actsis.com",
        userAlias: "RPINTO",
        userRole: "proxy_admin",
      })),
      "User: ricardo.pinto@actsis.com (RPINTO, proxy_admin)",
    );
  });

  it("formats email and alias without role", () => {
    assert.equal(
      formatUserLine(ok({
        userEmail: "ricardo.pinto@actsis.com",
        userAlias: "RPINTO",
      })),
      "User: ricardo.pinto@actsis.com (RPINTO)",
    );
  });

  it("formats email and role without alias", () => {
    assert.equal(
      formatUserLine(ok({
        userEmail: "ricardo.pinto@actsis.com",
        userRole: "proxy_admin",
      })),
      "User: ricardo.pinto@actsis.com (proxy_admin)",
    );
  });

  it("formats alias and role without email", () => {
    assert.equal(
      formatUserLine(ok({ userAlias: "RPINTO", userRole: "proxy_admin" })),
      "User: RPINTO (proxy_admin)",
    );
  });

  it("formats the user id alone without a parenthetical", () => {
    assert.equal(formatUserLine(ok({ userId: USER_ID })), `User: ${USER_ID}`);
  });

  it("reports unknown when nothing is resolvable", () => {
    assert.equal(formatUserLine(ok({})), "User: unknown");
  });

  it("reports no credential", () => {
    assert.equal(formatUserLine({ kind: "no-credential" }), "User: no credential");
  });

  it("reports unavailable with a single-line reason", () => {
    assert.equal(
      formatUserLine({
        kind: "unavailable",
        reason: "Failed to fetch user info:\nboom  network",
      }),
      "User: unavailable (Failed to fetch user info: boom network)",
    );
  });
});

describe("identity formatTeamLine (S2)", () => {
  it("formats the resolved alias with the id", () => {
    assert.equal(
      formatTeamLine({
        hasCredential: true,
        teamId: TEAM_ID,
        teamAlias: "Acceso-Completo",
      }),
      `Team: Acceso-Completo (${TEAM_ID})`,
    );
  });

  it("formats the id alone when the alias is unavailable", () => {
    assert.equal(
      formatTeamLine({
        hasCredential: true,
        teamId: TEAM_ID,
        teamAlias: null,
      }),
      `Team: ${TEAM_ID} (alias unavailable)`,
    );
  });

  it("reports no team bound when the credential carries no teamId", () => {
    assert.equal(
      formatTeamLine({ hasCredential: true, teamId: null, teamAlias: null }),
      "Team: none (no team bound)",
    );
  });

  it("reports no credential", () => {
    assert.equal(
      formatTeamLine({ hasCredential: false, teamId: null, teamAlias: null }),
      "Team: no credential",
    );
  });
});

describe("identity", () => {
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

  describe("fetchGatewayIdentity (S3)", () => {
    it("reduces /user/info to the S3 allowlist and discards everything else", async () => {
      mockFetch(async () =>
        new Response(
          JSON.stringify({
            user_id: USER_ID,
            spend: 123.45,
            max_budget: 999,
            keys: [{ token: "sk-SECRET-KEY-TOKEN", key_alias: "leak-me" }],
            key_alias: "root-alias",
            user_info: {
              user_id: USER_ID,
              user_email: "ricardo.pinto@actsis.com",
              user_alias: "RPINTO",
              user_role: "proxy_admin",
              teams: ["9fd46572-0000", TEAM_ID, 42, null, ""],
              team_id: null,
              spend: 35.63,
              secret_nested: { token: "sk-SECRET-KEY-TOKEN" },
            },
          }),
          { status: 200 },
        ),
      );

      const result = await fetchGatewayIdentity(
        "https://gateway.example.com",
        "sk-test",
        30_000,
      );

      assert.deepEqual(result, {
        userId: USER_ID,
        userEmail: "ricardo.pinto@actsis.com",
        userAlias: "RPINTO",
        userRole: "proxy_admin",
        teams: ["9fd46572-0000", TEAM_ID],
      });
      // S5: the raw secret token never survives the allowlist reduction.
      assert.ok(!JSON.stringify(result).includes("sk-SECRET-KEY-TOKEN"));
      assert.equal(lastRequest?.url, "https://gateway.example.com/user/info");
      assert.equal(
        (lastRequest?.init.headers as Record<string, string>).Authorization,
        "Bearer sk-test",
      );
    });

    it("falls back to the root user_id when user_info is missing", async () => {
      mockFetch(async () =>
        new Response(
          JSON.stringify({
            user_id: USER_ID,
            keys: [{ token: "sk-SECRET-KEY-TOKEN" }],
          }),
          { status: 200 },
        ),
      );

      const result = await fetchGatewayIdentity(
        "https://gateway.example.com",
        "sk-test",
        30_000,
      );

      assert.deepEqual(result, identity({ userId: USER_ID }));
      assert.ok(!JSON.stringify(result).includes("sk-SECRET-KEY-TOKEN"));
    });

    it("keeps the identity empty when the body is not a JSON object", async () => {
      mockFetch(async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 }));

      const result = await fetchGatewayIdentity(
        "https://gateway.example.com",
        "sk-test",
        30_000,
      );

      assert.deepEqual(result, identity());
    });

    it("throws AuthError on 401 (single-line reason source)", async () => {
      mockFetch(async () => new Response("Unauthorized", { status: 401 }));

      await assert.rejects(
        fetchGatewayIdentity("https://gateway.example.com", "key", 30_000),
        (err) => {
          assert.ok(err instanceof AuthError);
          assert.equal(
            (err as AuthError).message,
            "Credential rejected by gateway. Run /login again.",
          );
          return true;
        },
      );
    });

    it("never surfaces the response body when the payload is not valid JSON (S5)", async () => {
      const secret = "sk-SECRET-MALFORMED";
      mockFetch(async () => new Response(`{"keys":[{"token":"${secret}"`, { status: 200 }));

      await assert.rejects(
        fetchGatewayIdentity("https://gateway.example.com", "key", 30_000),
        (err) => {
          assert.ok(err instanceof CatalogError);
          assert.equal((err as CatalogError).message, "user info response is not valid JSON");
          assert.ok(!(err as CatalogError).message.includes(secret));
          assert.equal((err as { cause?: unknown }).cause, undefined);
          return true;
        },
      );
    });

    it("wraps network failures into a CatalogError with the failure message", async () => {
      mockFetch(async () => {
        throw new Error("boom network");
      });

      await assert.rejects(
        fetchGatewayIdentity("https://gateway.example.com", "key", 30_000),
        (err) => {
          assert.ok(err instanceof CatalogError);
          assert.ok(
            (err as CatalogError).message.includes("boom network"),
            (err as CatalogError).message,
          );
          return true;
        },
      );
    });
  });

  describe("fetchTeamAlias (S4)", () => {
    it("resolves the alias from the /team/list array", async () => {
      const urls: string[] = [];
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        return new Response(
          JSON.stringify([
            { team_id: "9fd46572-0000", team_alias: "" },
            { team_id: TEAM_ID, team_alias: "Acceso-Completo" },
          ]),
          { status: 200 },
        );
      });

      const alias = await fetchTeamAlias(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        TEAM_ID,
      );

      assert.equal(alias, "Acceso-Completo");
      assert.deepEqual(urls.map((u) => u.replace("https://gateway.example.com", "")), [
        "/team/list",
      ]);
      assert.equal(
        (lastRequest?.init.headers as Record<string, string>).Authorization,
        "Bearer sk-test",
      );
    });

    it("falls back to /team/info when /team/list has no usable entry", async () => {
      const urls: string[] = [];
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        if (url.endsWith("/team/list")) {
          return new Response(JSON.stringify({ detail: "not an array" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ team_id: TEAM_ID, team_alias: "Acceso-Completo" }),
          { status: 200 },
        );
      });

      const alias = await fetchTeamAlias(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        TEAM_ID,
      );

      assert.equal(alias, "Acceso-Completo");
      assert.deepEqual(urls.map((u) => u.replace("https://gateway.example.com", "")), [
        "/team/list",
        `/team/info?team_id=${TEAM_ID}`,
      ]);
    });

    it("exposes only the id (null alias) when both routes fail, 403 included", async () => {
      const urls: string[] = [];
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        return new Response("Forbidden", { status: 403 });
      });

      const alias = await fetchTeamAlias(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        TEAM_ID,
      );

      assert.equal(alias, null);
      assert.deepEqual(urls.map((u) => u.replace("https://gateway.example.com", "")), [
        "/team/list",
        `/team/info?team_id=${TEAM_ID}`,
      ]);
    });
  });
});
