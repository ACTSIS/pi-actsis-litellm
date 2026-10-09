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

- Server: LiteLLM Proxy (self-hosted). No internal hostnames, addresses, or
  deployment fingerprints in code or docs.
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

- [x] T15. Sanitize internal references from tracked files (2026-09-24).
      LAN address in `extensions/lib/gateway-url.ts` comment, internal gateway
      hostname in `test/gateway-url.test.ts`, and server version/endpoint-count
      fingerprint in this file replaced with public placeholders. Branch
      fix/remove-internal-references. HEAD is clean; the strings remain reachable
      in prior commits until the history rewrite / repo recreation follow-up.

- [x] T14. Propagate the real cause of network failures into user-facing errors.
      Context: a real login failure surfaced as "Failed to fetch CLI auth discovery:
      fetch failed". undici wraps the root cause in `err.cause` (which the code
      discarded), hiding `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` behind an opaque
      TypeError. Diagnosing it required reproducing the fetch outside the extension.
      Branch fix/network-error-cause-reporting; commits 6799c3a (code+tests),
      d9db3a9 + 7debc55 (docs).
  - [x] T14.1 `extensions/lib/network-error.ts`: `fetchFailureMessage(err)` walks the
        cause chain (capped at 5, cycle-safe), surfaces the underlying code + message,
        and appends one actionable hint (TLS trust, DNS, refused, timeout, reset).
  - [x] T14.2 Wired into all 8 fetch sites in `extensions/lib/client.ts` via a single
        `fetchOrThrow` helper (URL/init/response handling unchanged).
  - [x] T14.3 Wired into both fetch sites in `extensions/lib/budget.ts`; the
        `/key/info` -> `/user/info` fallback ordering and AuthError rethrow untouched.
  - [x] T14.4 `test/network-error.test.ts` (21 tests): cause-chain extraction, every
        hint class, cycle/depth safety, verbatim preservation for no-cause errors,
        abort-vs-timeout, and integration class assertions.
  - [x] T14.5 Docs: README troubleshooting row + internal-CA section, CHANGELOG note.

  Scope: diagnostics only. No retry logic, no transport change, no new dependency.
  Acceptance: a TLS-trust failure names the code and points at the trust-store fix;
  a generic thrown Error keeps its original message.

  Key design constraint: catalog network failures map to `CatalogError`, NEVER
  `AuthError`, because `provider.ts` `validateApiKey()` treats any AuthError as
  "API key rejected by gateway" - the wrong class would misreport a connectivity
  problem as a bad key. Asserted by a dedicated test.

  Verified end-to-end against the REAL un-trusted gateway failure (not a mock):
  before -> `fetch failed`; after -> `fetch failed
  (UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate)
  the gateway's TLS certificate is not trusted by Node; install the issuing CA ...
  start Node with --use-system-ca`; class and top-level message preserved.

  NOTE (test-runner + isolation debt found while verifying, NOT fixed here):
  - `npm test` is broken on Node 25: `node --test test/` no longer resolves a
    directory (`Cannot find module ...\test`). Use bare `node --test` (or a glob).
  - `provider.test.ts` / `catalog.test.ts` set `process.env.HOME` to a temp dir,
    but `os.homedir()` ignores `HOME` on Windows (it reads `USERPROFILE`), so the
    developer's real `~/.pi/agent/auth.json` leaks in and changes the pass/fail
    set. Failure set therefore depends on the machine's real credential state.
  - Two pre-existing failures unrelated to T14: `catalog.test.ts:809` and
    `catalog.test.ts:864` ("refreshModels degrades gracefully when cache save
    fails" / "when publish rejects"). Same set on pristine main.

- [x] T19. TLS system-CA bootstrap (frictionless): extension startup unions
      Node's bundled CAs with the OS system-store CAs via
      tls.setDefaultCACertificates (>=22.19.0), one-shot per session, fail-open
      (never blocks startup), opt-out via ACTSIS_LITELLM_NO_SYSTEM_CA=1; test-first
      (test/tls-config.test.ts); improves the TLS hint error message with explicit
      Windows steps (setx NODE_USE_SYSTEM_CA 1).

- [x] T20. Credential resolution for /usage (and /status budget line): use
      AuthResult.auth.apiKey (pi auth resolution, commit 23d3f5d precedent in
      the budget widget) via extractUsableApiKey, falling back to the oauth
      credential access; the current /usage only checks authResult.credential
      (nonexistent field) so any valid login reports "No usable credential".

- [x] T21. Public model aliasing for /usage: LiteLLM spend logs record the
      internal deployment name (litellm_params.model, e.g. "openai/glm-5.3-flash")
      while users know the public model_name ("oc/glm-5.3-flash"). Map breakdown
      keys to public catalog ids by exact id or shared suffix after the last "/",
      merging same-alias entries at display time; unknown keys (non-chat models
      absent from the chat catalog) stay as-is.

- [x] T22. Tabulated /usage output: aligned fixed-width table (Model / Spend /
      Tokens / Reqs) with compact token counts, top-N truncation and a Total row.
      Test-first.
- [x] T23. Top-5 models widget in the TUI just below the budget line: status-area
      block via setWidget belowEditor, window = last 7 days, refresh on the same
      triggers as the budget widget (session start, agent_end, limit rewrite,
      manual /budget) with a 5-minute TTL, public aliasing like /usage,
      fail-silent (clears the block on error/data-less states).

- [x] T24. Top-5 below the Budget in the status panel (user feedback: the
      belowEditor footer block is the wrong spot). The budget renders via
      ctx.ui.setStatus("actsis-litellm:budget", ...) and Gentle Shell renders
      each status entry as one Integrations line (sorted by key). Replace the
      footer block with status rows: title entry + one entry per model row,
      keys sorting right after the budget key; drop the belowEditor block.
- [x] T25. Tabulate the top-5 status rows like the /usage table and add a
      budget-style gauge per row: model name padded, right-aligned spend,
      share percentage of the window total and an 8-cell ▰▱ gauge
      (usageGauge in usage.ts, tested).
- [x] T26. Numbers must match the LiteLLM UI: (a) primary source = the
      aggregated endpoint GET /user/daily/activity/aggregated (stable totals,
      no pagination inflation; paginated endpoint double-counts/undercounts by
      page scope and default page_size=2); (b) scope = user_id from the stored
      credential (userId) so an admin token reports "Your Usage" not org-wide;
      (c) paginate the legacy endpoint as fallback (sum rows, ignore per-page
      metadata when total_pages>1); (d) gateway request counts from
      GET /gateway/daily/activity (the dashboard's Total Requests source;
      daily-activity counts upstream attempts). Test-first.
- [x] T27. Tabulate the top-5 status rows exactly like the /usage table with
      an "=" separator under the title (user-provided layout): name padded,
      right-aligned spend, right-aligned share %, aligned gauge column; entry
      keys re-keyed (top / top0 separator / top1..5) to keep title-sep-rows
      order, legacy keys cleared.
## Evidence log

- 2026-10-09 (T27 delivery): Issue #17 + PR #18 (type:bug) merged rebase
  @ eed5182; top-5 rows tabulated to the user's sample layout: "=" separator
  under the title, name/spend/%/gauge columns aligned, keys re-keyed
  (top/top0/top1..5), legacy keys cleared. 3+ updated tests, suite 276/276,
  CI green.

- 2026-10-09 (T26 delivery): Issue #15 + PR #16 (type:bug) merged rebase
  @ 8f0a6f3. Dashboard parity: aggregated endpoint primary (query-scoped
  totals), user_id scope from stored credential userId, full pagination walk
  fallback (row sums), gateway/daily/activity footnote for Request counts.
  Live-verified vs dashboard: $476.85 vs $475.99 (~0.2%), gateway requests
  87,072 vs 86,730. 6 new tests, suite 273/273, CI green.

- 2026-10-09 (T25 delivery): Issue #13 + PR #14 (type:feature) merged rebase
  @ bdaa3e6; top-5 rows tabulated (padded name, right-aligned spend, share %)
  with budget-style 8-cell gauges via usageGauge. 4 new tests, suite 266/266,
  CI green.

- 2026-10-09 (T24 delivery): Issue #11 + PR #12 (type:bug) merged rebase
  @ 9a1b92a; top models now render as setStatus rows (title + up to 5 rows)
  directly below the Budget line in the shell Status panel; legacy footer
  block cleared on refresh. 4 new tests, suite 262/262, CI green.

- 2026-10-09 (T22/T23 delivery): Issue #9 + PR #10 (type:feature) merged rebase
  @ 75a9611; /usage tabulated (Model/Spend/Tokens/Reqs, compact counts, Total
  footer) + Top models (7d) boxed widget belowEditor (top 5 public names, 5-min
  TTL, budget triggers, fail-silent). 9 new tests, suite 258/258, CI green.

- 2026-10-09 (T21 delivery): Issue #7 + PR #8 (type:feature) merged rebase
  @ be32271; /usage shows public oc/... names via suffix aliasing over the
  chat catalog (mapModelAliases + applyModelAliases); unknown keys keep the
  internal name. 8 new tests, suite 248/248, CI green.

- 2026-10-09 (T20 delivery): Issue #5 + PR #6 (type:bug) merged rebase
  @ b809cc9; extractUsableApiKey reads AuthResult.auth.apiKey (pi auth
  resolution) with oauth-credential fallbacks; /usage functional, /status
  budget line restored, warnings preserved. 7 new tests, suite 240/240, CI green.

- 2026-09-24: T15 internal-reference sanitation. A full-history audit found
  internal references in tracked files: a LAN address in a `gateway-url.ts`
  comment, an internal gateway hostname in `gateway-url.test.ts`, and a server
  version/endpoint-count fingerprint in this file. All replaced with public
  placeholders (`192.0.2.10` RFC 5737, `gateway.example.com`). No credentials,
  tokens, or keys were ever committed (verified across all commits). Note: the
  working tree is clean, but these strings remain reachable in prior commits;
  history rewrite + repository recreation is tracked as separate follow-up.

- 2026-09-24: T14 network error cause reporting implemented
  (fix/network-error-cause-reporting; 6799c3a, d9db3a9, 7debc55). Suite grew
  +21 tests (all passing). Baseline delta proof via a detached main worktree:
  with an isolated HOME, pristine main 182/180 pass/2 fail vs branch 203/201
  pass/2 fail - identical failure set, zero new failures; `tsc --noEmit` exit 0;
  leak-check clean on changed files. Triggered by a real production login failure.

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
- 2026-10-09 (RDD round 1, lineage review-eb5f82c9a0e9555d on pre-rebase local
  history): CRITICAL R3-001 deterministic (metadata totals only inside results
  loop) -> fixed (per-field metadata override + row-sum fallback, regression
  tests). Correction-plan capture blocked inconsistently; superseded by round 2.
- 2026-10-09 (RDD round 2, lineage review-1af613d382138534): APPROVED over the
  corrected candidate; acknowledgement burned. Advisory only (informational):
  WARNING commands.ts:378-381 + 3 SUGGESTIONs. Delivery: ordinary policy.
- 2026-10-09 (T19 TLS bootstrap): Issue #3 (status:approved, type:bug) + PR #4
  (merged rebase, 411eb67). tls-config.ts unions bundled+system CAs at startup
  (fail-open, once per session, opt-out ACTSIS_LITELLM_NO_SYSTEM_CA=1); TLS
  hint carries Windows/Linux remediation. 13 new tests, suite 233/233, CI green.
- 2026-10-09 (T18 delivery): Issue #1 (status:approved) + PR #2 (type:feature,
  Closes #1). Push initially rejected: remote history had been rewritten
  (unrelated roots); rebased feature commits onto rewritten main @ a6e377b.
  Local-only env dependency found: refreshModels resolved gateway URL from
  ambient auth.json/config instead of build-time baseUrl -> fixed (b0119c7);
  masked on dev machines by stored credentials, failed on CI fresh runner
  (catalog tests saveCount 0 !== 1). New CI workflow (npm ci + typecheck +
  test, tsx pinned devDependency, node 22): test:SUCCESS on PR #2, then
  rebase-merged to main @ b0119c7, remote branch deleted, suite 220/220 on main.