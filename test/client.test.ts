import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  validateDiscovery,
  fetchCliAuthDiscovery,
  registerClient,
  exchangeAuthorizationCode,
  refreshGrant,
  revokeToken,
  fetchModels,
  type CliAuthDiscovery,
} from "../extensions/lib/client.ts";
import { AuthError, DiscoveryError } from "../extensions/lib/errors.ts";

const BASE_URL = "https://gateway.example.com";
const ISSUER = "https://gateway.example.com";
const ORIGIN = "https://gateway.example.com";

const VALID_DISCOVERY = {
  contract_version: 1,
  issuer: ISSUER,
  authorization_endpoint: `${BASE_URL}/auth/authorize`,
  token_endpoint: `${BASE_URL}/auth/token`,
  registration_endpoint: `${BASE_URL}/auth/register`,
  revocation_endpoint: `${BASE_URL}/auth/revoke`,
  resource: `${BASE_URL}/v1`,
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
};

let originalFetch: typeof globalThis.fetch;

before(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("validateDiscovery", () => {
  it("accepts a valid discovery document", () => {
    const d = validateDiscovery(VALID_DISCOVERY, BASE_URL);
    assert.equal(d.contractVersion, 1);
    assert.equal(d.issuer, ISSUER);
    assert.equal(d.authorizationEndpoint, `${BASE_URL}/auth/authorize`);
    assert.equal(d.tokenEndpoint, `${BASE_URL}/auth/token`);
    assert.equal(d.registrationEndpoint, `${BASE_URL}/auth/register`);
    assert.equal(d.revocationEndpoint, `${BASE_URL}/auth/revoke`);
    assert.equal(d.resource, `${BASE_URL}/v1`);
    assert.deepEqual(d.codeChallengeMethods, ["S256"]);
    assert.deepEqual(d.grantTypes, ["authorization_code", "refresh_token"]);
  });

  it("rejects non-object discovery", () => {
    assert.throws(() => validateDiscovery("not an object", BASE_URL), DiscoveryError);
  });

  it("rejects contract_version 2", () => {
    assert.throws(
      () => validateDiscovery({ ...VALID_DISCOVERY, contract_version: 2 }, BASE_URL),
      {
        message: /contract version/,
      },
    );
  });

  it("rejects missing S256", () => {
    assert.throws(
      () =>
        validateDiscovery(
          { ...VALID_DISCOVERY, code_challenge_methods_supported: ["plain"] },
          BASE_URL,
        ),
      {
        message: /S256/,
      },
    );
  });

  it("rejects issuer with different origin", () => {
    assert.throws(
      () =>
        validateDiscovery(
          { ...VALID_DISCOVERY, issuer: "https://other.example.com" },
          BASE_URL,
        ),
      {
        message: /issuer origin mismatch/,
      },
    );
  });

  it("rejects cross-origin token endpoint", () => {
    assert.throws(
      () =>
        validateDiscovery(
          { ...VALID_DISCOVERY, token_endpoint: "https://other.example.com/token" },
          BASE_URL,
        ),
      {
        message: /same-origin/,
      },
    );
  });

  it("rejects missing authorization_code grant type", () => {
    assert.throws(
      () =>
        validateDiscovery(
          { ...VALID_DISCOVERY, grant_types_supported: ["refresh_token"] },
          BASE_URL,
        ),
      {
        message: /authorization_code/,
      },
    );
  });

  it("rejects missing refresh_token grant type", () => {
    assert.throws(
      () =>
        validateDiscovery(
          { ...VALID_DISCOVERY, grant_types_supported: ["authorization_code"] },
          BASE_URL,
        ),
      {
        message: /refresh_token/,
      },
    );
  });
});

describe("fetchCliAuthDiscovery", () => {
  it("fetches and validates discovery", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = input.toString();
      assert.ok(url.endsWith("/.well-known/litellm-cli-auth"));
      return new Response(JSON.stringify(VALID_DISCOVERY), { status: 200 });
    };

    const d = await fetchCliAuthDiscovery(BASE_URL, 5000);
    assert.equal(d.contractVersion, 1);
    assert.equal(d.tokenEndpoint, `${BASE_URL}/auth/token`);
  });

  it("throws DiscoveryError on non-200", async () => {
    globalThis.fetch = async () => new Response("Not found", { status: 404 });
    await assert.rejects(() => fetchCliAuthDiscovery(BASE_URL, 5000), DiscoveryError);
  });

  it("throws DiscoveryError on network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("network failure");
    };
    await assert.rejects(() => fetchCliAuthDiscovery(BASE_URL, 5000), {
      message: /network failure/,
    });
  });
});

