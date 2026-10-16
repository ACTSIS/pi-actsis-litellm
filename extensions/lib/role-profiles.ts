// Client-side role profiles for the model-routing policy
// (docs/model-routing-policy.md §R1/§R6 in actsis-dots). The validation
// contract mirrors the server-side loader in llm-server
// scripts/load_role_profiles.py: profiles that reference unpublishable model
// ids fail at profile load, never at a production call.

import { readFile } from "node:fs/promises";

export const ROLE_KEY_PREFIX = "dots:";

export type DataZone = "any" | "local-only";

export interface RoleProfile {
  primary: string;
  models: string[];
  dataZone: DataZone;
  budgetUsd: number;
  rpm: number;
  tpm: number;
}

export interface RoleProfilesShape {
  key_ttl_days: number;
  roles: Record<string, RoleProfile>;
}

export class RoleProfilesError extends Error {
  constructor(message: string) {
    super(`roleProfiles: ${message}`);
    this.name = "RoleProfilesError";
  }
}

/** A flat structured log entry for a role-model selection decision. */
export interface RoleLogEntry {
  event: "role-model-selection";
  role: string;
  model: string;
  keyAlias?: string;
}

/**
 * Covers: exact id, or prefix-wildcard entry such as "oc/*" (any entry ending
 * with "*" matches every id starting with the prefix before the "*").
 */
function covers(entries: string[], id: string): boolean {
  return entries.some(
    (entry) =>
      entry === id || (entry.endsWith("*") && id.startsWith(entry.slice(0, -1))),
  );
}

/**
 * Fail-closed validation of the role-profiles JSON shape. Same rules as the
 * server loader (llm-server scripts/load_role_profiles.py): unknown dataZone,
 * local-only roles carrying cloud ("oc/") models, a primary not covered by
 * the role's models (exact or prefix-wildcard), non-positive
 * budgetUsd/rpm/tpm, an invalid key_ttl_days and an empty roles map all
 * reject before anything is delivered.
 */
export function loadRoleProfiles(shape: unknown): RoleProfilesShape {
  if (typeof shape !== "object" || shape === null || Array.isArray(shape)) {
    throw new RoleProfilesError(
      "role profiles: expected an object with key_ttl_days and roles",
    );
  }
  const data = shape as Record<string, unknown>;
  const ttl = data.key_ttl_days;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0) {
    throw new RoleProfilesError(
      "role profiles: key_ttl_days must be a positive integer",
    );
  }
  const roles = data.roles;
  if (typeof roles !== "object" || roles === null || Array.isArray(roles)) {
    throw new RoleProfilesError("role profiles: 'roles' must be a non-empty object");
  }
  const entries = Object.entries(roles as Record<string, unknown>);
  if (entries.length === 0) {
    throw new RoleProfilesError("role profiles: 'roles' must be a non-empty object");
  }
  for (const [name, rawProfile] of entries) {
    if (typeof rawProfile !== "object" || rawProfile === null || Array.isArray(rawProfile)) {
      throw new RoleProfilesError(`role profiles: role ${name} must be an object`);
    }
    const profile = rawProfile as Record<string, unknown>;
    const zone = profile.dataZone;
    if (zone !== "any" && zone !== "local-only") {
      throw new RoleProfilesError(`role ${name}: unknown dataZone ${JSON.stringify(zone)}`);
    }
    const models = profile.models;
    if (!Array.isArray(models) || models.length === 0) {
      throw new RoleProfilesError(`role ${name}: 'models' must be a non-empty list`);
    }
    const modelsList = models.map((m) => String(m));
    const primary = String(profile.primary ?? "");
    if (!covers(modelsList, primary)) {
      throw new RoleProfilesError(
        `role ${name}: primary "${primary}" not covered by models [${modelsList.join(", ")}]`,
      );
    }
    const budget = profile.budgetUsd;
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
      throw new RoleProfilesError(`role ${name}: budgetUsd must be positive`);
    }
    for (const limit of ["rpm", "tpm"] as const) {
      const value = profile[limit];
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new RoleProfilesError(`role ${name}: ${limit} must be a positive integer`);
      }
    }
    if (zone === "local-only") {
      const cloud = modelsList.filter((m) => m.startsWith("oc/"));
      if (cloud.length > 0) {
        throw new RoleProfilesError(
          `role ${name}: local-only role cannot list cloud models [${cloud.join(", ")}]`,
        );
      }
    }
  }
  return { key_ttl_days: ttl, roles: roles as unknown as Record<string, RoleProfile> };
}

