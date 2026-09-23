# Feature: pi-actsis-litellm

Pi plugin/extension that adds ACTSIS LiteLLM gateway as a dynamic provider with
`/login` support (OAuth2 PKCE native CLI contract) and automatic model catalog sync.

> NOTE: This file was reconstructed on 2026-09-23 from the Engram persistent
> memory after the local working directory was lost during repository cleanup
> (incident documented in the evidence log below). The original had richer
> research notes; the task list and commit evidence were fully recoverable.

Approved decisions (user, 2026-09-22):
- Distribution: new PUBLIC repo under github.com/ACTSIS — **no internal data in code/docs**
  (base URL via env var / local config; README uses placeholders).
- Model routing: everything through `openai-completions` (`/v1/chat/completions`).
- Extra commands: namespace `/actsis-litellm:*` (status, models, logout, budget).
- Catalog: all models accessible to the user's token.
- Provider branding: display name "Actsis LiteLLM", auth method "Actsis LiteLLM (SSO)".
- 2026-09-23: odd/ is tracked in the repository (user decision: "odd va al repo").

## Research summary

- Server: LiteLLM Proxy (self-hosted). No internal hostnames anywhere.
- Native CLI auth contract: `GET /.well-known/litellm-cli-auth` (contract_version 1):
  authorize/token/register/revoke; PKCE S256; public client; loopback-only redirect;
  RFC 8707 `resource` param required; code single-use; refresh token rotates on every
  renewal; never follow 307/308 on register/token/revoke.
- pi integration points: async extension factory + `pi.registerProvider()` with
  `oauth: { login, refreshToken, getApiKey }` (native `/login` support, credentials
  persisted in `~/.pi/agent/auth.json`), `registerCommand()`, `refreshModels(context)`
  with `publish({ persist })`, `ctx.ui.setStatus` for the budget line.

## Tasks

- [x] T1. Scaffold package structure and public-safe skeleton.
- [x] T2. Config module (env > global file > project file > stored credential > prompt;
      trailing `/v1` and slashes stripped; stored scheme preserved verbatim).
- [x] T3. LiteLLM client module (discovery validation + scheme adaptation discovery-only,
      register, token exchange, refresh rotation, revoke, /v1/models with
      include_metadata, /model/info, /v2/model/info pagination).
- [x] T4. OAuth2 PKCE login flow (S256, 127.0.0.1 ephemeral loopback, state validation,
      API-key path with synthetic 10-year credential).
- [x] T5. Dynamic provider registration + catalog sync (cache schema v2, model_name
      keying, cost tiers 128k/200k/272k/512k, thinkingLevelMap, never-throw refresh,
      publish to pi models store).
- [x] T6. Commands: status / models / logout (+ budget added later).
- [x] T7. Overflow normalization (context_length_exceeded for pi auto-compaction).
- [x] T8. Budget/throttle awareness (limit-errors normalization, [litellm] marker).
- [x] T9. E2E validation against the real gateway (SSO consent + team picker,
      25-28 model catalog, refresh rotation, revoke).
- [x] T10. Non-chat model filter (CHAT_MODES / NON_CHAT_MODES / name heuristic).
- [x] T11. Install into real pi + RPC headless load proof.
- [x] T12. Catalog enrichment fix: /model/info keyed by model_name (not the opaque
      model_info.id), /v2/model/info paginated fallback, cache schema v2, real
      limits/costs/capabilities. Commit 1154f0b. Native review review-9fa6676ee00a2ae0
      APPROVED (2 advisory findings R3-MODE-BRANCH-COVERAGE, R3-PARTIAL-PAGE logged).
- [x] T13. Documentation sync (2026-09-23): README.md, docs/login-flow.md, CHANGELOG.md
      aligned to implementation via gentle-ai-explore gap report (19 findings) +
      gentle-ai-verify static cross-check (3 wording defects fixed). Issue #2
      (status:approved) + PR #3 (type:docs), MERGED rebase to main @ 8a3f484.
      Evidence: branch docs/sync-technical-functional-user-docs, commit 85c29f4
      (+66/−15 over 3 files), leak-check clean, 182/182 tests.

## Evidence log

- 2026-09-22: T1-T11 built and published; repo default branch set to main @ b5be29e;
  163/163 tests; RDD review rounds 1-2 approved (lineages review-4d8f8e4c236f1197,
  review-dcfc7e12bcfb453f); R3-001 CRITICAL fixed (e89554d); advisory fixes
  R3-002..006 (b5be29e).
- 2026-09-22 (later): refreshModels never-throw hardening (43cbeb8 on
  fix/model-refresh-throw, +2 failure-path tests, suite 165/165); RDD round 3
  approved (review-6021f84015c0ba48).
- 2026-09-23: budget widget chain hardened across 4 iterations (2296166, a6fe700,
  f2ce2cb, 6503017 setStatus migration, 0165eae diagnostic command, 9d8f4ca stored
  scheme preserved verbatim, 16fb462 nested /key/info parsing + 403 info_routes
  reporting). Suite grew to 182/182. fix/model-refresh-throw confirmed fully merged
  into main and deleted (local + remote) during repo cleanup.
- 2026-09-23: T13 documentation sync merged (PR #3, 8a3f484).
- 2026-09-23 (incident, recovery): `git worktree remove --force` from the ghost
  HOME repo deleted the entire working directory (misjudged as pointer-only);
  local-only losses: odd/tasks doc, .atl cache, node_modules. All pushed work was
  safe on GitHub. Recovered same day: fresh standalone clone of main @ 8a3f484,
  npm ci, 182/182 tests green, this file reconstructed from Engram memory
  (observations 6467, 6476, 6514, 6515). Lesson recorded: never run
  `git worktree remove` against a worktree holding the session's only checkout
  without verifying `git worktree list` semantics; treat `~` admin entries as
  real repo bindings, not cosmetic noise.