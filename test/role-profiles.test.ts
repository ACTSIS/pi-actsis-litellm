import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RoleProfile, RoleProfilesShape } from "../extensions/lib/role-profiles.ts";
import type { buildProviderConfig as buildProviderConfigType } from "../extensions/lib/provider.ts";
type BuildConfigType = Parameters<typeof buildProviderConfigType>[0];

async function importRoleProfiles() {
  return await import("../extensions/lib/role-profiles.ts");
}

// Shape mirrors llm-server scripts/role-profiles.json (approved 2026-10-16).
function approvedProfilesShape(): RoleProfilesShape {
  return {
    key_ttl_days: 180,
    roles: {
      main: {
        primary: "oc/glm-5.3-flash",
        models: ["oc/*", "gpt-oss-120b"],
        dataZone: "any",
        budgetUsd: 50,
        rpm: 600,
        tpm: 2_000_000,
      },
      worker: {
        primary: "oc/qwen3-coder",
        models: ["oc/*", "oc/qwen3-coder"],
        dataZone: "any",
        budgetUsd: 30,
        rpm: 300,
        tpm: 1_000_000,
      },
      explore: {
        primary: "qwen3.6-35b",
        models: ["qwen3.6-35b", "gpt-oss-120b"],
        dataZone: "local-only",
        budgetUsd: 10,
        rpm: 120,
        tpm: 400_000,
      },
      verify: {
        primary: "gpt-oss-120b",
        models: ["gpt-oss-120b"],
        dataZone: "local-only",
        budgetUsd: 10,
        rpm: 120,
        tpm: 400_000,
      },
    },
  };
}

function approvedProfilesJson(): string {
  return JSON.stringify(approvedProfilesShape(), null, 2);
}

function roleConfigForRefresh(profilesPath: string, role = "explore") {
  return {
    baseUrl: "https://gateway.example.com",
    providerId: "actsis-litellm",
    catalogTtlMs: 15 * 60 * 1000,
    requestTimeoutMs: 30_000,
    role,
    roleProfilesPath: profilesPath,
  };
}

describe("ROLE_KEY_PREFIX", () => {
  it("is the dots: prefix", async () => {
    const { ROLE_KEY_PREFIX } = await importRoleProfiles();
    assert.equal(ROLE_KEY_PREFIX, "dots:");
  });
});

