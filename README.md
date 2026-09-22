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
| `/litellm:status` | Show credential state, cache age, and provider status. |
| `/litellm:models` | Force a fresh model catalog sync and show added/removed models. |
| `/litellm:logout` | Revoke the refresh token and clear local credentials. |

## Authentication

- Run `/login` and select the LiteLLM provider.
- The extension opens a local loopback callback, completes the OAuth2 PKCE exchange, and stores the credentials in pi's secure credential store (`~/.pi/agent/auth.json`).
- Refresh tokens are rotated on every renewal.

## Security notes

- The callback server binds to `127.0.0.1` on an ephemeral port only.
- No gateway URL, hostname, IP, token, or user-identifiable data is embedded in the package.
- Token storage is delegated to pi's credential store; the extension itself does not write credentials to disk.

## License

TBD
