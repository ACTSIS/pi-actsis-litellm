# Changelog

## Sin publicar — 2026-10-30 — issue #61 (renders de imagen en background)

- Añadido: **renders de imagen detachados** — `generate_image` acepta
  `background: true` y `/actsis-litellm:image` acepta `--background`. La llamada
  devuelve un id de job al instante y la imagen terminada llega después como
  mensaje propio, sin bloquear el turno del chat ni gatillar un turno nuevo. El
  camino bloqueante sigue siendo el default: cuando el modelo necesita el
  resultado para decidir el siguiente paso, esperar es correcto.
- Añadido: el store de sesión (`image="last"`) se actualiza recién cuando el
  render termina; una edición que necesite `"last"` mientras hay un render en
  vuelo falla nombrando el job pendiente.
- Añadido: `/actsis-litellm:cancel-image <id|all>` y `AbortController` propio por
  job (el signal del tool pertenece al turno y no sobrevive al retorno).
- Añadido: estado en la línea de status mientras hay renders en vuelo
  (`job: modelo tamaño (Ns)`), limpiado al terminar el último; tope de 2 renders
  concurrentes porque el gateway renderiza en una sola GPU.
- Añadido: `session_shutdown` aborta los jobs en vuelo de forma idempotente y
  avisa que el render puede seguir corriendo en la GPU del gateway. Una falla se
  reporta como mensaje visible en el transcript más notificación.

## Sin publicar — 2026-10-30 — issue #59 (arranque sin URL de gateway / Windows)

- Corregido: la extensión ya no aborta el arranque con `Provider actsis-litellm:
  "baseUrl" is required when defining custom models.` cuando hay catálogo de
  modelos cacheado y no hay URL de gateway resoluble. El placeholder que habilita
  `/login` registra `models: []` (S1) y el catálogo cacheado vuelve a publicarse
  en cuanto hay URL.
- Corregido: la ruta del config de usuario (`~/.pi/agent/actsis-litellm.json`) se
  resuelve con `os.homedir()`, igual que `auth.json` y el cache de modelos, en vez
  de `env.HOME`. En Windows/PowerShell `HOME` no existe y la búsqueda apuntaba a
  `/.pi/agent/actsis-litellm.json` (S2). El orden de precedencia se mantiene:
  `homeDir` inyectado > `HOME` > `os.homedir()`.

## Sin publicar — 2026-10-29 — issues #47 (v2: agente con tool de imagen)

- Añadido: **tool `actsis-litellm:generate_image`** (modelo-callable) para
  pedir imágenes NATURALMENTE en el chat: el agente la llama con
  `prompt`/`size`/`model`/`image`. La lista de modelos disponibles se
  **descubre** del gateway (`/v1/models`, mode=image_generation) y la
  description de la tool se refresca (throttle 5 min, re-registro en
  `before_agent_start`) — nunca hardcodeada. Selección (S2): param explícito
  > heurística (imagen de entrada → modelo de edición) > default sdxl.
- Añadido: **edición por instrucción** desde el chat: el parámetro `image`
  acepta `"last"` (última imagen generada en la sesión, store) o un path
  (png/jpg/webp) → multipart `POST /v1/images/edits` (qwen-image-edit, 2511).
- Añadido: timeouts adaptativos por modelo/tamaño (Qwen 512=300 s,
  Qwen 1024=600 s, resto 180 s) + progreso vía onUpdate.
- Añadido: render con el mismo mensaje custom de /image + store de sesión
  para ediciones encadenadas.
- Corregido: `fetchImageEdit` ahora envía el campo multipart `size=WIDTHxHEIGHT`
  derivado del parámetro `size` de la tool (S1); antes la edición heredaba las
  dimensiones de la imagen de referencia.
- Corregido: el timeout de edición se presupuesta a partir del tamaño realmente
  enviado y de la familia del modelo (S2): qwen 512 = 300 s, qwen 768/1024 =
  1500 s, otras familias = 180 s.
