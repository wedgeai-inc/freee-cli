import { afterEach, describe, expect, it, vi } from "vitest";
import { loadApiAuth } from "../../src/lib/token-config-loader.js";
import { runOAuthRefresh, RefreshedTokenNotSavedError } from "../../src/commands/auth/oauth-refresh.js";
import { reportCliError } from "../../src/cli.js";
import { TokenStoreUpdateError, type OAuthTokenBundle } from "../../src/lib/one-password-token-store.js";

const NOW = 1_000_000;
const CLIENT_ENV = { FREEE_CLIENT_ID: "client", FREEE_CLIENT_SECRET: "sentinel-client-secret" };

function makeStore(expiresAt: number) {
  return {
    load: vi.fn(async (): Promise<OAuthTokenBundle> => ({
      accessToken: "sentinel-old-access",
      refreshToken: "sentinel-old-refresh",
      expiresAt,
    })),
    save: vi.fn(async () => undefined),
  };
}

function okFetch() {
  return vi.fn(async () => new Response(
    JSON.stringify({ access_token: "sentinel-new-access", refresh_token: "sentinel-new-refresh", expires_in: 21600 }),
    { status: 200 },
  )) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function fileDeps(env: NodeJS.ProcessEnv, fetchFn: typeof fetch, writeTextFile: (p: string, d: string) => void) {
  return {
    env,
    configDir: "/tmp/freee-mcp",
    now: () => 2_000_000,
    readTextFile: (path: string) => path.endsWith("tokens.json")
      ? JSON.stringify({ access_token: "expired-token", refresh_token: "refresh-token", expires_at: 1 })
      : JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" }),
    writeTextFile,
    fetchFn,
  };
}

describe("FREEE_TOKEN_REFRESH (1Password)", () => {
  it("disabled + expired: does not refresh or save, rejects with Japanese guidance", async () => {
    const store = makeStore(NOW + 30_000);
    const fetchFn = okFetch();
    const error = await loadApiAuth({
      tokenStore: store, profile: "alpha", now: () => NOW, fetchFn,
      env: { ...CLIENT_ENV, FREEE_TOKEN_REFRESH: "disabled" },
    }).catch((cause: unknown) => cause) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("FREEE_TOKEN_REFRESH=disabled");
    expect(error.message).toContain("freee auth refresh --profile alpha");
    expect(error.message).not.toContain("sentinel-");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("disabled + valid: returns the stored token", async () => {
    const store = makeStore(NOW + 3_600_000);
    const fetchFn = okFetch();
    const result = await loadApiAuth({
      tokenStore: store, profile: "alpha", now: () => NOW, fetchFn,
      env: { ...CLIENT_ENV, FREEE_TOKEN_REFRESH: "disabled" },
    });
    expect(result.accessToken).toBe("sentinel-old-access");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["Disabled", "off", "false", " disabled"])("invalid value %j + expired: fails closed", async (value) => {
    const store = makeStore(1);
    const fetchFn = okFetch();
    const error = await loadApiAuth({
      tokenStore: store, profile: "alpha", now: () => NOW, fetchFn,
      env: { ...CLIENT_ENV, FREEE_TOKEN_REFRESH: value },
    }).catch((cause: unknown) => cause) as Error;
    expect(error.message).toContain("FREEE_TOKEN_REFRESH");
    expect(error.message).toContain("enabled");
    expect(error.message).toContain("disabled");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "enabled"])("value %j + expired: refreshes and saves as before", async (value) => {
    const store = makeStore(1);
    const fetchFn = okFetch();
    const env: NodeJS.ProcessEnv = { ...CLIENT_ENV };
    if (value !== undefined) env.FREEE_TOKEN_REFRESH = value;
    const result = await loadApiAuth({ tokenStore: store, profile: "alpha", now: () => NOW, fetchFn, env });
    expect(result.accessToken).toBe("sentinel-new-access");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(1);
  });
});

describe("FREEE_TOKEN_REFRESH (file)", () => {
  it.each(["disabled", "nope"])("%s + expired: does not fetch or write", async (value) => {
    const fetchFn = okFetch();
    const writeTextFile = vi.fn();
    const error = await loadApiAuth(fileDeps({ FREEE_TOKEN_REFRESH: value }, fetchFn, writeTextFile))
      .catch((cause: unknown) => cause) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("FREEE_TOKEN_REFRESH");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

describe("runOAuthRefresh", () => {
  it("refreshes regardless of expiry, saves, and reports without secrets", async () => {
    const store = makeStore(NOW + 3_600_000);
    const fetchFn = okFetch();
    const message = await runOAuthRefresh({ profile: "alpha", env: CLIENT_ENV, store, fetchFn, now: () => NOW });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith("alpha", {
      accessToken: "sentinel-new-access", refreshToken: "sentinel-new-refresh", expiresAt: NOW + 21_600_000,
    });
    expect(message).toContain("profile: alpha");
    expect(message).toContain(new Date(NOW + 21_600_000).toISOString());
    expect(message).not.toContain("sentinel-");
  });

  it("save failure: says the token was not saved, keeps sanitized diagnostics, leaks no secrets", async () => {
    const store = makeStore(NOW + 3_600_000);
    const leaky = new TokenStoreUpdateError("edit", "edit", "nonzero");
    Object.assign(leaky, { secret: "sentinel-leak" });
    store.save.mockRejectedValueOnce(leaky);
    const error = await runOAuthRefresh({ profile: "alpha", env: CLIENT_ENV, store, fetchFn: okFetch(), now: () => NOW })
      .catch((cause: unknown) => cause) as RefreshedTokenNotSavedError;
    expect(error).toBeInstanceOf(RefreshedTokenNotSavedError);
    expect(error.message).toContain("保存されていません");
    expect(error.message).toContain("freee auth login --profile alpha");
    expect(error.diagnostic.stage).toBe("edit");
    expect(`${error.message} ${JSON.stringify(error)} ${error.stack}`).not.toContain("sentinel-");

    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      reportCliError(error);
    } finally {
      spy.mockRestore();
    }
    expect(lines.join("\n")).toContain("保存されていません");
    expect(lines.join("\n")).toContain("stage=edit");
    expect(lines.join("\n")).not.toContain("sentinel-");
    expect(process.exitCode).toBe(1);
  });

  it("invalid refresh: guides to auth login and does not save", async () => {
    const store = makeStore(1);
    const fetchFn = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const error = await runOAuthRefresh({ profile: "alpha", env: CLIENT_ENV, store, fetchFn, now: () => NOW })
      .catch((cause: unknown) => cause) as Error;
    expect(error.message).toContain("freee auth login --profile alpha");
    expect(store.save).not.toHaveBeenCalled();
  });

  it.each(["disabled", "bogus"])("FREEE_TOKEN_REFRESH=%s: neither refreshes nor saves", async (value) => {
    const store = makeStore(1);
    const fetchFn = okFetch();
    const error = await runOAuthRefresh({
      profile: "alpha", env: { ...CLIENT_ENV, FREEE_TOKEN_REFRESH: value }, store, fetchFn, now: () => NOW,
    }).catch((cause: unknown) => cause) as Error;
    expect(error.message).toContain("FREEE_TOKEN_REFRESH");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.load).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  process.exitCode = undefined;
});