describe("registerClient", () => {
  const discovery: CliAuthDiscovery = validateDiscovery(VALID_DISCOVERY, BASE_URL);

  it("sends exact registration JSON body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (input, init) => {
      captured = { url: input.toString(), init: init ?? {} };
      return new Response(
        JSON.stringify({ client_id: "client-123", redirect_uris: ["http://127.0.0.1:9876/callback"] }),
        { status: 201 },
      );
    };

    const result = await registerClient(
      discovery,
      "http://127.0.0.1:9876/callback",
      5000,
    );

    assert.equal(captured?.url, `${BASE_URL}/auth/register`);
    assert.equal((captured?.init.headers as Record<string, string>)["Content-Type"], "application/json");
    const body = JSON.parse(captured?.init.body as string);
    assert.equal(body.client_name, "pi-actsis-litellm");
    assert.deepEqual(body.redirect_uris, ["http://127.0.0.1:9876/callback"]);
    assert.equal(body.token_endpoint_auth_method, "none");
    assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
    assert.deepEqual(body.response_types, ["code"]);

    assert.equal(result.clientId, "client-123");
    assert.deepEqual(result.redirectUris, ["http://127.0.0.1:9876/callback"]);
  });

  it("maps non-OK to AuthError with error body", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: "invalid_redirect_uri", error_description: "bad uri" }),
        { status: 400 },
      );

    await assert.rejects(
      () => registerClient(discovery, "http://127.0.0.1:9876/callback", 5000),
      {
        code: "AUTH_ERROR",
        message: /invalid_redirect_uri/,
      },
    );
  });

  it("maps 307 to AuthError naming Location", async () => {
    globalThis.fetch = async () => {
      const res = new Response(null, { status: 307 });
      (res.headers as unknown as { set: (k: string, v: string) => void }).set(
        "Location",
        "https://evil.example.com",
      );
      return res;
    };

    await assert.rejects(
      () => registerClient(discovery, "http://127.0.0.1:9876/callback", 5000),
      {
        code: "AUTH_ERROR",
        message: /evil.example.com/,
      },
    );
  });

  it("throws AuthError if client_id is missing", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 201 });
    await assert.rejects(
      () => registerClient(discovery, "http://127.0.0.1:9876/callback", 5000),
      {
        message: /client_id/,
      },
    );
  });
});

