# Client-side model-routing roles (pi-actsis-litellm)

Implementation of the Dot model-routing policy (approved 2026-10-16,
`docs/model-routing-policy.md` in `actsis-dots`, rules R1/R6 and acceptance
checks 6–7) on the client side: roles are resolved from config, role profiles
are validated against the gateway-catalog models the provider actually
fetched, and the delivered model list is filtered to the active role.

## Config

| Field | Source | Meaning |
| --- | --- | --- |
| `role` | `ACTSIS_LITELLM_ROLE` env override, else config-file field | one of the roles defined in the profiles file (`main`, `worker`, `explore`, `verify`, `review` by default) |
| `roleProfilesPath` | config-file field | path to the role-profiles JSON produced by llm-server provisioning (same contract as `llm-server/scripts/role-profiles.json`) |

Precedence for `role`: environment first, then config file. When no role is
configured, no role logic runs and provider behavior is unchanged.

Fail-closed rule: with a role configured, role resolution and every catalog
refresh first load + validate the profiles against the fetched catalog. Any of
the following fails CLOSED with an error naming the role (and the offending
model id where applicable):

- unknown role (not present in the profiles file),
- missing `roleProfilesPath` or unreadable/malformed profiles file,
- server-rejected shape (unknown `dataZone`, `local-only` role listing `oc/`
  cloud models, primary not covered by `models`, non-positive
  `budgetUsd`/`rpm`/`tpm`/`key_ttl_days`, empty `roles` map),
- a `models` id absent from the fetched catalog, a wildcard (`oc/*`) matching
  no fetched catalog id, or a primary absent from the fetched catalog,
- an unavailable gateway catalog while a role is active.

Unknown ids therefore fail at profile load — never at a production call (R6).

## Profile shape (unchanged from llm-server)

```json
{
  "key_ttl_days": 180,
  "roles": {
    "worker": {
      "primary": "qwen3-coder-next",
      "models": ["oc/*", "gpt-oss-120b", "qwen3-coder-next"],
      "dataZone": "any",
      "budgetUsd": 30,
      "rpm": 300,
      "tpm": 1000000
    }
  }
}
```

- `primary`: the role's first-choice model; the delivered catalog order places
  no preference — the log entry records the resolved primary model.
- `models`: allow-list. Entries may be prefix wildcards (`oc/*`); an entry
  covers an id exactly or by the `entry*` prefix.
- `dataZone`: `any` or `local-only`; `local-only` roles may not list `oc/`
  models (server-rejected, and the server-side key allow-list remains the hard
  floor).

## Observability

Each role-model selection decision (initial delivery from the cached catalog
and each filtered catalog refresh) emits one flat structured log line, and
nothing else:

```json
{"event":"role-model-selection","role":"verify","keyAlias":"dots:user:verify","model":"gpt-oss-120b"}
```

`keyAlias` is included only when discoverable from the active credential (the
dotted alias shape `dots:{user}:{role}` — never the key value itself). Logs
never contain prompt content, and never the raw key/token material: only the
dotted alias.