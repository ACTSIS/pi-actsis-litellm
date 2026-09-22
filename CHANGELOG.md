# Changelog

## 0.1.0 — Unreleased

- **Provider branding** — The provider shows up in `/login` and the model registry as **Actsis LiteLLM** (auth method `Actsis LiteLLM (SSO)`) instead of the generic "LiteLLM Gateway" label.
- **Zero-config /login flow** — The provider is always registered at startup. If no gateway URL is configured, `/login` asks for the URL, lets you choose between SSO (browser PKCE) and API key, and validates API keys against `GET /v1/models` before storing a synthetic long-lived credential. After any successful login the provider is re-registered with the real base URL so `/model` works immediately.
- **Configuration module** — Runtime-only gateway base URL resolution via `ACTSIS_LITELLM_URL`, optional global config (`~/.pi/agent/actsis-litellm.json`), optional project-local config, or `/login` prompt. Configurable catalog TTL and request timeout.
- **LiteLLM CLI-OAuth client** — Discovery (`/.well-known/litellm-cli-auth`), dynamic client registration, token exchange, refresh with rotation, revoke, `/v1/models` and `/model/info` endpoints. Redirects are never followed on register/token/revoke.
- **OAuth2 PKCE login** — S256 challenge/verifier, ephemeral `127.0.0.1` loopback callback server, state validation, browser consent (team picker), and credentials mapping to pi's native OAuth credential store.
- **Dynamic provider + catalog sync** — Registers `actsis-litellm` as an `openai-completions` provider; syncs the model catalog from `/v1/models` plus `/model/info` enrichment; caches it outside the repo at `~/.pi/agent/actsis-litellm-models-cache.json`; TTL defaults to 15 minutes and is configurable via `catalogTtlMinutes`.
- **Extra commands** — `/litellm:status` (credential/cache/provider state), `/litellm:models` (force catalog resync and report added/removed), `/litellm:logout` (revoke refresh token and clear local credentials).
- **Overflow normalization** — LiteLLM context-length errors are surfaced as `context_length_exceeded` via `message_end` so callers can trim and retry.
- **Tests** — Node built-in test runner covering configuration resolution, client contract validation, PKCE generation, OAuth flow, model mapping, catalog caching, commands, and error handling.