/** Read + validate a profiles file from disk. Fails closed. */
export async function loadRoleProfilesFile(path: string): Promise<RoleProfilesShape> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new RoleProfilesError(
      `role profiles unreadable: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return loadRoleProfiles(JSON.parse(raw));
  } catch (err) {
    if (err instanceof RoleProfilesError) throw err;
    throw new RoleProfilesError(
      `role profiles unreadable: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Rule R6: role profiles may only reference ids present in the fetched proxy
 * catalog. Every non-wildcard models entry must exist in the catalog, every
 * wildcard entry must match at least one catalog id, and every primary must
 * both exist in (or wildcard-match) the catalog and be covered by the role's
 * models list. Returns human-readable error strings naming the role and the
 * offending id; an empty result means the profiles are publishable.
 */
export function validateRoleProfilesAgainstCatalog(
  profiles: RoleProfilesShape,
  catalogIds: string[],
): string[] {
  const errors: string[] = [];
  const catalogSet = new Set(catalogIds);
  for (const [name, profile] of Object.entries(profiles.roles)) {
    for (const entry of profile.models) {
      const isWildcard = entry.endsWith("*");
      const matches = isWildcard
        ? catalogIds.some((id) => id.startsWith(entry.slice(0, -1)))
        : catalogSet.has(entry);
      if (!matches) {
        errors.push(
          isWildcard
            ? `role ${name}: wildcard "${entry}" matches no id in the fetched catalog`
            : `role ${name}: model "${entry}" is not in the fetched catalog`,
        );
      }
    }
    const primary = profile.primary;
    const primaryMatches =
      catalogSet.has(primary) ||
      (primary.endsWith("*") && catalogIds.some((id) => id.startsWith(primary.slice(0, -1))));
    if (!primaryMatches) {
      errors.push(`role ${name}: primary "${primary}" is not in the fetched catalog`);
    }
  }
  return errors;
}

/** Matcher for the role's allow-list: exact id or prefix-wildcard entry. */
export function roleAllowlisted(profile: RoleProfile, modelId: string): boolean {
  return covers(profile.models, modelId);
}

/** The client-side selector: concrete catalog models allowed for the role. */
export function filterCatalogForRole<T extends { id: string }>(
  profile: RoleProfile,
  catalogModels: T[],
): T[] {
  return catalogModels.filter((m) => roleAllowlisted(profile, m.id));
}

/** dots:{user}:{role} — the alias provisioning gives the role's virtual key. */
export function roleKeyAlias(userAlias: string, role: string): string {
  return `${ROLE_KEY_PREFIX}${userAlias}:${role}`;
}

/**
 * Pure builder for the structured log line of a role-model selection
 * decision. Flat output, no prompt content, no key/token material: the only
 * credential-like field is the dotted alias (never the key value). keyAlias is
 * omitted when not discoverable.
 */
export function makeRoleLogEntry(input: {
  role: string;
  model: string;
  keyAlias?: string;
}): RoleLogEntry {
  const entry: RoleLogEntry = {
    event: "role-model-selection",
    role: input.role,
    ...(input.keyAlias !== undefined && input.keyAlias !== ""
      ? { keyAlias: input.keyAlias }
      : {}),
    model: input.model,
  };
  return entry;
}

let defaultRoleLogOut: ((line: string) => void) | null = null;

/** Minimal log primitive for the extension (no TUI dependency). */
export function emitRoleLogEntry(
  entry: RoleLogEntry,
  out: (line: string) => void = (line) => {
    (defaultRoleLogOut ?? ((l: string) => console.log(l)))(line);
  },
): void {
  out(JSON.stringify(entry));
}

/** Test seam: override where structured role log lines go. */
export function setDefaultRoleLogOut(out: (line: string) => void): void {
  defaultRoleLogOut = out;
}