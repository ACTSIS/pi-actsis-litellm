# usage-subs — /usage-subs command (cloud subscription usage)

Show Ollama Cloud per-subscription usage (5h rolling + weekly windows, credits) by
querying the gateway's `/ollama-usage` pass-through. Contract lives in
`llm-server/odd/tasks/usage-subs.md` S6 (canonical); this doc mirrors the plugin side.

## Specs

- S1 (verbatim, user): "El comando sería usage-subs" — Pi slash command `/usage-subs`
  (naming follows the existing `/usage` command in `extensions/lib/commands.ts`).
- S2: data from a single `GET {gateway}/ollama-usage` with the same Bearer credential the `/usage` command uses; the response is the S6 collector contract from `llm-server/odd/tasks/usage-subs.md` (both windows + credits in one call, plus a per-subscription `error` field). 401/403/network errors reuse the existing AuthError/CatalogError handling paths.
- S3: render per subscription: name, 5h-window and weekly usage as
  `usageGauge()` bars vs `limitUsd` when present, absolute spend/requests otherwise;
  credits line when present; a per-subscription `error` message replaces the
  numeric lines for that subscription. Output format mirrors `formatUsageTable`
  discipline (aligned fixed-width, "usage-subs" section distinct from `/usage`).
- S4: mirrors the opencode sibling implementation (same shared mirror discipline).

## Tasks

- T1 → S2: `lib/usage-subs.ts` client + parsing per S6 contract (null-tolerant), with
  rolling-window calculation absent (gateway computes; plugin displays).
- T2 → S1,S3: `/usage-subs` command wiring in `commands.ts` (empty arg = full report).
- T3 → S2-S4: tests (`test/usage-subs.test.ts`): fetch shape, 401/403/404 handling,
  rendering (gauge vs absolute), command wiring.

## Log

- L1 (verbatim, user): "Me encanta la solución propuesta. El comando sería usage-subs"
- L2: repo pair discipline: mirrors opencode-actsis-litellm `usage-subs` implementation.