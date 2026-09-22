import http from "node:http";
import type { CliAuthDiscovery } from "./client.ts";
import {
  registerClient,
  exchangeAuthorizationCode,
  type TokenResponse,
} from "./client.ts";
import { generatePkce, randomState } from "./pkce.ts";
import { AuthError } from "./errors.ts";
import type { OAuthLoginCallbacks, OAuthCredentials } from "@earendil-works/pi-ai/compat";

const CALLBACK_HTML = "Signed in to LiteLLM. You can close this window and return to the terminal.";
const OVERALL_TIMEOUT_MS = 5 * 60 * 1000;

export class LoopbackCallbackServer {
  private server: http.Server | null = null;
  private resolveCallback: ((url: string) => void) | null = null;
  private rejectCallback: ((err: Error) => void) | null = null;
  private pendingCallbackUrl: string | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  start(): Promise<{ port: number }> {
    if (this.started) {
      return Promise.reject(new AuthError("Loopback callback server already started"));
    }
    this.started = true;

    return new Promise<{ port: number }>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const fullUrl = new URL(req.url, `http://127.0.0.1:${this.addressPort()}`);
        if (fullUrl.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(CALLBACK_HTML);

        if (this.resolveCallback) {
          this.resolveCallback(fullUrl.toString());
          this.resolveCallback = null;
          this.rejectCallback = null;
        } else {
          // No waiter attached yet; buffer the first callback so a fast
          // browser redirect is not lost.
          this.pendingCallbackUrl = fullUrl.toString();
        }
        this.stop();
      });

      this.server.on("error", (err) => {
        this.started = false;
        if (this.rejectCallback) {
          this.rejectCallback(err);
        } else {
          reject(err);
        }
      });

      this.server.listen({ host: "127.0.0.1", port: 0 }, () => {
        this.timeout = setTimeout(() => {
          this.stop();
          if (this.rejectCallback) {
            this.rejectCallback(
              new AuthError("Login timed out after 5 minutes. Run /login again."),
            );
          }
        }, OVERALL_TIMEOUT_MS);
        resolve({ port: this.addressPort() });
      });
    });
  }

  waitForCallback(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.pendingCallbackUrl !== null) {
        resolve(this.pendingCallbackUrl);
        this.pendingCallbackUrl = null;
        return;
      }
      this.resolveCallback = resolve;
      this.rejectCallback = reject;
    });
  }

  stop(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.server) {
      this.server.close(() => {});
      this.server = null;
    }
    this.started = false;
  }

  private addressPort(): number {
    if (!this.server) return 0;
    const addr = this.server.address();
    if (addr && typeof addr === "object") return addr.port;
    return 0;
  }
}

export function parseCallbackParams(callbackUrl: string): {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
} {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;
  const errorDescription = url.searchParams.get("error_description") ?? undefined;
  return { code, state, error, errorDescription };
}

export interface GatewaySessionData {
  userId?: string;
  teamId?: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  resource: string;
}

export async function runLoginFlow(
  config: { requestTimeoutMs: number },
  discovery: CliAuthDiscovery,
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const server = new LoopbackCallbackServer();
  try {
    const { port } = await server.start();
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const { clientId } = await registerClient(
      discovery,
      redirectUri,
      config.requestTimeoutMs,
    );

    const { verifier, challenge } = generatePkce();
    const state = randomState();

    const callbackUrlPromise = server.waitForCallback();

    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: discovery.resource,
    });
    const authorizeUrl = `${discovery.authorizationEndpoint}?${authorizeParams.toString()}`;

    callbacks.onAuth({ url: authorizeUrl });
    callbacks.onProgress?.("Waiting for browser sign-in...");

    const callbackUrl = await callbackUrlPromise;
    const params = parseCallbackParams(callbackUrl);

    if (params.error) {
      throw new AuthError(
        params.errorDescription
          ? `Authorization failed: ${params.error} — ${params.errorDescription}`
          : `Authorization failed: ${params.error}`,
      );
    }
    if (!params.code) {
      throw new AuthError("Authorization response did not include a code");
    }
    if (params.state !== state) {
      throw new AuthError("Authorization state mismatch");
    }

    const tokenResponse: TokenResponse = await exchangeAuthorizationCode(
      discovery,
      {
        code: params.code,
        redirectUri,
        clientId,
        codeVerifier: verifier,
      },
      config.requestTimeoutMs,
    );

    const expires =
      Date.now() +
      Math.max(tokenResponse.expiresIn - 300, 60) * 1000;

    return {
      refresh: tokenResponse.refreshToken ?? "",
      access: tokenResponse.accessToken,
      expires,
      userId: tokenResponse.userId,
      teamId: tokenResponse.teamId,
      clientId,
      tokenEndpoint: discovery.tokenEndpoint,
      revocationEndpoint: discovery.revocationEndpoint,
      resource: discovery.resource,
    } as OAuthCredentials;
  } finally {
    server.stop();
  }
}