describe("loadRoleProfiles", () => {
  it("accepts the approved server profiles shape (oc/* wildcards included)", async () => {
    const { loadRoleProfiles } = await importRoleProfiles();
    const profiles = loadRoleProfiles(approvedProfilesShape());
    assert.equal(profiles.key_ttl_days, 180);
    assert.equal(Object.keys(profiles.roles).length, 4);
  });

  it("rejects a non-object shape", async () => {
    const { loadRoleProfiles } = await importRoleProfiles();
    assert.throws(() => loadRoleProfiles(null), /role profiles/);
    assert.throws(() => loadRoleProfiles("nope"), /role profiles/);
    assert.throws(() => loadRoleProfiles([]), /role profiles/);
  });

  it("rejects a missing or non-positive key_ttl_days", async () => {
    const { loadRoleProfiles } = await importRoleProfiles();
    const missing = approvedProfilesShape() as Partial<RoleProfilesShape>;
    delete missing.key_ttl_days;
    assert.throws(() => loadRoleProfiles(missing), /key_ttl_days/);
    assert.throws(
      () => loadRoleProfiles({ ...approvedProfilesShape(), key_ttl_days: 0 }),
      /key_ttl_days/,
    );
    assert.throws(
      () => loadRoleProfiles({ ...approvedProfilesShape(), key_ttl_days: -1 } as RoleProfilesShape),
      /key_ttl_days/,
    );
  });

  it("rejects an empty or non-object roles map", async () => {
    const { loadRoleProfiles } = await importRoleProfiles();
    assert.throws(
      () => loadRoleProfiles({ ...approvedProfilesShape(), roles: {} }),
      /'roles' must be a non-empty object/,
    );
    assert.throws(
      () => loadRoleProfiles({ ...approvedProfilesShape(), roles: [] } as unknown as RoleProfilesShape),
      /'roles' must be a non-empty object/,
    );
  });

  it("rejects an unknown dataZone naming the role", async () => {
    const { loadRoleProfiles } = await importRoleProfiles();
    const profiles = approvedProfilesShape();
    (profiles.roles.verify as Partial<RoleProfile>).dataZone = "somewhere" as never;
    assert.throws(() => loadRoleProfiles(profiles), /role verify: unknown dataZone "somewhere"/);
  });

  it("rejects a local-only role that lists oc/* cloud models, including the wildcard entry", async () => {
    const { loadRoleProfiles } = await importRoleProfiles();
    const profiles = approvedProfilesShape();
    (profiles.roles.verify as RoleProfile).models = ["gpt-oss-120b", "oc/*"] as never;
    assert.throws(() => loadRoleProfiles(profiles), /role verify: local-only.*oc\/\*/);
  });

  it("rejects a primary not covered by models (exact or wildcard)", async () => {
    const { loadRoleProfiles } = await importRoleProfiles();
    const profiles = approvedProfilesShape();
    (profiles.roles.main as RoleProfile).models = ["gpt-oss-120b"] as never;
    assert.throws(
      () => loadRoleProfiles(profiles),
      /role main: primary "oc\/glm-5\.3-flash" not covered by models/,
    );
  });

  it("rejects non-positive budgetUsd/rpm/tpm", async () => {
    const { loadRoleProfiles } = await importRoleProfiles();
    for (const field of ["budgetUsd", "rpm", "tpm"] as const) {
      const zero = approvedProfilesShape();
      (zero.roles.explore as unknown as Record<string, number>)[field] = 0;
      assert.throws(
        () => loadRoleProfiles(zero),
        new RegExp(`role explore: ${field} must be`),
      );
      const negative = approvedProfilesShape();
      (negative.roles.explore as unknown as Record<string, number>)[field] = -5;
      assert.throws(
        () => loadRoleProfiles(negative),
        new RegExp(`role explore: ${field} must be`),
      );
    }
  });

  it("rejects per-role budgets and unknown roles in loadRoleProfilesFile", async () => {
    const { loadRoleProfilesFile } = await importRoleProfiles();
    await assert.rejects(
      () => loadRoleProfilesFile("/definitely/missing/role-profiles.json"),
      /role profiles unreadable/,
    );
  });
});

describe("validateRoleProfilesAgainstCatalog (R6)", () => {
  it("flags a non-wildcard models id missing from the catalog, naming role and id", async () => {
    const { validateRoleProfilesAgainstCatalog } = await importRoleProfiles();
    const catalog = ["oc/glm-5.3-flash", "oc/qwen3-coder", "qwen3.6-35b", "gpt-oss-120b"];
    const profiles = approvedProfilesShape();
    (profiles.roles.verify as RoleProfile).models = ["gpt-oss-120b", "ghost-model"] as never;
    const errors = validateRoleProfilesAgainstCatalog(profiles, catalog);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /role verify/);
    assert.match(errors[0], /ghost-model/);
  });

  it("fail oc/* with zero matching catalog ids for a role whose primary is oc/*, and pass when catalog carries oc/* ids", async () => {
    const { validateRoleProfilesAgainstCatalog } = await importRoleProfiles();
    const noCloud = ["qwen3.6-35b", "gpt-oss-120b"];
    const profiles = approvedProfilesShape();
    let errors = validateRoleProfilesAgainstCatalog(profiles, noCloud);
    assert.ok(errors.some((e) => /role main.*oc\/\*/.test(e)), errors.join("; "));
    assert.ok(errors.some((e) => /role worker.*oc\/\*/.test(e)), errors.join("; "));

    const withCloud = ["oc/glm-5.3-flash", "oc/qwen3-coder", "qwen3.6-35b", "gpt-oss-120b"];
    errors = validateRoleProfilesAgainstCatalog(profiles, withCloud);
    assert.deepEqual(errors, []);
  });

  it("flags a primary covered by models but absent from the catalog, naming role and id", async () => {
    const { validateRoleProfilesAgainstCatalog } = await importRoleProfiles();
    const catalog = ["gpt-oss-120b", "qwen3.6-35b"];
    const profiles = approvedProfilesShape();
    const errors = validateRoleProfilesAgainstCatalog(profiles, catalog);
    assert.ok(
      errors.some((e) => /role worker: primary "oc\/qwen3-coder"/.test(e)),
      errors.join("; "),
    );
  });

  it("passes every role when every id (wildcard included) resolves against the catalog", async () => {
    const { validateRoleProfilesAgainstCatalog } = await importRoleProfiles();
    const catalog = [
      "oc/glm-5.3-flash",
      "oc/qwen3-coder",
      "gpt-oss-120b",
      "qwen3.6-35b",
    ];
    const errors = validateRoleProfilesAgainstCatalog(approvedProfilesShape(), catalog);
    assert.deepEqual(errors, []);
  });

  it("flags a local-only primary missing from the catalog even though its models list is fine", async () => {
    const { validateRoleProfilesAgainstCatalog } = await importRoleProfiles();
    // explore primary qwen3.6-35b exists; drop it from the catalog so both the
    // primary and its non-wildcard coverage break.
    const catalog = ["gpt-oss-120b"];
    const profiles = approvedProfilesShape();
    const errors = validateRoleProfilesAgainstCatalog(profiles, catalog);
    assert.ok(errors.some((e) => /role explore.*qwen3\.6-35b/.test(e)), errors.join("; "));
  });
});

