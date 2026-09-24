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

## Evidence log

- 2026-09-24: T14 network error cause reporting implemented
  (fix/network-error-cause-reporting; 6799c3a, d9db3a9, 7debc55). Suite grew
  +21 tests (all passing). Baseline delta proof via a detached main worktree:
  with an isolated HOME, pristine main 182/180 pass/2 fail vs branch 203/201
  pass/2 fail - identical failure set, zero new failures; `tsc --noEmit` exit 0;
  leak-check clean on changed files. Triggered by a real production login failure.
  Pre-existing leak found in main (NOT introduced here, still open):
  `extensions/lib/gateway-url.ts:46` contains an internal LAN IP and
  `test/gateway-url.test.ts:145,154` contain the internal gateway hostname, in a
  declared-PUBLIC repo.

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