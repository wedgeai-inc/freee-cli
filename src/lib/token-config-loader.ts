import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeTokenStoreUpdateError, OnePasswordTokenStore, type OAuthTokenBundle, type TokenStoreUpdateError } from "./one-password-token-store.js";
import { withTokenRefreshLock } from "./token-refresh-lock.js";

interface FreeeTokenFile {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

interface FreeeConfigFile {
  clientId?: string;
  clientSecret?: string;
  defaultCompanyId?: number;
  currentCompanyId?: number;
}

export interface ReadonlyAuthResult {
  mode: "env" | "config" | "onepassword";
  accessToken: string;
  defaultCompanyId?: number;
  currentCompanyId?: number;
}

export interface LoaderDeps {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  readTextFile?: (path: string) => string;
  writeTextFile?: (path: string, data: string) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
  profile?: string;
  tokenStore?: Pick<OnePasswordTokenStore, "load" | "save">;
  createTokenStore?: () => Pick<OnePasswordTokenStore, "load" | "save">;
  /** Directory for per-profile refresh lock files (default ~/.cache/freee-cli). */
  lockDir?: string;
}

const FREEE_TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token";
const EXPIRY_SKEW_MS = 60_000;

export function loadReadonlyAuth(deps: LoaderDeps = {}): ReadonlyAuthResult {
  const env = deps.env ?? process.env;
  const envToken = env.FREEE_ACCESS_TOKEN;
  if (envToken !== undefined) {
    if (envToken.trim().length === 0) throw new Error("FREEE_ACCESS_TOKEN is empty.");
    return {
      mode: "env",
      accessToken: envToken,
    };
  }

  const configDir = deps.configDir ?? join(homedir(), ".config", "freee-mcp");
  const readTextFile = deps.readTextFile ?? ((path: string) => readFileSync(path, "utf-8"));

  const tokens = JSON.parse(readTextFile(join(configDir, "tokens.json"))) as FreeeTokenFile;
  const config = JSON.parse(readTextFile(join(configDir, "config.json"))) as FreeeConfigFile;

  return {
    mode: "config",
    accessToken: tokens.access_token,
    defaultCompanyId: config.defaultCompanyId,
    currentCompanyId: config.currentCompanyId,
  };
}

export async function loadApiAuth(deps: LoaderDeps = {}): Promise<ReadonlyAuthResult> {
  const env = deps.env ?? process.env;
  const envToken = env.FREEE_ACCESS_TOKEN;
  if (envToken !== undefined) {
    if (envToken.trim().length === 0) throw new Error("FREEE_ACCESS_TOKEN is empty.");
    return {
      mode: "env",
      accessToken: envToken,
    };
  }

  // The file loader remains available only to its explicitly injected legacy
  // callers. Normal CLI execution has no plaintext token-file fallback.
  // Validate the switch before any expiry decision, so a typo fails even while the token is valid.
  assertTokenRefreshSettingValid(env);
  if (deps.tokenStore || (deps.configDir === undefined && deps.readTextFile === undefined)) {
    return loadOnePasswordApiAuth(deps, env);
  }

  const configDir = deps.configDir ?? join(homedir(), ".config", "freee-mcp");
  const readTextFile = deps.readTextFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const writeTextFile = deps.writeTextFile ?? ((path: string, data: string) => writeFileSync(path, data));
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;

  const tokenPath = join(configDir, "tokens.json");
  const rawTokens = readTextFile(tokenPath);
  const tokens = JSON.parse(rawTokens) as FreeeTokenFile;
  const config = JSON.parse(readTextFile(join(configDir, "config.json"))) as FreeeConfigFile;

  if (!isExpired(tokens, now())) {
    return {
      mode: "config",
      accessToken: tokens.access_token,
      defaultCompanyId: config.defaultCompanyId,
      currentCompanyId: config.currentCompanyId,
    };
  }

  assertTokenRefreshEnabled(env, { kind: "file" });
  if (!tokens.refresh_token) {
    throw new Error("freee access token expired. Run freee MCP authentication again.");
  }

  const clientCredential = resolveClientCredential(env, config);
  // Write the current file back and read it again before spending the refresh token.
  let writable = false;
  try {
    writeTextFile(tokenPath, rawTokens);
    writable = readTextFile(tokenPath) === rawTokens;
  } catch {
    writable = false;
  }
  if (!writable) {
    throw new Error("tokens.jsonへ書き込めないため、tokenを更新しませんでした（refresh tokenは使っていません）。");
  }

  const refreshed = await refreshToken({
    tokens,
    ...clientCredential,
    fetchFn,
  });
  writeTextFile(tokenPath, `${JSON.stringify({ ...tokens, ...refreshed }, null, 2)}\n`);

  return {
    mode: "config",
    accessToken: refreshed.access_token,
    defaultCompanyId: config.defaultCompanyId,
    currentCompanyId: config.currentCompanyId,
  };
}

async function loadOnePasswordApiAuth(deps: LoaderDeps, env: NodeJS.ProcessEnv): Promise<ReadonlyAuthResult> {
  const profile = deps.profile ?? env.FREEE_OAUTH_PROFILE ?? "default";
  const store = deps.tokenStore ?? deps.createTokenStore?.() ?? new OnePasswordTokenStore();
  const now = deps.now ?? Date.now;
  const tokens = await store.load(profile);
  if (tokens.expiresAt > now() + EXPIRY_SKEW_MS) {
    return { mode: "onepassword", accessToken: tokens.accessToken };
  }

  assertTokenRefreshEnabled(env, { kind: "expired-onepassword", profile });
  return withTokenRefreshLock(profile, { lockDir: deps.lockDir }, async () => {
    // Re-read under the lock: another process may have rotated the bundle meanwhile,
    // and writing back a stale bundle in the write check would discard its rotation.
    const current = await store.load(profile);
    if (current.expiresAt > now() + EXPIRY_SKEW_MS) {
      return { mode: "onepassword" as const, accessToken: current.accessToken };
    }
    const refreshed = await refreshOnePasswordTokenForProfile(current, env, deps.fetchFn ?? fetch, now(), profile, store);
    // Awaiting save before return is deliberate: freee refresh tokens are single-use.
    try {
      await store.save(profile, refreshed);
    } catch (error) {
      throw sanitizeTokenStoreUpdateError(error);
    }
    return { mode: "onepassword" as const, accessToken: refreshed.accessToken };
  });
}

/** The token store could not be written, so the refresh token was not used. Carries only sanitized diagnostics. */
export class TokenStoreNotWritableError extends Error {
  readonly diagnostic: TokenStoreUpdateError;

