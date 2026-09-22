import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exchangeAuthorizationCode, type RuntimeOAuthConfig } from "../../lib/runtime-oauth.js";
import { createRuntimeOAuthHandler } from "../../lib/runtime-oauth-http.js";
import { RuntimeOAuthGate } from "../../lib/runtime-oauth-session.js";
import type { OAuthTokenBundle } from "../../lib/one-password-token-store.js";

const REDIRECT_URI = "http://127.0.0.1:54321/callback";
const START_URL = "http://127.0.0.1:54321/start";
const AUTH_TIMEOUT_MS = 15 * 60 * 1000;

export interface OAuthLoginStore {
  save(profile: string, bundle: OAuthTokenBundle): Promise<void>;
}

export async function persistInitialOAuthTokens(
  store: OAuthLoginStore,
  profile: string,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
  now: () => number = Date.now,
): Promise<void> {
  if (!Number.isFinite(tokens.expiresIn) || tokens.expiresIn <= 0 || tokens.expiresIn > 21_600) {
    throw new Error("freee OAuth token exchange returned an invalid response");
  }
  try {
    await store.save(profile, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: now() + tokens.expiresIn * 1000,
    });
  } catch {
    throw new Error("freee OAuth token store could not be updated");
  }
}

/**
 * 認可成功後の処理。保存が完了するまで onStarted（＝利用者への成功通知）を呼ばない。
 * 順序を結合点で固定できるように切り出してある。
 */
export function createLoginExecutor(
  store: OAuthLoginStore,
  profile: string,
  now: () => number = Date.now,
): (
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  signal: AbortSignal | undefined,
  onStarted: () => void,
) => Promise<void> {
  return async (accessToken, refreshToken, expiresIn, _signal, onStarted) => {
    await persistInitialOAuthTokens(store, profile, { accessToken, refreshToken, expiresIn }, now);
    onStarted();
  };
}

export function runOAuthLogin(params: {
  profile: string;
  clientId: string;
  clientSecret: string;
  store: OAuthLoginStore;
  onLog?: (message: string) => void;
}): void {
  const onLog = params.onLog ?? ((message: string) => console.error(message));
  const config: RuntimeOAuthConfig = {
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    redirectUri: REDIRECT_URI,
    state: randomBytes(32).toString("base64url"),
  };
  const gate = new RuntimeOAuthGate(config.state);
  let timeout: NodeJS.Timeout;
  let server: ReturnType<typeof createServer>;
  const close = () => {
    clearTimeout(timeout);
    server.close();
    if (gate.phase === "failed" || gate.phase === "timed_out") process.exitCode = 1;
  };
  server = createServer(createRuntimeOAuthHandler({
    expectedHost: "127.0.0.1:54321",
    startUrl: START_URL,
    config,
    gate,
    exchangeFn: (code, signal) => exchangeAuthorizationCode(config, code, fetch, signal),
    executeFn: createLoginExecutor(params.store, params.profile),
    onClose: close,
    onLog,
  }));
  server.on("error", () => { onLog("freee OAuth listener failed to start"); clearTimeout(timeout); process.exitCode = 1; });
  server.listen(54321, "127.0.0.1", () => console.log(`freee OAuth listener ready: ${START_URL}`));
  timeout = setTimeout(() => { gate.timeout(); onLog("freee OAuth authorization timed out before token storage"); server.close(); process.exitCode = 1; }, AUTH_TIMEOUT_MS);
}
