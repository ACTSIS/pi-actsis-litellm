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

The gateway base URL is resolved at runtime only. Configure it via **one** of:

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

Only `baseUrl` is required. If it is missing from environment and config files, the `/login` flow will prompt you for the gateway URL.

## Commands

| Command | Description |
|---------|-------------|
| `/login` | pi's native login flow. Once this provider is registered, select `actsis-litellm` to authenticate. |
| `/litellm:status` | Show credential state, cache age, and provider status. |
| `/litellm:models` | Force a fresh model catalog sync and show added/removed models. |
| `/litellm:logout` | Revoke the refresh token and clear local credentials. |

## Login flow

When you run `/login` and pick `actsis-litellm`:

1. **Discovery** — The extension fetches `/.well-known/litellm-cli-auth` from the configured gateway to discover the OAuth endpoints.
2. **Dynamic client registration** — A public, loopback-only OAuth client is registered with the gateway.
3. **PKCE S256** — A local `code_verifier` is generated and hashed into a `code_challenge`.
4. **Browser consent** — Your browser opens the authorization URL. The gateway authenticates you and shows a team/role picker.
5. **Loopback callback** — After consent, the gateway redirects to `http://127.0.0.1:<ephemeral>/callback` with a single-use authorization `code` and the original `state`.
6. **Token exchange** — The extension validates `state` and exchanges the `code` for an `access_token` and `refresh_token`.
7. **Credential storage** — pi stores the credentials in `~/.pi/agent/auth.json`.
8. **Refresh rotation** — On every renewal the gateway returns a new `refresh_token`; the extension updates the stored credentials automatically.
9. **Logout** — `/litellm:logout` sends the current `refresh_token` to the gateway's revoke endpoint and clears the pi credential entry.

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
| Gateway URL not configured | Set `ACTSIS_LITELLM_URL`, create `~/.pi/agent/actsis-litellm.json` with `baseUrl`, or let `/login` prompt you. |
| Credentials rejected by the gateway | Run `/login` again to obtain fresh tokens. |
| Refresh refused (`invalid_grant`) | The refresh token may be expired, rotated by another client, or revoked. Run `/login` again. |
| "Login timed out" | The loopback callback window is 5 minutes. If the browser step takes longer, restart `/login`. |
| Models do not appear | Run `/litellm:models` to force a sync, then check `/litellm:status` for cache count and provider state. |

## Security notes

- The callback server binds to `127.0.0.1` on an ephemeral port only.
- No gateway URL, hostname, IP, token, or user-identifiable data is embedded in the package.
- Token storage is delegated to pi's credential store; the extension itself does not write credentials to disk.

For a detailed sequence diagram and security rationale, see [`docs/login-flow.md`](docs/login-flow.md).

## License

MIT — see [`LICENSE`](LICENSE).