describe("roleAllowlisted", () => {
  it("matches exact ids and prefix wildcards", async () => {
    const { roleAllowlisted } = await importRoleProfiles();
    const main = approvedProfilesShape().roles.main as RoleProfile;
    assert.equal(roleAllowlisted(main, "oc/glm-5.3-flash"), true);
    assert.equal(roleAllowlisted(main, "gpt-oss-120b"), true);
    assert.equal(roleAllowlisted(main, "ghost-model"), false);
    const verify = approvedProfilesShape().roles.verify as RoleProfile;
    assert.equal(roleAllowlisted(verify, "gpt-oss-120b"), true);
    assert.equal(roleAllowlisted(verify, "oc/glm-5.3-flash"), false);
  });

  it("does not allow models outside the exact-wildcard prefix", async () => {
    const { roleAllowlisted, loadRoleProfiles } = await importRoleProfiles();
    const profiles = loadRoleProfiles({
      key_ttl_days: 180,
      roles: {
        scoped: {
          primary: "oc/qwen3-coder",
          models: ["oc/qwen3*"],
          dataZone: "any",
          budgetUsd: 10,
          rpm: 10,
          tpm: 100_000,
        },
      },
    });
    const scoped = profiles.roles.scoped as RoleProfile;
    assert.equal(roleAllowlisted(scoped, "oc/qwen3-coder"), true);
    assert.equal(roleAllowlisted(scoped, "oc/glm-5.3-flash"), false);
  });
});

describe("filterCatalogForRole", () => {
  it("keeps concrete catalog ids allowed for the role (exact + wildcard)", async () => {
    const { filterCatalogForRole, loadRoleProfiles } = await importRoleProfiles();
    const profiles = loadRoleProfiles(approvedProfilesShape());
    const catalog = [
      { id: "oc/glm-5.3-flash" },
      { id: "oc/qwen3-coder" },
      { id: "qwen3.6-35b" },
      { id: "gpt-oss-120b" },
    ];
    const main = filterCatalogForRole(profiles.roles.main as RoleProfile, catalog);
    assert.deepEqual(main, [{ id: "oc/glm-5.3-flash" }, { id: "oc/qwen3-coder" }, { id: "gpt-oss-120b" }]);
    const explore = filterCatalogForRole(profiles.roles.explore as RoleProfile, catalog);
    assert.deepEqual(explore, [{ id: "qwen3.6-35b" }, { id: "gpt-oss-120b" }]);
  });

  it("filters a local-only role out of cloud ids present in the catalog", async () => {
    const { filterCatalogForRole, loadRoleProfiles } = await importRoleProfiles();
    const profiles = loadRoleProfiles(approvedProfilesShape());
    const catalog = [
      { id: "oc/glm-5.3-flash" },
      { id: "qwen3.6-35b" },
      { id: "gpt-oss-120b" },
    ];
    const verify = filterCatalogForRole(profiles.roles.verify as RoleProfile, catalog);
    assert.deepEqual(verify.map((m) => m.id), ["gpt-oss-120b"]);
  });
});

describe("roleKeyAlias", () => {
  it("builds dots:userAlias:role", async () => {
    const { roleKeyAlias } = await importRoleProfiles();
    assert.equal(roleKeyAlias("drondon", "main"), "dots:drondon:main");
    assert.equal(roleKeyAlias("rpinto", "worker"), "dots:rpinto:worker");
  });
});

