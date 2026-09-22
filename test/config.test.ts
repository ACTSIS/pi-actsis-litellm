import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ConfigFileShape } from "../extensions/lib/config.ts";

async function importConfig() {
  const { resolveConfig, normalizeBaseUrl } = await import(
    "../extensions/lib/config.ts"
  );
  return { resolveConfig, normalizeBaseUrl };
}

function makeDeps(opts: {
  env?: Record<string, string | undefined>;
  files?: Record<string, ConfigFileShape | null>;
  prompt?: () => Promise<string | null | undefined>;
}) {
  const env = opts.env ?? {};
  const home = env.HOME ?? "/home/user";
  const files = opts.files ?? {};
  const fileLoader = async (path: string) => files[path] ?? null;
  return { env: { ...env, HOME: home }, fileLoader, prompt: opts.prompt ?? (async () => null) };
}

describe("normalizeBaseUrl", async () => {
  const { normalizeBaseUrl } = await importConfig();

  it("strips trailing slash", () => {
    assert.equal(normalizeBaseUrl("https://gateway.example.com/"), "https://gateway.example.com");
  });

  it("strips trailing /v1", () => {
    assert.equal(
      normalizeBaseUrl("https://gateway.example.com/v1"),
      "https://gateway.example.com",
    );
  });

  it("strips trailing slash + /v1", () => {
    assert.equal(
      normalizeBaseUrl("https://gateway.example.com/v1/"),
      "https://gateway.example.com",
    );
  });

  it("rejects non-http schemes", () => {
    assert.throws(() => normalizeBaseUrl("ftp://gateway.example.com"), {
      message: /Only http:\/\/ and https:\/\/ are supported/,
    });
  });

  it("rejects invalid URLs", () => {
    assert.throws(() => normalizeBaseUrl("not a url"), {
      message: /Invalid gateway URL/,
    });
  });
});

describe("resolveConfig", async () => {
  const { resolveConfig } = await importConfig();

  it("uses env variable first", async () => {
    const deps = makeDeps({
      env: { ACTSIS_LITELLM_URL: "https://env.example.com/" },
      files: {
        "undefined/.pi/agent/actsis-litellm.json": { baseUrl: "https://file.example.com" },
        "./.pi/actsis-litellm.user.json": { baseUrl: "https://local.example.com" },
      },
    });
    const config = await resolveConfig(deps);
    assert.equal(config.baseUrl, "https://env.example.com");
  });

  it("falls back to the first config file in order", async () => {
    const deps = makeDeps({
      env: {},
      files: {
        "/home/user/.pi/agent/actsis-litellm.json": { baseUrl: "https://file.example.com" },
        "./.pi/actsis-litellm.user.json": { baseUrl: "https://local.example.com" },
      },
    });
    const config = await resolveConfig(deps);
    assert.equal(config.baseUrl, "https://file.example.com");
  });

  it("skips missing files and uses later files", async () => {
    const deps = makeDeps({
      env: {},
      files: {
        "/home/user/.pi/agent/actsis-litellm.json": null,
        "./.pi/actsis-litellm.user.json": { baseUrl: "https://local.example.com" },
      },
    });
    const config = await resolveConfig(deps);
    assert.equal(config.baseUrl, "https://local.example.com");
  });

  it("prompts when nothing else is configured", async () => {
    const deps = makeDeps({
      env: {},
      files: {},
      prompt: async () => "https://prompt.example.com/",
    });
    const config = await resolveConfig(deps);
    assert.equal(config.baseUrl, "https://prompt.example.com");
  });

  it("applies config file TTL and timeout settings", async () => {
    const deps = makeDeps({
      env: { ACTSIS_LITELLM_URL: "https://env.example.com" },
      files: {
        "/home/user/.pi/agent/actsis-litellm.json": {
          catalogTtlMinutes: 5,
          requestTimeoutMs: 10_000,
          providerId: "custom-litellm",
        },
      },
    });
    const config = await resolveConfig(deps);
    assert.equal(config.catalogTtlMs, 5 * 60 * 1000);
    assert.equal(config.requestTimeoutMs, 10_000);
    assert.equal(config.providerId, "custom-litellm");
  });

  it("uses defaults when settings are missing", async () => {
    const deps = makeDeps({
      env: { ACTSIS_LITELLM_URL: "https://env.example.com" },
    });
    const config = await resolveConfig(deps);
    assert.equal(config.providerId, "actsis-litellm");
    assert.equal(config.catalogTtlMs, 15 * 60 * 1000);
    assert.equal(config.requestTimeoutMs, 30_000);
  });

  it("throws ConfigError when everything is missing", async () => {
    const deps = makeDeps({ env: {}, files: {}, prompt: async () => "" });
    await assert.rejects(() => resolveConfig(deps), {
      message: /Gateway base URL not configured/,
    });
  });
});
