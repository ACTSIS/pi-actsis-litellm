# usage-subs — /usage-subs command (cloud subscription usage)

Show Ollama Cloud per-subscription usage (5h rolling + weekly windows, credits) by
querying the gateway's `/ollama-usage` pass-through. Contract lives in
`llm-server/odd/tasks/usage-subs.md` S6 (canonical); this doc mirrors the plugin side.

## Specs

- S1 (verbatim, user): "El comando sería usage-subs" — Pi slash command `/usage-subs`
  (naming follows the existing `/usage` command in `extensions/lib/commands.ts`).
- S2: data from a single `GET {gateway}/ollama-usage` with the same Bearer credential the `/usage` command uses; the response is the S6 collector contract from `llm-server/odd/tasks/usage-subs.md` (both windows + credits in one call, plus a per-subscription `error` field). 401/403/network errors reuse the existing AuthError/CatalogError handling paths.
- S3: tabular render in the /usage table discipline (aligned fixed-width columns,
  "-" separator rules): columns Sub, 5h used, 5h resets, Weekly used, Weekly resets,
  Credits. Window cells: upstream `remaining_percent` → used% gauge (used =
  100-remaining); `limitUsd` → gauge of spend/limit; else absolute reqs/tokens.
  A per-subscription `error` renders `(error: ...)` in the first window cell and
  dashes elsewhere; no totals row (accounts are separate).
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
- L3: implemented on feat/usage-subs, commit 72eb208 (verified: 299 pass / 0 fail,
  typecheck pass). Author identity mirrored repo-locally from llm-server
  (Ricardo Pinto / ricardo.pinto@actsis).
- L4: legacy-plan window quotas added (mirrors llm-server doc L8): collector
  surfaces /api/balance remaining_percent blocks as credits.session/credits.weekly;
  plugin renders a used% gauge with resets per window. Commit 7079ce1 (verified:
  300 pass / 0 fail, typecheck pass).
- L5 (verbatim, user): "Momento, visualmente no me gusta, tratemos de tabular,
  como lo hacemos con el comando \"usage\", para que visualmente sea más ordenado".
  Render rewritten as the /usage-style table (S3 updated).- L6: gauges colored by used% thresholds (green/yellow/orange/red truecolor,
  opt-in {color:true}; /usage-subs opts in). Padding strips ANSI for width.
  Commit logged next entry.
- L7: delivered via PR https://github.com/ACTSIS/pi-actsis-litellm/pull/21, merge
  c24dcec to main (feat/usage-subs 7079ce1→1afdcf1→97f8ba2).