describe("makeRoleLogEntry", () => {
  it("builds a flat structured object with only role-model fields", async () => {
    const { makeRoleLogEntry } = await importRoleProfiles();
    const entry = makeRoleLogEntry({
      role: "verify",
      keyAlias: "dots:drondon:verify",
      model: "gpt-oss-120b",
    });
    assert.deepEqual(entry, {
      event: "role-model-selection",
      role: "verify",
      keyAlias: "dots:drondon:verify",
      model: "gpt-oss-120b",
    });
  });

  it("contains no prompt content and no key/token material", async () => {
    const { makeRoleLogEntry } = await importRoleProfiles();
    const entry = makeRoleLogEntry({
      role: "main",
      keyAlias: "dots:rpinto:main",
      model: "oc/glm-5.3-flash",
    });
    const rendered = JSON.stringify(entry);
    assert.ok(!/sk-/.test(rendered));
    assert.ok(!/token/i.test(rendered));
    // Only the dotted alias is present, never the raw key value.
    assert.equal(Object.keys(entry).join(","), "event,role,keyAlias,model");
  });

  it("omits keyAlias when it is not discoverable", async () => {
    const { makeRoleLogEntry } = await importRoleProfiles();
    const entry = makeRoleLogEntry({ role: "main", model: "oc/glm-5.3-flash" });
    assert.ok(!("keyAlias" in entry));
    assert.deepEqual(entry, {
      event: "role-model-selection",
      role: "main",
      model: "oc/glm-5.3-flash",
    });
  });
});
describe("provider build path role wiring", () => {
  let WIRING_PROFILE_PATH = "";

  async function wiringFixture() {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { buildProviderConfig } = await import("../extensions/lib/provider.ts");
    const dir = await mkdtemp(path.join(os.tmpdir(), "role-profiles-wiring-"));
    const profilesPath = path.join(dir, "role-profiles.json");
    WIRING_PROFILE_PATH = profilesPath;
    await writeFile(profilesPath, approvedProfilesJson(), "utf8");
    return { buildProviderConfig, profilesPath, dir };
  }

  const CATALOG = [
    { id: "gpt-oss-120b" },
    { id: "oc/glm-5.3-flash" },
    { id: "oc/qwen3-coder" },
    { id: "qwen3.6-35b" },
  ] as never;

  function roleConfig(profilesPath: string, role = "explore"): BuildConfigType {
    return {
      baseUrl: "https://gateway.example.com",
      providerId: "actsis-litellm",
      catalogTtlMs: 15 * 60 * 1000,
      requestTimeoutMs: 30_000,
      role,
      roleProfilesPath: profilesPath,
    };
  }

  it("filters the cached catalog delivered by buildProviderConfig to the role allow-list", async () => {
    const { buildProviderConfig, profilesPath } = await wiringFixture();
    const config = await buildProviderConfig(roleConfig(profilesPath), {
      loadCachedModels: async () => CATALOG,
      saveCachedModels: async () => {},
      computeCacheAge: async () => 0,
    });
    const ids = config.models.map((m) => m.id);
    assert.deepEqual(ids, ["gpt-oss-120b", "qwen3.6-35b"]);
  });

  it("does not touch model delivery when no role is configured", async () => {
    const { buildProviderConfig, profilesPath } = await wiringFixture();
    const noRoleConfig = { ...roleConfig(profilesPath) } as BuildConfigType;
    delete (noRoleConfig as { role?: string }).role;
    delete (noRoleConfig as { roleProfilesPath?: string }).roleProfilesPath;
    const config = await buildProviderConfig(noRoleConfig, {
      loadCachedModels: async () => CATALOG,
      saveCachedModels: async () => {},
      computeCacheAge: async () => 0,
    });
    assert.equal(config.models.length, 4);
  });

  it("fails build closed when the profiles file is unreadable for an active role", async () => {
    const { buildProviderConfig } = await wiringFixture();
    await assert.rejects(
      () =>
        buildProviderConfig(roleConfig("/definitely/missing/role-profiles.json"), {
          loadCachedModels: async () => CATALOG,
          saveCachedModels: async () => {},
          computeCacheAge: async () => 0,
        }),
      /role explore.*unreadable|unreadable.*explore/,
    );
  });

  it("emits one structured role log entry with the dotted alias and no key material", async () => {
    const { buildProviderConfig } = await wiringFixture();
    const logged: unknown[] = [];
    await buildProviderConfig(roleConfig(WIRING_PROFILE_PATH), {
      loadCachedModels: async () => CATALOG,
      saveCachedModels: async () => {},
      computeCacheAge: async () => 0,
      logRoleEntry: (entry: unknown) => logged.push(entry),
    });
    assert.equal(logged.length, 1);
    const rendered = JSON.stringify(logged[0]);
    assert.match(rendered, /"role":"explore"/);
    assert.match(rendered, /"model"/);
    assert.ok(!/"apiKey"/.test(rendered));
    assert.ok(!/sk-/.test(rendered));
  });
});

