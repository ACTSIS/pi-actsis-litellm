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
    PI->>PI: Map credentials to pi OAuthCredentials
    PI->>PI: Persist via pi credential store (~/.pi/agent/auth.json)
    PI-->>U: Login complete

    Note over PI,GW: Refresh: access token renewed using refresh_token;<br/>new refresh_token rotated and persisted automatically.
    Note over PI,GW: Logout: POST revoke endpoint with refresh_token;<br/>server invalidates token and local credentials are cleared.
```

## Step-by-step explanation

1. **Discovery** — The extension reads the gateway base URL from `ACTSIS_LITELLM_URL`, a config file, or the `/login` prompt, then fetches `/.well-known/litellm-cli-auth` to learn the OAuth endpoints.
2. **Dynamic client registration** — A public, loopback-only client is registered on demand. No client secret is involved.
3. **PKCE S256** — The extension generates a local `code_verifier`, hashes it into a `code_challenge`, and sends only the challenge to the authorize endpoint.
4. **Browser consent** — The user's browser opens the authorize URL. The gateway authenticates the user and presents a team/role picker (the browser-side consent step).
5. **Loopback callback** — The gateway redirects to `http://127.0.0.1:<ephemeral>/callback` with a single-use authorization `code` and the original `state`.
6. **Token exchange** — The extension validates `state`, then exchanges the `code` and `code_verifier` for an `access_token` and `refresh_token`.
7. **Credential storage** — Tokens are passed to pi's native credential store (`~/.pi/agent/auth.json`); the extension does not write credentials to its own files.
8. **Refresh rotation** — On every access-token renewal the gateway returns a new `refresh_token`; the extension updates the stored credentials immediately.
9. **Logout** — `/litellm:logout` calls the revoke endpoint with the current `refresh_token` and clears the pi credential entry.

## Security notes

- **Loopback-only redirect.** The callback server binds to `127.0.0.1` on an ephemeral port and accepts only the exact `/callback` route. No external network interface is used.
- **Code single-use.** The authorization code is exchanged immediately and cannot be replayed.
- **No secrets in the repository.** The package contains no gateway URL, hostname, IP, client secret, token, or user identity.
- **Refresh rotation.** Each successful refresh returns a new refresh token; the old one is discarded and the new one is persisted via pi.
- **Revoke on logout.** Logout tells the gateway to invalidate the refresh token server-side in addition to clearing local state.
- **Credential storage delegated to pi.** The extension never writes tokens to its own cache or configuration files; pi's credential store is responsible for file permissions and encryption.
