import { assertTokenRefreshEnabled, refreshOnePasswordTokenForProfile } from "../../lib/token-config-loader.js";
import { sanitizeTokenStoreUpdateError, type OnePasswordTokenStore, type TokenStoreUpdateError } from "../../lib/one-password-token-store.js";

/** The refresh succeeded but the rotated bundle could not be stored. Carries only sanitized diagnostics. */
export class RefreshedTokenNotSavedError extends Error {
  readonly diagnostic: TokenStoreUpdateError;

  constructor(profile: string, cause: unknown) {
    super(
      "新しいtokenは1Passwordに保存されていません。refresh tokenは使用済みの可能性があるため、" +
      `\`freee auth login --profile ${profile}\` で再認可してください。`,
    );
    this.diagnostic = sanitizeTokenStoreUpdateError(cause);
  }
}

export interface OAuthRefreshParams {
  profile: string;
  env: NodeJS.ProcessEnv;
  store: Pick<OnePasswordTokenStore, "load" | "save">;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** Refresh the stored token bundle regardless of expiry and save it (with the store's read-back check). */
export async function runOAuthRefresh(params: OAuthRefreshParams): Promise<string> {
  const { profile, env, store } = params;
  assertTokenRefreshEnabled(env, profile);
  const now = params.now ?? Date.now;
  const tokens = await store.load(profile);
  const refreshed = await refreshOnePasswordTokenForProfile(tokens, env, params.fetchFn ?? fetch, now(), profile);
  try {
    await store.save(profile, refreshed);
  } catch (error) {
    throw new RefreshedTokenNotSavedError(profile, error);
  }
  return `freeeのtokenを更新し、1Passwordに保存しました（profile: ${profile}、有効期限: ${new Date(refreshed.expiresAt).toISOString()}）`;
}