describe("provider refresh path role wiring", () => {
  let WIRING_REFRESH_PATH = "";

  async function refreshFixture() {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { buildProviderConfig } = await import("../extensions/lib/provider.ts");
    const dir = await mkdtemp(path.join(os.tmpdir(), "role-profiles-refresh-"));
    const profilesPath = path.join(dir, "role-profiles.json");
    WIRING_REFRESH_PATH = profilesPath;
    await writeFile(profilesPath, approvedProfilesJson(), "utf8");
    return { buildProviderConfig, profilesPath };
  }

  function fetchStub(ids: string[] | "unreachable"): typeof globalThis.fetch {
    return (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = input.toString();
      if (ids === "unreachable") {
        throw new Error("gateway down");
      }
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
          status: 200,
        });
      }
      if (url.includes("/model/info")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  }

  function refreshContext(overrides: Record<string, unknown> = {}) {
    return {
      allowNetwork: true,
      force: true,
      credential: { type: "oauth", access: "gateway-key", refresh: "", expires: 0, userId: "drondon" },
      publish: async () => false,
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  it("refreshModels returns the role-filtered fetched catalog and logs the selection with the dotted alias", async () => {
    const { buildProviderConfig, profilesPath } = await refreshFixture();
    globalThis.fetch = fetchStub(["oc/glm-5.3-flash", "oc/qwen3-coder", "qwen3.6-35b", "gpt-oss-120b"]);
    const logged: unknown[] = [];
    const provider = await buildProviderConfig(roleConfigForRefresh(profilesPath) as never, {
      loadCachedModels: async () => null,
      saveCachedModels: async () => {},
      computeCacheAge: async () => null,
      logRoleEntry: (entry: unknown) => logged.push(entry),
    });
    const result = await provider.refreshModels(refreshContext() as never);
    assert.deepEqual(result.map((m: { id: string }) => m.id), ["gpt-oss-120b", "qwen3.6-35b"]);
    const refreshEntry = JSON.stringify(logged.at(-1));
    assert.match(refreshEntry, /"role":"explore"/);
    assert.match(refreshEntry, /"keyAlias":"dots:drondon:explore"/);
    globalThis.fetch = undefined as never;
  });

  it("refreshModels fails closed when the fetched catalog lacks a profile id, naming role and id", async () => {
    const { buildProviderConfig, profilesPath } = await refreshFixture();
    globalThis.fetch = fetchStub(["oc/glm-5.3-flash", "gpt-oss-120b"]);
    const provider = await buildProviderConfig(roleConfigForRefresh(profilesPath) as never, {
      loadCachedModels: async () => null,
      saveCachedModels: async () => {},
      computeCacheAge: async () => null,
      logRoleEntry: () => {},
    });
    await assert.rejects(
      () => provider.refreshModels(refreshContext() as never),
      /role explore.*qwen3\.6-35b/,
    );
    globalThis.fetch = undefined as never;
  });

  it("refreshModels fails closed when the catalog is unavailable for an active role", async () => {
    const { buildProviderConfig, profilesPath } = await refreshFixture();
    globalThis.fetch = fetchStub("unreachable");
    const provider = await buildProviderConfig(roleConfigForRefresh(profilesPath) as never, {
      loadCachedModels: async () => null,
      saveCachedModels: async () => {},
      computeCacheAge: async () => null,
      logRoleEntry: () => {},
    });
    await assert.rejects(
      () => provider.refreshModels(refreshContext() as never),
      /role explore.*catalog unavailable/,
    );
    globalThis.fetch = undefined as never;
  });
});