  constructor(cause: unknown) {
    super(
      "1Passwordのtoken保存先へ書き込めないため、tokenを更新しませんでした（refresh tokenは使っていません）。" +
      "1Passwordへ書き込める環境で実行するか、この環境にFREEE_TOKEN_REFRESH=disabledを設定してください。",
    );
    this.diagnostic = sanitizeTokenStoreUpdateError(cause);
  }
}

const INVALID_REFRESH_SETTING_MESSAGE =
  "FREEE_TOKEN_REFRESHの値が不正です。未設定・enabled・disabledのいずれかを指定してください。tokenは更新しません。";

/**
 * FREEE_TOKEN_REFRESH: unset / "" / "enabled" keeps the default refresh behavior.
 * "disabled" forbids refresh (for environments that cannot write the token store,
 * where a refresh would consume the single-use refresh token without saving it).
 * Any other value fails closed so a typo never triggers an unintended refresh.
 * The raw value is never echoed.
 */
export function assertTokenRefreshSettingValid(env: NodeJS.ProcessEnv): void {
  const value = env.FREEE_TOKEN_REFRESH;
  if (value === undefined || value === "" || value === "enabled" || value === "disabled") return;
  throw new Error(INVALID_REFRESH_SETTING_MESSAGE);
}

export type TokenRefreshContext =
  | { kind: "expired-onepassword"; profile: string }
  | { kind: "file" }
  | { kind: "command" };

export function assertTokenRefreshEnabled(env: NodeJS.ProcessEnv, context: TokenRefreshContext): void {
  assertTokenRefreshSettingValid(env);
  if (env.FREEE_TOKEN_REFRESH !== "disabled") return;
  if (context.kind === "command") {
    throw new Error(
      "FREEE_TOKEN_REFRESH=disabledのため、この環境ではtokenの更新を禁止しています。tokenは更新していません。" +
      "1Passwordへ書き込める端末で実行してください。",
    );
  }
  const expired = "freeeのaccess tokenの期限が切れています（または60秒以内に切れます）。" +
    "FREEE_TOKEN_REFRESH=disabledのため、この環境ではtokenを更新しません。";
  if (context.kind === "file") {
    throw new Error(
      `${expired}ファイルに保存したtokenはこのCLIのauthコマンドでは更新できません。` +
      "tokens.jsonへ書き込める環境で認証をやり直してから、もう一度実行してください。",
    );
  }
  throw new Error(
    `${expired}tokenを保存できる端末で \`freee auth refresh --profile ${context.profile}\` を実行してから、もう一度実行してください。`,
  );
}

/**
 * Refresh a 1Password-held bundle; an invalid refresh token maps to re-login guidance.
 * Before spending the single-use refresh token, writes the current bundle back through
 * `store.save` (which reads it back and compares); if that fails, nothing is refreshed.
 * Does not save the refreshed bundle.
 */
export async function refreshOnePasswordTokenForProfile(
  tokens: OAuthTokenBundle,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  nowMs: number,
  profile: string,
  store: Pick<OnePasswordTokenStore, "save">,
): Promise<OAuthTokenBundle> {
  const credentials = resolveClientCredential(env, {});
  try {
    await store.save(profile, tokens);
  } catch (error) {
    throw new TokenStoreNotWritableError(error);
  }
  try {
    return await refreshOnePasswordToken(tokens, credentials, fetchFn, nowMs);
  } catch (error) {
    if (error instanceof InvalidRefreshError) {
      throw new Error(`freee OAuth refresh is invalid. Run freee auth login --profile ${profile}.`);
    }
    throw error;
  }
}

class InvalidRefreshError extends Error {}

async function refreshOnePasswordToken(
  tokens: OAuthTokenBundle,
  credentials: { clientId: string; clientSecret: string },
  fetchFn: typeof fetch,
  nowMs: number,
): Promise<OAuthTokenBundle> {
  let response: Response;
  try {
    response = await fetchFn(FREEE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: tokens.refreshToken,
      }).toString(),
    });
  } catch {
    throw new Error("freee token refresh request failed");
  }
  if (response.status === 400 || response.status === 401) throw new InvalidRefreshError();
  if (!response.ok) throw new Error(`freee token refresh failed: ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("freee token refresh returned an invalid response");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("freee token refresh returned an invalid response");
  }
  const record = payload as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (
    typeof record.access_token !== "string" || record.access_token.trim().length === 0 ||
    typeof record.refresh_token !== "string" || record.refresh_token.trim().length === 0 ||
    typeof record.expires_in !== "number" || !Number.isFinite(record.expires_in) ||
    record.expires_in <= 0 || record.expires_in > 21_600
  ) throw new Error("freee token refresh returned an invalid response");
  return {
    accessToken: record.access_token.trim(),
    refreshToken: record.refresh_token.trim(),
    expiresAt: nowMs + record.expires_in * 1000,
  };
}

function isExpired(tokens: FreeeTokenFile, nowMs: number): boolean {
  return typeof tokens.expires_at === "number" && tokens.expires_at <= nowMs + EXPIRY_SKEW_MS;
}

function resolveClientCredential(
  env: NodeJS.ProcessEnv,
  config: FreeeConfigFile,
): { clientId: string; clientSecret: string } {
  const envClientId = env.FREEE_CLIENT_ID;
  const envClientSecret = env.FREEE_CLIENT_SECRET;
  const hasEnvClientId = envClientId !== undefined;
  const hasEnvClientSecret = envClientSecret !== undefined;

  if (hasEnvClientId || hasEnvClientSecret) {
    if (!envClientId || !envClientSecret) {
      throw new Error("freee client credential environment is incomplete.");
    }

    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  if (!config.clientId || !config.clientSecret) {
    throw new Error("freee access token expired. Run freee MCP authentication again.");
  }

  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

async function refreshToken(params: {
  tokens: FreeeTokenFile;
  clientId: string;
  clientSecret: string;
  fetchFn: typeof fetch;
}): Promise<FreeeTokenFile> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.tokens.refresh_token ?? "",
  });

  const response = await params.fetchFn(FREEE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`freee token refresh failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    created_at?: number;
    scope?: string;
  };

  const createdAt = typeof payload.created_at === "number" ? payload.created_at : Math.floor(Date.now() / 1000);
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 86_400;

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? params.tokens.refresh_token,
    token_type: payload.token_type ?? params.tokens.token_type,
    expires_at: (createdAt + expiresIn) * 1000,
    scope: payload.scope ?? params.tokens.scope,
  };
}