- Añadido: heartbeat de progreso mientras la petición de imagen está en vuelo
  (S3), reportando segundos transcurridos vía `onUpdate` como máximo cada 30 s.
- Corregido: un timeout client-side en edición ya no dice que el gateway no
  respondió (S4); ahora informa que la petición fue abandonada tras agotar el
  presupuesto y que el render puede seguir ejecutándose en el backend ocupando
  la GPU.

## Sin publicar — 2026-10-29 — issues #48 y #47

- Añadido: **`/actsis-litellm:image`** — generación de pixel-art vía
  `POST /v1/images/generations` (`sdxl-pixel-art`), con flag `--size 512|768|1024`,
  timeout client-side de al menos 180 s, mensaje custom renderizado en el
  transcript (imagen inline si el terminal soporta kitty/iterm2) y copia .png
  persistida; usa la misma credencial que el chat.
- Añadido: la caché del catálogo guarda **qué credencial/equipo** la generó
  (auth kind + userId + teamId, campo aditivo del schema v2);
  `/actsis-litellm:models` y `/actsis-litellm:status` lo muestran y sugieren
  re-login cuando una sesión ligada a un equipo ve solo modelos `oc/*`
  (causa raíz de #48: el catálogo hereda la lista del equipo elegido en el
  consent del login).
- Docs: README con la semántica de scope del catálogo y la sección de
  generación de imágenes.

## Sin publicar — 2026-10-22 — usage-subs: contrato v2 y tabla compacta

- Añadido: **`/subs-usage` como ruta canónica** con fallback automático a
  `/ollama-usage` en 404 — las versiones desplegadas en gateways viejos
  siguen funcionando, y los gateways nuevos se llaman por su nombre canónico.
- Añadido: `SubscriptionUsage` acepta `provider`/`account`/`status` del
  contrato v2 (parseo tolerante); la columna `Sub` muestra `provider:account`
  (`chatgpt:0`, `claude:0`) y queda verbatim en payloads legacy.
- Cambiado: **tabla compacta** — se quitaron los contadores de requests y
  tokens (la celda más ancha y de bajo valor junto al porcentaje), y el sufijo
  de plan (`(plus)`, `(subscription)`). Ancho máximo medido contra el gateway
  productivo: 94 columnas (antes ~130).
- Cambiado: una ventana intacta sin reloj de reset muestra `full` en lugar de
  `-` (Anthropic devuelve `five_hour.resets_at = null` con `isActive: false`
  mientras la ventana de 5 h no se usa).

## 0.6.3 — 2026-10-16 — Paired release with opencode-actsis-litellm

