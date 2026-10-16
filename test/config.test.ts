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
  storedUrl?: string | null;
}) {
  const env = opts.env ?? {};
  const home = env.HOME ?? "/home/user";
  const files = opts.files ?? {};
  const fileLoader = async (path: string) => files[path] ?? null;
  return {
    env: { ...env, HOME: home },
    fileLoader,
    prompt: opts.prompt ?? (async () => null),
    storedUrl: opts.storedUrl,
  };
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

const ROLE_PROFILES = {
  key_ttl_days: 180,
  roles: {
    main: {
      primary: "oc/glm-5.3-flash",
      models: ["oc/*", "gpt-oss-120b"],
      dataZone: "any",
      budgetUsd: 50,
      rpm: 600,
      tpm: 2000000,
    },
    explore: {
      primary: "qwen3.6-35b",
      models: ["qwen3.6-35b", "gpt-oss-120b"],
      dataZone: "local-only",
      budgetUsd: 10,
      rpm: 120,
      tpm: 400000,
    },
  },
};

const ROLE_PROFILES_PATH = "/home/user/.pi/agent/role-profiles.json";

describe("resolveConfig role resolution", async () => {
  const { resolveConfig } = await importConfig();

  function roleDeps(opts: {
    env?: Record<string, string | undefined>;
    fileRole?: string;
    roleProfilesPath?: string;
    profilesFile?: unknown;
  }) {
    return makeDeps({
      env: {
        ACTSIS_LITELLM_URL: "https://env.example.com",
        ...(opts.env ?? {}),
      },
      files: {
        "/home/user/.pi/agent/actsis-litellm.json": {
          ...(opts.fileRole !== undefined ? { role: opts.fileRole } : {}),
          ...(opts.roleProfilesPath !== undefined
            ? { roleProfilesPath: opts.roleProfilesPath }
            : {}),
        },
        ...(opts.profilesFile !== undefined
          ? { [opts.roleProfilesPath ?? ROLE_PROFILES_PATH]: opts.profilesFile as never }
          : {}),
      },
    });
  }

  it("no role configured keeps resolution byte-identical (role undefined)", async () => {
    const config = await resolveConfig(roleDeps({}));
    assert.equal(config.role, undefined);
    assert.equal(config.roleProfilesPath, undefined);
  });

  it("env ACTSIS_LITELLM_ROLE overrides the file role field", async () => {
    const config = await resolveConfig(
      roleDeps({
        env: { ACTSIS_LITELLM_ROLE: "explore" },
        fileRole: "main",
        roleProfilesPath: ROLE_PROFILES_PATH,
        profilesFile: ROLE_PROFILES,
      }),
    );
    assert.equal(config.role, "explore");
    assert.equal(config.roleProfilesPath, ROLE_PROFILES_PATH);
  });

  it("uses the config file role when no env override is set", async () => {
    const config = await resolveConfig(
      roleDeps({
        fileRole: "explore",
        roleProfilesPath: ROLE_PROFILES_PATH,
        profilesFile: ROLE_PROFILES,
      }),
    );
    assert.equal(config.role, "explore");
    assert.equal(config.roleProfilesPath, ROLE_PROFILES_PATH);
  });

  it("fails closed on an unknown role, naming the role and available roles", async () => {
    await assert.rejects(
      () =>
        resolveConfig(
          roleDeps({
            fileRole: "nobody",
            roleProfilesPath: ROLE_PROFILES_PATH,
            profilesFile: ROLE_PROFILES,
          }),
        ),
      { message: /unknown role "nobody"/ },
    );
  });

  it("fails closed when a role is set without roleProfilesPath", async () => {
    await assert.rejects(
      () => resolveConfig(roleDeps({ fileRole: "explore" })),
      { message: /roleProfilesPath/ },
    );
  });

  it("fails closed when the profiles file is unreadable at roleProfilesPath", async () => {
    await assert.rejects(
      () =>
        resolveConfig(
          roleDeps({
            fileRole: "explore",
            roleProfilesPath: "/home/user/.pi/agent/missing-profiles.json",
          }),
        ),
      { message: /unreadable|missing-profiles/ },
    );
  });

  it("fails closed when the profiles file is malformed", async () => {
    await assert.rejects(
      () =>
        resolveConfig(
          roleDeps({
            env: { ACTSIS_LITELLM_ROLE: "explore" },
            roleProfilesPath: ROLE_PROFILES_PATH,
            profilesFile: { key_ttl_days: 180, roles: {} },
          }),
        ),
      { message: /'roles' must be a non-empty object/ },
    );
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

  it("prefers config file over stored credential URL", async () => {
    const deps = makeDeps({
      env: {},
      files: {
        "/home/user/.pi/agent/actsis-litellm.json": { baseUrl: "https://file.example.com" },
      },
      storedUrl: "https://stored.example.com",
    });
    const config = await resolveConfig(deps);
    assert.equal(config.baseUrl, "https://file.example.com");
  });

  it("falls back to stored credential URL before prompting", async () => {
    const deps = makeDeps({
      env: {},
      files: {},
      storedUrl: "https://stored.example.com",
      prompt: async () => "https://prompt.example.com",
    });
    const config = await resolveConfig(deps);
    assert.equal(config.baseUrl, "https://stored.example.com");
  });
});
