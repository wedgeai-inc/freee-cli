const FREEE_AUTHORIZE_URL = "https://accounts.secure.freee.co.jp/public_api/authorize";
const FREEE_TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token";
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 21_600;
const SAFE_CHILD_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"] as const;
const LEGACY_EXPORT_SUBCOMMANDS = new Set([
  "journals",
  "receipts",
  "wallet-txns",
  "expense-applications",
]);

const RUNTIME_PLAN_ALLOWLIST: ReadonlyArray<readonly [string, string]> = [
  ["export", "journals"],
  ["export", "receipts"],
  ["export", "wallet-txns"],
  ["export", "expense-applications"],
  ["companies", "list"],
  ["partners", "search"],
  ["partners", "create"],
  ["partners", "get"],
  ["partners", "update"],
  ["invoices", "list"],
  ["invoices", "get"],
  ["invoices", "templates"],
  ["invoices", "create"],
  ["invoices", "cancel"],
  ["invoices", "uncancel"],
  ["invoices", "update"],
  ["quotations", "list"],
  ["quotations", "get"],
  ["quotations", "templates"],
  ["quotations", "create"],
  ["quotations", "cancel"],
  ["quotations", "uncancel"],
];

export type RuntimePlan = string[][];
export type ExportPlan = RuntimePlan;

export interface RuntimeOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  state: string;
}

export function buildAuthorizationUrl(config: RuntimeOAuthConfig): string {
  const url = new URL(FREEE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state: config.state,
    prompt: "select_company",
  }).toString();
  return url.toString();
}

export function extractAuthorizationCode(callbackUrl: URL, expectedState: string): string {
  if (callbackUrl.searchParams.get("state") !== expectedState) {
    throw new Error("freee OAuth callback state mismatch");
  }
  const code = callbackUrl.searchParams.get("code");
  if (!code) throw new Error("freee OAuth callback code is missing");
  return code;
}

export async function exchangeAuthorizationCode(
  config: RuntimeOAuthConfig,
  code: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  let response: Response;
  try {
    response = await fetchFn(FREEE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }).toString(),
      signal,
    });
  } catch {
    throw new Error("freee token exchange request failed");
  }
  if (!response.ok) throw new Error(`freee token exchange failed: ${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("freee token exchange returned an invalid response");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("freee token exchange returned an invalid response");
  }
  const tokenPayload = payload as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof tokenPayload.access_token !== "string" ||
    tokenPayload.access_token.trim().length === 0 ||
    typeof tokenPayload.refresh_token !== "string" ||
    tokenPayload.refresh_token.trim().length === 0 ||
    typeof tokenPayload.expires_in !== "number" ||
    !Number.isFinite(tokenPayload.expires_in) ||
    tokenPayload.expires_in <= 0 ||
    tokenPayload.expires_in > MAX_ACCESS_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error("freee token exchange returned an invalid response");
  }
  return {
    accessToken: tokenPayload.access_token.trim(),
    refreshToken: tokenPayload.refresh_token.trim(),
    expiresIn: tokenPayload.expires_in,
  };
}

export function buildChildEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  accessToken: string,
): NodeJS.ProcessEnv {
  if (accessToken.trim().length === 0) throw new Error("freee access token is empty");
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (baseEnv[key] !== undefined) childEnv[key] = baseEnv[key];
  }
  childEnv.FREEE_ACCESS_TOKEN = accessToken;
  return childEnv;
}

export function parseRuntimePlan(text: string): RuntimePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid runtime plan JSON");
  }
  const commands =
    typeof parsed === "object" && parsed !== null && "commands" in parsed
      ? (parsed as { commands?: unknown }).commands
      : undefined;
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > 500) {
    throw new Error("Invalid runtime plan command count");
  }
  return commands.map((command) => {
    if (!Array.isArray(command) || command.length === 0 || !command.every((arg) => typeof arg === "string")) {
      throw new Error("Invalid runtime plan command");
    }
    const normalized = normalizeLegacyExportCommand(command as string[]);
    // 引数上限は実際に spawn する配列（正規化後）に掛ける
    if (normalized.length > 64 || !isAllowlistedRuntimeCommand(normalized)) {
      throw new Error("Invalid runtime plan command");
    }
    return normalized;
  });
}

/**
 * 旧 export plan 形式（先頭が journals / receipts / wallet-txns / expense-applications）を
 * CLI ルートからの argv（先頭 export）へ正規化する。既に export で始まる場合や他コマンドはそのまま。
 * parseRuntimePlan と runExportPlan（旧 API 互換）の双方で使う。
 */
export function normalizeLegacyExportCommand(command: string[]): string[] {
  return LEGACY_EXPORT_SUBCOMMANDS.has(command[0] as string) ? ["export", ...command] : [...command];
}

function isAllowlistedRuntimeCommand(command: readonly string[]): boolean {
  return RUNTIME_PLAN_ALLOWLIST.some(
    ([root, subcommand]) => command[0] === root && command[1] === subcommand,
  );
}

export const parseExportPlan = parseRuntimePlan;
