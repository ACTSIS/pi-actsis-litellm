# Feature: issue-48-catalog-scope

Diagnose and close #48 (extension catalog missing local chat models) by
documenting and surfacing the credential/team scope the catalog refresh uses.
Root cause already diagnosed live on the gateway (see Log).

## Specs

- S1 (verbatim, issue #48): "bug: catálogo de la extensión sin los modelos
  locales (solo oc/*) — chatear con gpt-oss-120b/qwen3.6-35b no es posible
  desde el provider actsis-litellm".
- S2 (verbatim, issue #48 acceptance): "With a user identity in team
  `Acceso-Completo`, the extension catalog includes the local chat models
  (`gpt-oss-120b`, `qwen3.6-35b`, …)."
  → Verified live 2026-10-29: gateway OK with the same user's
  Acceso-Completo session (56 models, all locals present; host cache
  refreshed to 52). No catalog filter change is needed or wanted.
- S3 (verbatim, issue #48 acceptance): "Catalog refresh documents which
  credential/scope it uses (login session vs stored API key)."
- S4 (verbatim, issue #48 acceptance): "Non-chat modes (image/embedding/audio)
  stay excluded from the chat picker (regression guard)."

## Tasks

- [x] T1 → S3: cache records the fetch scope (auth kind, userId, teamId) and
  `/actsis-litellm:models` + `/actsis-litellm:status` surface it, with a
  re-login hint when the catalog is team-constrained and oc/*-only.
- [x] T2 → S3: README documents catalog-refresh credential/scope semantics.
- [x] T3 → S4: existing `NON_CHAT_MODES`/`isChatModelId` tests keep passing
  (catalog/commands/provider suites green after the change).

## Log

- L1 (user, 2026-10-29 session): "Trabajemos con las issues" (#48 + #47).
- L2 (diagnosis, live 2026-10-29, gateway at 127.0.0.1:4000): the gateway and
  the extension filter are correct. DB: ricardo.pinto belongs to
  QA-Automatizacion ({ollama-standard}) AND Acceso-Completo ({all-proxy-models}).
  /v1/models with this user's Acceso-Completo session token returns 56 models
  (all locals: gpt-oss-120b, qwen3.6-35b, qwen3-coder-next, qwen3-vl-8b/2b);
  host cache refreshed same day with 52 models. The reported 21 oc/*-only
  cache matches a session consent-bound to a standard-only area team (L8/L12
  of llm-server odd/tasks/model-access-groups.md: OAuth sessions inherit the
  consent-chosen team's list). User action: /login again, choose the team
  with the wanted access; extension now documents the scope (T1/T2).
- L3 (evidence recorded): T1/T2 in commit feat/48-catalog-scope (catalog
  scope metadata v2-additive, tests test/catalog-scope.test.ts 8 pass).- L4 (delivery, 2026-10-29): issue approved by maintainer during delivery;
  PR #49 (Closes #48) merged to main at 6f3a9cc; CI green (typecheck+352
  tests). Feature complete and merged.