describe("exchangeAuthorizationCode", () => {
  const discovery: CliAuthDiscovery = validateDiscovery(VALID_DISCOVERY, BASE_URL);

  it("posts form body with required fields", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (input, init) => {
      captured = { url: input.toString(), init: init ?? {} };
      return new Response(
        JSON.stringify({
          access_token: "access-123",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-123",
          user_id: "user-1",
          team_id: "team-1",
        }),
        { status: 200 },
      );
    };

    const result = await exchangeAuthorizationCode(
      discovery,
      {
        code: "code-123",
        redirectUri: "http://127.0.0.1:9876/callback",
        clientId: "client-123",
        codeVerifier: "verifier-123",
      },
      5000,
    );

    assert.equal(captured?.url, `${BASE_URL}/auth/token`);
    assert.equal(
      (captured?.init.headers as Record<string, string>)["Content-Type"],
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(captured?.init.body as string);
    assert.equal(params.get("grant_type"), "authorization_code");
    assert.equal(params.get("code"), "code-123");
    assert.equal(params.get("redirect_uri"), "http://127.0.0.1:9876/callback");
    assert.equal(params.get("client_id"), "client-123");
    assert.equal(params.get("code_verifier"), "verifier-123");
    assert.equal(params.get("resource"), `${BASE_URL}/v1`);

    assert.equal(result.accessToken, "access-123");
    assert.equal(result.tokenType, "Bearer");
    assert.equal(result.expiresIn, 3600);
    assert.equal(result.refreshToken, "refresh-123");
    assert.equal(result.userId, "user-1");
    assert.equal(result.teamId, "team-1");
  });

  it("maps 400 invalid_grant to AuthError", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

    await assert.rejects(
      () =>
        exchangeAuthorizationCode(
          discovery,
          {
            code: "code-123",
            redirectUri: "http://127.0.0.1:9876/callback",
            clientId: "client-123",
            codeVerifier: "verifier-123",
          },
          5000,
        ),
      AuthError,
    );
  });

  it("maps 307 to AuthError naming Location", async () => {
    globalThis.fetch = async () => {
      const res = new Response(null, { status: 307 });
      (res.headers as unknown as { set: (k: string, v: string) => void }).set(
        "Location",
        "https://evil.example.com",
      );
      return res;
    };

    await assert.rejects(
      () =>
        exchangeAuthorizationCode(
          discovery,
          {
            code: "code-123",
            redirectUri: "http://127.0.0.1:9876/callback",
            clientId: "client-123",
            codeVerifier: "verifier-123",
          },
          5000,
        ),
      {
        code: "AUTH_ERROR",
        message: /evil.example.com/,
      },
    );
  });
});

describe("refreshGrant", () => {
  const discovery: CliAuthDiscovery = validateDiscovery(VALID_DISCOVERY, BASE_URL);

  it("success returns the new refresh token", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "new-refresh",
        }),
        { status: 200 },
      );

    const result = await refreshGrant(
      discovery,
      { refreshToken: "old-refresh", clientId: "client-123" },
      5000,
    );

    assert.equal(result.accessToken, "new-access");
    assert.equal(result.refreshToken, "new-refresh");
  });

  it("400 invalid_grant produces the specific refresh-token message", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

    await assert.rejects(
      () =>
        refreshGrant(
          discovery,
          { refreshToken: "old-refresh", clientId: "client-123" },
          5000,
        ),
      {
        code: "AUTH_ERROR",
        message: /Refresh token was refused, rotated, or revoked\. Run \/login again\./,
      },
    );
  });
});

describe("revokeToken", () => {
  const discovery: CliAuthDiscovery = validateDiscovery(VALID_DISCOVERY, BASE_URL);

  it("returns true on 200 {}", async () => {
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    const result = await revokeToken(
      discovery,
      { token: "refresh-123", clientId: "client-123" },
      5000,
    );
    assert.equal(result, true);
  });

  it("throws AuthError on non-2xx", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "unsupported_token_type" }), { status: 400 });
    await assert.rejects(
      () => revokeToken(discovery, { token: "refresh-123", clientId: "client-123" }, 5000),
      {
        code: "AUTH_ERROR",
        message: /unsupported_token_type/,
      },
    );
  });
});

describe("fetchModels", () => {
  it("401 maps to AuthError", async () => {
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
    await assert.rejects(() => fetchModels(BASE_URL, "key", 5000), {
      code: "AUTH_ERROR",
      message: /Credential rejected by gateway\. Run \/login again\./,
    });
  });

  it("200 passes through parsed body", async () => {
    const body = { data: [{ id: "gpt-4" }] };
    globalThis.fetch = async (input) => {
      assert.equal(input.toString(), `${BASE_URL}/v1/models`);
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const result = await fetchModels(BASE_URL, "key", 5000);
    assert.deepEqual(result.body, body);
    assert.equal(result.baseUrl, BASE_URL);
  });

  it("sets Authorization Bearer header", async () => {
    let authHeader: string | null = null;
    globalThis.fetch = async (_input, init) => {
      authHeader = (init?.headers as Record<string, string>)?.Authorization ?? null;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await fetchModels(BASE_URL, "secret-key", 5000);
    assert.equal(authHeader, "Bearer secret-key");
  });
});