- **Budget gauge colors** — the widget (footer status) and the `/status`
  `Budget:` line now carry the same ANSI truecolor threshold palette as
  `/usage-subs` (green ≤50%, yellow 51–75%, orange 76–90%, red >90%) through a
  shared `lib/gauge-color.ts`; the no-cap forms stay neutral and there is no
  pace escalation (the budget window span is unknown). Colored output renders
  in the pi footer and chat; Gentle Shell needed an upstream change to keep
  extension-painted statuses (Gentleman-Programming/gentle-shell#2330, open).
  Closes #35; mirrored to opencode-actsis-litellm (issue #21, PR #22).
- **Fixed: OAuth credentials rendered the budget widget empty** —
  `refreshBudgetWidget` extracted the bearer token from `auth.apiKey` only, so
  OAuth/SSO credentials silently resolved nothing (widget cleared, `/budget`
  printed a plain "no auth resolution" line) while `/status` resolved through
  `extractUsableApiKey`'s OAuth fallback. The widget now shares that resolver,
  pinned by OAuth regression tests (PR #38).
- Test-only: the Gentle Shell sanitize contract test now pins the
  SGR-preserving behavior (PR #39).

## 0.6.2 — 2026-10-15 — Paired release with opencode-actsis-litellm

- **Fixed: window pace silently disabled** — live collector data sends
  `from`/`until` with `until ≈ generation time` (a closed measurement range);
  under the original precedence that computed ~100% elapsed and silently
  disarmed color escalation and the projection. The quota reset instant
  (`resetsAt`, against the fixed 5h/weekly window length) now decides the
  elapsed span, and collector bounds are only used when no reset exists and
  the window is still open (`until > now`); closed ranges yield no pace. Live
  report: 5h with 57% used and reset `3 h 26 min` (~31% elapsed, pace 1.82)
  rendered plain yellow without projection; with the fix it renders orange
  with `→ 182%`. Closes #31; mirrored to opencode-actsis-litellm (issue #17).

## 0.6.1 — 2026-10-15 — Paired release with opencode-actsis-litellm

- **Window pace correlation in `/usage-subs`** — the colored gauge now takes the
  window's elapsed time into account: when consumption runs ahead of the window
  (used% / elapsed% > 1, elapsed floored at 10% so a just-started window cannot
  explode the ratio), the color escalates one threshold level and the cell
  appends the linear projection at the window's end (`15% → 150%`), capped at
  200%. Windows without known bounds (`from`/`until` or a reset instant) keep
  the previous absolute-threshold color and show no projection.

## 0.6.0 — 2026-10-15 — Paired release with opencode-actsis-litellm

- **Friendly reset countdowns in `/usage-subs`** — the 5h window now shows the
  remaining reset time as hours/minutes (`2 h 35 min`) and the weekly window as
  days/hours (`3 d 8 h`), instead of absolute reset timestamps. Durations round
  up to the displayed unit; expired resets show zero and missing/invalid
  timestamps show `-`.
- **System timezone for visible timestamps** — subscription generation,
  credential expiry, budget resets and rate-limit resets render in the host
  system timezone with local date, 24-hour clock, IANA zone name and UTC offset
  (`2026-10-14 09:56 (America/Bogota, GMT-05:00)`), including daylight-saving
  changes. No timezone configuration is required.
- **UTC query ranges labelled explicitly** — `/usage` and the Top models widget
  keep their existing UTC date-range calculations and totals, now labelled as
  UTC days. Reset countdowns and cache ages remain timezone-independent
  durations.

## 0.5.0 — 2026-10-14 — Paired release with opencode-actsis-litellm

- **`/usage-subs` command** — per-subscription Ollama Cloud window usage as
  the provider's dashboard: remaining % of the 5h/weekly windows with reset
  times and credits, aggregados por el collector del gateway.
- Tabular render in the /usage table discipline with threshold-colored
  gauges (green/yellow/orange/red), ANSI-safe padding.
- **Dependency audit note:** the installed pi runtime already ships the
  patched `brace-expansion@5.0.12`; the repo dev tree keeps a bundled
  `5.0.9` inside `pi-coding-agent@0.87.1`'s tarball (it ships prebuilt
  nested node_modules that npm overrides cannot replace) — resolving it
  requires an upstream pi-coding-agent release (1.x changes the typing
  surface and is out of proportion for this advisory). Documented
  exception with tests green.
- **Dependency audit:** npm-level clean via override; the installed pi
  runtime ships the patched `brace-expansion@5.0.12`.

## 0.4.0 — 2026-10-13 — Paired release with opencode-actsis-litellm

Version numbers now move in lockstep with the sister OpenCode plugin
(`opencode-actsis-litellm`, released at the same tag `v0.4.0`). This tag
bundles the full parity cycle previously tracked as 0.1.0 Unreleased.

- **Public model names for /usage** — Spend logs record LiteLLM's internal deployment
  names (`openai/glm-5.3-flash`); `/usage` now maps them to the public catalog ids users
  know (`oc/glm-5.3-flash`) by shared suffix over the chat catalog, merging rows that alias
  to the same public model (sorted by spend). Unknown keys (non-chat models absent from the
  catalog) keep their internal name.
- **Credential resolution fix for REST commands** — `/actsis-litellm:usage` (and the
  `/status` budget line) now read the bearer token from pi's auth resolution
  (`AuthResult.auth.apiKey`), the same source the budget widget uses; the previous
  check looked for a nonexistent `credential` field and always reported
  "No usable credential. Run /login first." for valid logins.
- **Internal CA TLS bootstrap** — At startup the extension unions Node's bundled
  root CAs with the OS system certificate store (`--use-system-ca` behavior,
  Node ≥ 22.19.0), so gateways signed by a private/internal CA (installed in
  Windows certmgr/certlm) work in the login flow without any per-machine setup.
  Strictly additive, once per session, fail-open; opt-out via
  `ACTSIS_LITELLM_NO_SYSTEM_CA=1`. TLS trust errors now carry concrete Windows
  and Linux remediation steps (`setx NODE_USE_SYSTEM_CA 1`, `certutil -encode`,
  `NODE_EXTRA_CA_CERTS`).
- **Top-5 widget toggle + hard alignment** — `/actsis-litellm:top` (toggle /
  `on` / `off`) turns the widget on/off at will, persisted in the
  extension-owned `~/.pi/agent/actsis-litellm-prefs.json` (default on);
  `off` clears the rows and stops the gateway queries. Column padding now uses
  non-breaking spaces so Gentle Shell's status-line sanitizer (which collapses
  ASCII space runs) cannot destroy the tabular alignment of the widget.
- **Dashboard-parity usage numbers** — `/usage` and the top-5 widget now query the
  aggregated `/user/daily/activity/aggregated` endpoint (stable query-scoped totals) with
  a `user_id` filter from the stored credential, so an admin token reports "Your Usage"
  instead of org-wide spend (fixes a ~10x mismatch vs the dashboard). Fallback: full
  pagination walk of `/user/daily/activity` (page_size 200, row sums; the per-page
  metadata was being mixed with row sums and both are page-scoped). Request counts are
  reconciled with a `Gateway requests:` footnote from `/gateway/daily/activity` (the
  dashboard card's source; includes non-logged traffic).
- **Tabulated /usage + top-5 status rows** — `/actsis-litellm:usage` renders an aligned
  table (Model / Spend / Tokens / Reqs, compact k/M counts, totals row). The shell Status
  panel shows **Top models (7d)** as tabulated status rows directly below the Budget line:
  padded model names, right-aligned spend, share percentage, and a budget-style 8-cell
  gauge per row, with an `=` separator under the title (top 5 public names, 7-day window,
  5-min TTL, same triggers as the budget widget, hidden when empty).
- **Per-model usage command** — `/actsis-litellm:usage` reports spend, tokens, and request
  counts aggregated per model via `GET /user/daily/activity`. Args: nothing (last 30 days),
  a day count (`14`), or an inclusive range (`2025-03-01 .. 2025-03-31`, also `to`/`,`/`→`).
  Per-model rows aggregate `results[].breakdown.models` across days, sorted by spend descending;
  totals prefer the endpoint's `metadata` per field, falling back to summed row metrics for any
  missing key. Caveat: LiteLLM only calculates spend for OpenAI-compatible
  `/v1/chat/completions` traffic (`/v1/messages`, passthrough, and unlogged requests report
  zero or are absent).
- **Login labeling fix** — The browser sign-in option is now labeled **"Sign in with OAuth
  (browser)"** and the provider **"Actsis LiteLLM (OAuth)"**: the gateway uses OAuth2 PKCE,
  not SSO. Internal `authMode: "sso"` values are unchanged for stored-credential compatibility.
- **Network error cause reporting** — Failed gateway requests now name the underlying cause hidden inside Node's opaque `TypeError: fetch failed` (DNS `ENOTFOUND`, `ECONNREFUSED`, TLS trust codes like `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, timeouts, resets) with an actionable hint for known classes (e.g. install the issuing CA and restart Node with `--use-system-ca` for internal-CA gateways). Applies to discovery, client registration, token exchange/refresh/revoke, model catalog endpoints and both budget endpoints; catalog network failures stay `CatalogError` so a connectivity problem is never misreported as a rejected API key.
- **Budget & rate-limit status line** — Live budget indicator in pi's status line (`actsis-litellm:budget`, gauge `▰▱`): `GET /key/info` first (nested `info` shape from LiteLLM ≥ 1.100.1 and legacy flat shape), falling back to `GET /user/info` for SSO credentials. Refreshed on session start, after each agent turn, after a rewritten budget or throttling error, and via the new `/actsis-litellm:budget` command. A 403 with a LiteLLM `detail` message is reported as a missing `info_routes` permission (admin action), not as a re-login case.
- **Budget/rate-limit error normalization** — LiteLLM `budget_exceeded` errors are rewritten as actionable top-up/reset messages; `throttling_error` errors append the limit type and reset time. Other 429s pass through to pi's normal retry path.
- **Command namespacing** — Extension commands renamed from `/litellm:*` to `/actsis-litellm:*` to match the provider id and avoid ambiguity with other LiteLLM-based extensions.
- **Provider branding** — The provider shows up in `/login` and the model registry as **Actsis LiteLLM** (auth method `Actsis LiteLLM (SSO)`) instead of the generic "LiteLLM Gateway" label.
- **Zero-config /login flow** — The provider is always registered at startup. If no gateway URL is configured, `/login` asks for the URL, lets you choose between SSO (browser PKCE) and API key, and validates API keys against `GET /v1/models` before storing a synthetic long-lived credential. After any successful login the provider is re-registered with the real base URL so `/model` works immediately.
- **Configuration module** — Gateway base URL resolution: `ACTSIS_LITELLM_URL` → `~/.pi/agent/actsis-litellm.json` → project-local `./.pi/actsis-litellm.user.json` → stored credential (`tokenEndpoint` origin, scheme preserved verbatim) → `/login` prompt. Configurable catalog TTL and request timeout. A trailing `/v1` in the URL is stripped.
- **LiteLLM CLI-OAuth client** — Discovery (`/.well-known/litellm-cli-auth`), dynamic client registration, token exchange, refresh with rotation, revoke, `/v1/models` and `/model/info` endpoints. Redirects are never followed on register/token/revoke.
- **OAuth2 PKCE login** — S256 challenge/verifier, ephemeral `127.0.0.1` loopback callback server, state validation, browser consent (team picker), and credentials mapping to pi's native OAuth credential store.
- **Dynamic provider + catalog sync** — Registers `actsis-litellm` as an `openai-completions` provider; syncs the model catalog from `/v1/models` (with `include_metadata=true`) plus `/model/info` enrichment keyed by `model_name` (paginated `/v2/model/info` fallback, cache schema v2, tiered costs above 128k/200k/272k/512k input tokens, `thinkingLevelMap` from `reasoning_effort_levels`, non-chat model filtering); caches it outside the repo at `~/.pi/agent/actsis-litellm-models-cache.json`; TTL defaults to 15 minutes and is configurable via `catalogTtlMinutes`. Catalog refresh never throws: on fetch/persistence failure pi keeps the last known models.
- **Extra commands** — `/actsis-litellm:status` (credential/cache/provider/budget state), `/actsis-litellm:models` (force catalog resync and report added/removed), `/actsis-litellm:logout` (revoke refresh token and clear local credentials and catalog cache), `/actsis-litellm:budget` (force a budget refresh).
- **Overflow normalization** — LiteLLM context-length errors are surfaced as `context_length_exceeded` via `message_end` so callers can trim and retry.
- **Tests** — Node built-in test runner covering configuration resolution, client contract validation, PKCE generation, OAuth flow, model mapping, catalog caching, commands, budget parsing, limit/overflow normalization, and error handling.
