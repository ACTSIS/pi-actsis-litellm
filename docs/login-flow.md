# Login flow

This document describes the OAuth2 PKCE login flow used by the `pi-actsis-litellm` extension and the security controls that protect credentials.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant PI as pi (extension)
    participant B as Browser
    participant LB as 127.0.0.1 loopback callback
    participant GW as LiteLLM gateway

    U->>PI: Run /login, pick actsis-litellm
    PI->>U: Prompt for gateway base URL
    alt URL is not already configured
        U-->>PI: Enter gateway URL
    end
    PI->>U: Choose sign-in method: SSO or API key
    alt User chooses SSO
        PI->>GW: GET /.well-known/litellm-cli-auth
        GW-->>PI: Discovery document (authorize, token, register, revoke)
        PI->>PI: Generate PKCE code_verifier + code_challenge (S256) + state
        PI->>GW: POST /client/register (public client, redirect loopback only)
        GW-->>PI: client_id (dynamic public client)
        PI->>LB: Start loopback callback server on 127.0.0.1 ephemeral port
        PI->>B: Open authorize URL + code_challenge + state + resource param
        B->>GW: User authenticates and consents (team picker)
        GW-->>B: Authorization code via redirect to loopback callback
        B->>LB: GET /callback?code=...&state=...
        LB->>PI: Return code + state
        PI->>PI: Validate state matches
        PI->>GW: POST token endpoint (code + code_verifier + client_id)
        GW-->>PI: access_token, refresh_token, expires_in, token metadata
    else User chooses API key
        PI->>U: Prompt for LiteLLM API key (sk-...)
        U-->>PI: Enter API key
        PI->>GW: GET /v1/models with Authorization: Bearer key
        GW-->>PI: 200 OK (key is valid)
        PI->>PI: Synthesize long-lived OAuth credential (authMode: api_key)
    end
    PI->>PI: Map credentials to pi OAuthCredentials
    PI->>PI: Persist via pi credential store (~/.pi/agent/auth.json)
    PI-->>U: Login complete

    Note over PI,GW: SSO refresh: access token renewed using refresh_token;<br/>new refresh_token rotated and persisted automatically.<br/>API key: no refresh; synthetic credential is long-lived.
    Note over PI,GW: Logout: POST revoke endpoint with refresh_token for SSO;<br/>API key mode skips revocation. Local credentials are cleared.
```

## Step-by-step explanation

1. **URL prompt (if needed)** — When no gateway URL is known from environment, config file, or a previous credential, `/login` asks for the gateway base URL first.
2. **Method selector** — The user chooses **SSO (browser)** or **API key**.
3. **SSO path only:**
   - **Discovery** — The extension fetches `/.well-known/litellm-cli-auth` to learn the OAuth endpoints.
   - **Scheme adaptation (discovery only)** — If the gateway advertises `http://` endpoints while the configured URL is `https://` on the same host and port, the extension upgrades the announced endpoints to `https://` (never the reverse) and notifies: "Gateway advertises http:// endpoints; using https:// (scheme upgrade applied)." Endpoints on any other origin are rejected. Runtime calls after login always use the gateway URL exactly as the user configured it, including its scheme.
   - **Dynamic client registration** — A public, loopback-only client is registered on demand. No client secret is involved.
   - **PKCE S256** — The extension generates a local `code_verifier`, hashes it into a `code_challenge`, and sends only the challenge to the authorize endpoint.
   - **Browser consent** — The user's browser opens the authorize URL. The gateway authenticates the user and presents a team/role picker.
   - **Loopback callback** — The gateway redirects to `http://127.0.0.1:<ephemeral>/callback` with a single-use authorization `code` and the original `state`.
   - **Token exchange** — The extension validates `state`, then exchanges the `code` and `code_verifier` for an `access_token` and `refresh_token`.
4. **API key path only:**
   - The user enters a LiteLLM API key.
   - The extension validates the key with `GET {gateway}/v1/models`.
   - On success it stores a synthetic, long-lived OAuth credential (`authMode: api_key`) with a 10-year expiry so pi treats it like any other credential. The credential records `tokenEndpoint: {gateway}/token`, which is how the stored gateway URL is later recovered for runtime configuration.
5. **Credential storage** — Tokens are passed to pi's native credential store (`~/.pi/agent/auth.json`); the extension does not write credentials to its own files.
6. **Refresh rotation** — For SSO, every access-token renewal returns a new `refresh_token`; the extension updates the stored credentials immediately. The stored access-token expiry is set to `now + max(expires_in - 300, 60)` seconds, so renewal starts before the real expiry. API key credentials never refresh; refreshing one returns an unchanged copy.
7. **Logout** — `/actsis-litellm:logout` calls the revoke endpoint with the current `refresh_token` for SSO, clears the pi credential entry, and removes the model-catalog cache. API key mode skips remote revocation because there is no refresh token.

## Security notes

- **Loopback-only redirect.** The callback server binds to `127.0.0.1` on an ephemeral port and accepts only the exact `/callback` route. No external network interface is used.
- **Code single-use.** The authorization code is exchanged immediately and cannot be replayed.
- **No secrets in the repository.** The package contains no gateway URL, hostname, IP, client secret, token, or user identity.
- **Refresh rotation.** Each successful refresh returns a new refresh token; the old one is discarded and the new one is persisted via pi.
- **Revoke on logout.** Logout tells the gateway to invalidate the refresh token server-side in addition to clearing local state.
- **Credential storage delegated to pi.** The extension never writes tokens to its own cache or configuration files; pi's credential store is responsible for file permissions and encryption.
- **Scheme discipline.** Discovery-time adaptation only upgrades `http` → `https` within the same host when the base URL is already `https`; it never downgrades. Redirect responses on register/token/revoke are never followed, preventing credential leakage to a different origin. After login, runtime calls preserve the stored credential's scheme verbatim (non-TLS LAN gateways keep working on `http://`).
- **API key validation.** API keys are checked against the gateway before storage, but they are otherwise stored by pi in `~/.pi/agent/auth.json` like any other credential. Treat them as secrets.
