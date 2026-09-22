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

| Command | Description |
|---------|-------------|
| `/login` | pi's native login flow. Once this provider is registered, select `actsis-litellm` to authenticate. |
| `/litellm:status` | Show credential state, cache age, and provider status. |
| `/litellm:models` | Force a fresh model catalog sync and show added/removed models. |
| `/litellm:logout` | Revoke the refresh token and clear local credentials. |

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
7. **Logout** — `/litellm:logout` clears local state and, for SSO, sends the `refresh_token` to the gateway's revoke endpoint.

## Model catalog

The provider's model list is synced from the gateway at `/v1/models` and enriched with details from `/model/info` when available.

- **Cache location:** `~/.pi/agent/actsis-litellm-models-cache.json`
- **Default TTL:** 15 minutes (`catalogTtlMinutes`)
- **Force sync:** Run `/litellm:models`
- **Cost mapping:** LiteLLM input/output costs are mapped to pi cost fields per 1 million tokens. Missing or zero values default to `0`.
- **Context defaults:** `contextWindow` and `maxTokens` default to `128000` and `16384` when the gateway does not report them.
- **Overrides:** You can override any model's metadata via pi's `models.json` `modelOverrides` mechanism.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Gateway URL not configured | Run `/login`, pick `actsis-litellm`, and enter the gateway URL. Optional: set `ACTSIS_LITELLM_URL` or create `~/.pi/agent/actsis-litellm.json` with `baseUrl`. |
| Credentials rejected by the gateway | For SSO, run `/login` again to obtain fresh tokens. For API key, check the key in the gateway UI and re-run `/login`. |
| Refresh refused (`invalid_grant`) | The SSO refresh token may be expired, rotated by another client, or revoked. Run `/login` again. |
| "Login cancelled" | The prompt or method selector was dismissed. Re-run `/login` and complete all steps. |
| "Login timed out" | The loopback callback window is 5 minutes. If the browser step takes longer, restart `/login`. |
| Models do not appear | Run `/litellm:models` to force a sync, then check `/litellm:status` for cache count and provider state. |

## Security notes

- The callback server binds to `127.0.0.1` on an ephemeral port only.
- No gateway URL, hostname, IP, token, or user-identifiable data is embedded in the package.
- Token storage is delegated to pi's credential store; the extension itself does not write credentials to disk.
- API keys are validated before storage but are otherwise stored by pi in `~/.pi/agent/auth.json` like any other credential.

For a detailed sequence diagram and security rationale, see [`docs/login-flow.md`](docs/login-flow.md).

## License

MIT — see [`LICENSE`](LICENSE).
