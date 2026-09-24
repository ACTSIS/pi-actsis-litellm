# pi-actsis-litellm

A [pi.dev](https://pi.dev) extension that adds a **LiteLLM gateway** as a dynamic model provider.

It supports the native `/login` flow using OAuth2 PKCE, discovers the gateway's model catalog at runtime, and routes all chat requests through the OpenAI-compatible `/v1/chat/completions` endpoint.

## Install

```bash
pi install git:github.com/ACTSIS/pi-actsis-litellm
```

Or load it directly for development:

```bash
pi -e .
```

## Configuration

Zero-config by default. Run `/login`, select `actsis-litellm`, enter the gateway base URL, and choose how to sign in.

For non-interactive or headless setups you can still configure the gateway via:

1. Environment variable:
   ```bash
   export ACTSIS_LITELLM_URL=https://your-gateway.example.com
   ```
2. Global config file at `~/.pi/agent/actsis-litellm.json`
3. Project-local config file at `./.pi/actsis-litellm.user.json` (git-ignored)
4. The gateway URL stored with your credential (`tokenEndpoint` origin) from a
   previous successful login
5. The interactive `/login` prompt (last resort)

Resolution follows this exact order at startup. A trailing `/v1` and trailing
slashes in the configured URL are stripped automatically, so
`https://your-gateway.example.com/v1` also works. The stored-credential scheme
is preserved exactly as it was stored at login (an `http://` LAN gateway stays
on `http://`; no automatic upgrade).

Config file schema:

```json
{
  "baseUrl": "https://your-gateway.example.com",
  "providerId": "actsis-litellm",
  "catalogTtlMinutes": 15,
  "requestTimeoutMs": 30000
}
```

Only `baseUrl` is required in the config file. When no URL is configured at startup, the provider is still registered with a placeholder so that `/login` can prompt you for the URL interactively.

## Commands

The provider shows up in pi as **Actsis LiteLLM**, and its sign-in method as **Actsis LiteLLM (SSO)**.

| Command | Description |
|---------|-------------|
| `/login` | pi's native login flow. Once this provider is registered, select `actsis-litellm` to authenticate. |
| `/actsis-litellm:status` | Show provider registration, credential state and source, catalog count, cache age, gateway URL, and a budget summary (stored credentials). |
| `/actsis-litellm:models` | Force a fresh model catalog sync and show added/removed models. |
| `/actsis-litellm:logout` | Revoke the SSO refresh token on the gateway and clear local credentials and cache. |
| `/actsis-litellm:budget` | Force a budget refresh and report the outcome as a notification. |

## Login flow

When you run `/login` and pick `actsis-litellm`:

1. **Gateway URL prompt** — If the gateway URL is not already configured, the extension asks you for it (e.g. `https://gateway.example.com`).
2. **Sign-in method** — Choose **SSO (browser)** or **API key**.
3. **SSO path (browser):**
   - **Discovery** — The extension fetches `/.well-known/litellm-cli-auth` from the gateway.
   - **Dynamic client registration** — A public, loopback-only OAuth client is registered.
   - **PKCE S256** — A local `code_verifier` is generated and hashed into a `code_challenge`.
   - **Browser consent** — Your browser opens the authorization URL. The gateway authenticates you and shows a team/role picker.
   - **Loopback callback** — The gateway redirects to `http://127.0.0.1:<ephemeral>/callback` with an authorization `code` and the original `state`.
   - **Token exchange** — The extension validates `state` and exchanges the `code` for an `access_token` and `refresh_token`.
4. **API key path:**
   - You are prompted for a LiteLLM API key (`sk-...`).
   - The key is validated against `GET {gateway}/v1/models`.
   - A long-lived synthetic OAuth credential is stored so pi treats it like any other credential.
5. **Credential storage** — pi stores the resulting credentials in `~/.pi/agent/auth.json`.
6. **Refresh rotation** — For SSO, every access-token renewal returns a new `refresh_token`; the extension updates the stored credentials automatically. API key credentials do not refresh.
7. **Logout** — `/actsis-litellm:logout` clears local state and, for SSO, sends the `refresh_token` to the gateway's revoke endpoint.

## Model catalog

The provider's model list is synced from the gateway at `/v1/models` (called with `include_metadata=true`) and enriched with details from `/model/info` when available.

- **Cache location:** `~/.pi/agent/actsis-litellm-models-cache.json` (schema version 2; older caches are silently discarded and refetched).
- **Default TTL:** 15 minutes (`catalogTtlMinutes`). A refresh within the TTL window returns the cached list unless forced via `/actsis-litellm:models`.
- **Enrichment keying:** `/model/info` entries are matched to catalog entries by public model name (`model_name`, falling back to `model_info.key`); the opaque `model_info.id` deployment hash is never used for matching. When `/model/info` yields no usable entries or fails, the paginated `/v2/model/info` endpoint is used (page size 100, up to 5 pages).
- **Cost mapping:** LiteLLM input/output costs are mapped to pi cost fields per 1 million tokens, including cache read/write costs and tiered pricing above 128k/200k/272k/512k input tokens when the gateway reports them. Missing or zero values default to `0`.
- **Thinking levels:** `reasoning_effort_levels` from the gateway are mapped to pi's thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) via `thinkingLevelMap`; unsupported levels map to `null`.
- **Chat filtering:** Models with non-chat gateway modes (embedding, transcription, image generation, rerank, moderation, realtime, ...) are excluded. When no mode metadata is available, a conservative name heuristic filters obvious non-chat models.
- **Capabilities:** `supports_vision` adds image input. Every model is registered as reasoning-capable with `supportsDeveloperRole: false` compatibility.
- **Context defaults:** `contextWindow` and `maxTokens` default to `128000` and `16384` when the gateway does not report them.
- **Failure behavior:** Catalog refresh never throws. If the network fetch, cache write, or models-store publish fails, pi keeps showing the last known models; the next refresh retries persistence.
- **Models store:** After each successful sync the catalog is also published to pi's persistent models store, so model metadata (context window, prices) stays fresh in the `/model` picker.
- **Overrides:** You can override any model's metadata via pi's `models.json` `modelOverrides` mechanism.

## Budget & rate-limit status

The extension shows a live budget indicator in pi's status line (key `actsis-litellm:budget`), rendered with the same gauge style as other pi extensions:

```
Budget ▰▰▱▱▱▱▱▱ 25% · $1.00/$4.00      (with a budget cap)
Budget $1.00 used (no cap)              (without a cap)
```

- **Data sources:** `GET {gateway}/key/info` is tried first (supports both the LiteLLM ≥ 1.100.1 nested `{ key, info: {...} }` shape and the older flat shape). If it fails for a non-auth reason (SSO tokens are usually not virtual keys), it falls back to `GET {gateway}/user/info`, which reports user-level spend and budget. A `401`/`403` response does not fall back; it surfaces as a credential or permission error.
- **Permission errors:** A `403` with a LiteLLM `detail` message means the key lacks the `info_routes` permission; the indicator shows a message asking a gateway admin to grant it. Re-login does not fix this case.
- **Refresh triggers:** session start, after each agent turn, after a rewritten budget or throttling error, and the manual `/actsis-litellm:budget` command.
- **API-key credentials:** Query the key's own spend/limits via `/key/info`. SSO credentials: user-level spend via `/user/info` (no per-key TPM/RPM limits are shown).

When a request fails, LiteLLM budget and rate-limit errors are rewritten into actionable messages:

- `budget_exceeded` → `[litellm] Budget exceeded: $X of $Y used — top up the key budget or wait for the reset.`
- `throttling_error` → keeps the original detail and appends `Rate limit reached (<limit type>). Resets at HH:MM (~N min). pi will retry automatically.`
- Other `429`-style errors pass through unchanged; pi's normal retry-with-backoff still applies.

Context-window overflow errors from the gateway are normalized to `context_length_exceeded` so pi can auto-compact the session and retry instead of failing the turn.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Gateway URL not configured | Run `/login`, pick `actsis-litellm`, and enter the gateway URL. Optional: set `ACTSIS_LITELLM_URL` or create `~/.pi/agent/actsis-litellm.json` with `baseUrl`. |
| Credentials rejected by the gateway | For SSO, run `/login` again to obtain fresh tokens. For API key, check the key in the gateway UI and re-run `/login`. |
| Refresh refused (`invalid_grant`) | The SSO refresh token may be expired, rotated by another client, or revoked. Run `/login` again. |
| "Login cancelled" | The prompt or method selector was dismissed. Re-run `/login` and complete all steps. |
| "Login timed out" | The loopback callback window is 5 minutes. If the browser step takes longer, restart `/login`. |
| Models do not appear | Run `/actsis-litellm:models` to force a sync, then check `/actsis-litellm:status` for cache count and provider state. |
| Budget shows "Credential rejected" | The access token expired or was revoked. Run `/login` again. |
| Budget shows "Gateway denied access to budget info (403)" | The key lacks the `info_routes` permission. Ask a gateway admin to grant it; re-login does not help. |
| Budget shows "Budget unavailable" | The gateway could not be reached or returned an unexpected response. Check connectivity, then run `/actsis-litellm:budget` to retry. |
| Budget indicator missing | Only shown when the UI supports extension status lines and spend data exists. Run `/actsis-litellm:budget` to see the concrete reason (no provider, no auth resolution, gateway URL not resolved, or spend data is null). |
| `Budget exceeded: $X of $Y used` | The key's budget cap was hit. Top up the key budget in the gateway UI or wait for the budget reset. |
| `Rate limit reached ... pi will retry automatically` | LiteLLM throttling (TPM/RPM). No action needed; pi retries with backoff until the limit window resets. |
| Context overflow / auto-compaction | Gateway context-window errors are surfaced as `context_length_exceeded` and pi compacts the session automatically. If the error keeps repeating, start a fresh session or pick a larger-context model. |

## Security notes

- The callback server binds to `127.0.0.1` on an ephemeral port only.
- No gateway URL, hostname, IP, token, or user-identifiable data is embedded in the package.
- The stored gateway URL keeps its exact login-time scheme. A gateway advertising `http://` endpoints is only upgraded to `https://` at discovery time and only when you connected via `https://` with the same host and port — never the reverse.
- Token storage is delegated to pi's credential store; the extension does not write credentials to its own files (logout only removes the provider's entry from pi's `auth.json`).
- API keys are validated before storage but are otherwise stored by pi in `~/.pi/agent/auth.json` like any other credential.

For a detailed sequence diagram and security rationale, see [`docs/login-flow.md`](docs/login-flow.md).

## License

MIT — see [`LICENSE`](LICENSE).

---

<p align="center">
  <a href="https://github.com/Gentleman-Programming/gentle-ai">
    <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" />
  </a>
</p>
