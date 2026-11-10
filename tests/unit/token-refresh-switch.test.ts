import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApiAuth, TokenStoreNotWritableError } from "../../src/lib/token-config-loader.js";
import { runOAuthRefresh, RefreshedTokenNotSavedError } from "../../src/commands/auth/oauth-refresh.js";
import { createProgram, reportCliError } from "../../src/cli.js";
import { TokenStoreUpdateError, type OAuthTokenBundle } from "../../src/lib/one-password-token-store.js";

const NOW = 1_000_000;
const CLIENT_ENV = { FREEE_CLIENT_ID: "client", FREEE_CLIENT_SECRET: "sentinel-client-secret" };
const OLD_BUNDLE = { accessToken: "sentinel-old-access", refreshToken: "sentinel-old-refresh" };
const NEW_BUNDLE = { accessToken: "sentinel-new-access", refreshToken: "sentinel-new-refresh", expiresAt: NOW + 21_600_000 };

let lockDir: string;

beforeEach(async () => {
  lockDir = join(await mkdtemp(join(tmpdir(), "freee-cli-switch-test-")), "locks");
});

afterEach(async () => {
  process.exitCode = undefined;
  await rm(join(lockDir, ".."), { recursive: true, force: true });
});

function makeStore(expiresAt: number) {
  return {
    load: vi.fn(async (): Promise<OAuthTokenBundle> => ({ ...OLD_BUNDLE, expiresAt })),
    save: vi.fn(async (_profile: string, _bundle: OAuthTokenBundle) => undefined),
  };
}

function okFetch() {
  return vi.fn(async () => new Response(
    JSON.stringify({ access_token: "sentinel-new-access", refresh_token: "sentinel-new-refresh", expires_in: 21600 }),
    { status: 200 },
  )) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function fileDeps(
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  writeTextFile: (p: string, d: string) => void,
  expiresAt = 1,
) {
  return {
    env,
    configDir: "/tmp/freee-mcp",
    now: () => 2_000_000,
    readTextFile: (path: string) => path.endsWith("tokens.json")
      ? JSON.stringify({ access_token: "expired-token", refresh_token: "refresh-token", expires_at: expiresAt })
      : JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" }),
    writeTextFile,
    fetchFn,
  };
}

function storeFailure() {
  return Object.assign(new TokenStoreUpdateError("edit", "edit", "nonzero"), { secret: "sentinel-leak" });
}

describe("FREEE_TOKEN_REFRESH (1Password)", () => {
  it("disabled + expired: does not refresh or save, rejects with Japanese guidance", async () => {
    const store = makeStore(NOW + 30_000);
    const fetchFn = okFetch();
    const error = await loadApiAuth({
      tokenStore: store, profile: "alpha", now: () => NOW, fetchFn, lockDir,
      env: { ...CLIENT_ENV, FREEE_TOKEN_REFRESH: "disabled" },
    }).catch((cause: unknown) => cause) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("期限が切れています");
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
      tokenStore: store, profile: "alpha", now: () => NOW, fetchFn, lockDir,
      env: { ...CLIENT_ENV, FREEE_TOKEN_REFRESH: "disabled" },
    });
    expect(result.accessToken).toBe("sentinel-old-access");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it.each([1, NOW + 3_600_000])("invalid value + expiresAt %i: fails closed even for a valid token", async (expiresAt) => {
    for (const value of ["Disabled", "off", "false", " disabled", "sentinel-raw-value"]) {
      const store = makeStore(expiresAt);
      const fetchFn = okFetch();
      const error = await loadApiAuth({
        tokenStore: store, profile: "alpha", now: () => NOW, fetchFn, lockDir,
        env: { ...CLIENT_ENV, FREEE_TOKEN_REFRESH: value },
      }).catch((cause: unknown) => cause) as Error;
      expect(error.message).toContain("FREEE_TOKEN_REFRESH");
      expect(error.message).toContain("enabled");
      expect(error.message).toContain("disabled");
      expect(error.message).not.toContain("sentinel-");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, "", "enabled"])("value %j + expired: checks the store is writable, then refreshes and saves", async (value) => {
    const store = makeStore(1);
    const fetchFn = okFetch();
    const env: NodeJS.ProcessEnv = { ...CLIENT_ENV };
    if (value !== undefined) env.FREEE_TOKEN_REFRESH = value;
    const result = await loadApiAuth({ tokenStore: store, profile: "alpha", now: () => NOW, fetchFn, env, lockDir });
    expect(result.accessToken).toBe("sentinel-new-access");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.save).toHaveBeenNthCalledWith(1, "alpha", { ...OLD_BUNDLE, expiresAt: 1 });
    expect(store.save).toHaveBeenNthCalledWith(2, "alpha", NEW_BUNDLE);
    expect(store.save.mock.invocationCallOrder[0]).toBeLessThan(fetchFn.mock.invocationCallOrder[0]);
  });

  it("auto refresh: a failed write check stops before fetch and never saves a new token", async () => {
    const store = makeStore(1);
    store.save.mockRejectedValueOnce(storeFailure());
    const fetchFn = okFetch();
    const error = await loadApiAuth({ tokenStore: store, profile: "alpha", now: () => NOW, fetchFn, env: CLIENT_ENV, lockDir })
      .catch((cause: unknown) => cause) as TokenStoreNotWritableError;
    expect(error).toBeInstanceOf(TokenStoreNotWritableError);
    expect(error.message).toContain("書き込めない");
    expect(error.diagnostic.stage).toBe("edit");
    expect(`${error.message} ${JSON.stringify(error)} ${error.stack}`).not.toContain("sentinel-");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("auto refresh: re-reads the bundle under the lock and skips refresh if another process already refreshed", async () => {
    const store = makeStore(1);
    store.load.mockResolvedValueOnce({ ...OLD_BUNDLE, expiresAt: 1 })
      .mockResolvedValueOnce({ accessToken: "sentinel-other-access", refreshToken: "sentinel-other-refresh", expiresAt: NOW + 3_600_000 });
    const fetchFn = okFetch();
    const result = await loadApiAuth({ tokenStore: store, profile: "alpha", now: () => NOW, fetchFn, env: CLIENT_ENV, lockDir });
    expect(result.accessToken).toBe("sentinel-other-access");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("auto refresh: fails immediately when the profile lock is held and does not fetch", async () => {
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "alpha.lock"), `${process.pid} other\n`);
    const store = makeStore(1);
    const fetchFn = okFetch();
    const error = await loadApiAuth({ tokenStore: store, profile: "alpha", now: () => NOW, fetchFn, env: CLIENT_ENV, lockDir })
      .catch((cause: unknown) => cause) as Error;
    expect(error.message).toContain("既に実行中です");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(await readdir(lockDir)).toEqual(["alpha.lock"]);
  });

  it("auto refresh: releases its lock after success and failure; a valid token never creates a lock", async () => {
    await loadApiAuth({ tokenStore: makeStore(1), profile: "alpha", now: () => NOW, fetchFn: okFetch(), env: CLIENT_ENV, lockDir });
    expect(await readdir(lockDir)).toEqual([]);
    const failing = makeStore(1);
    failing.save.mockRejectedValue(storeFailure());
    await expect(loadApiAuth({ tokenStore: failing, profile: "alpha", now: () => NOW, fetchFn: okFetch(), env: CLIENT_ENV, lockDir })).rejects.toThrow();
    expect(await readdir(lockDir)).toEqual([]);
    await rm(lockDir, { recursive: true, force: true });
    await loadApiAuth({ tokenStore: makeStore(NOW + 3_600_000), profile: "alpha", now: () => NOW, env: CLIENT_ENV, lockDir });
    await expect(readdir(lockDir)).rejects.toThrow();
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
    expect(error.message).not.toContain("freee auth refresh");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("invalid value + valid token: fails closed without fetch or write", async () => {
    const fetchFn = okFetch();
    const writeTextFile = vi.fn();
    await expect(loadApiAuth(fileDeps({ FREEE_TOKEN_REFRESH: "nope" }, fetchFn, writeTextFile, 9_999_999_999)))
      .rejects.toThrow("FREEE_TOKEN_REFRESH");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("disabled + valid token: returns the stored token", async () => {
    const result = await loadApiAuth(fileDeps({ FREEE_TOKEN_REFRESH: "disabled" }, okFetch(), vi.fn(), 9_999_999_999));
    expect(result.accessToken).toBe("expired-token");
  });

  it("expired: writes back the current tokens.json before refreshing", async () => {
    const fetchFn = okFetch();
    const writeTextFile = vi.fn();
    const deps = fileDeps(CLIENT_ENV, fetchFn, writeTextFile);
    await loadApiAuth(deps);
    expect(writeTextFile).toHaveBeenCalledTimes(2);
    expect(writeTextFile.mock.calls[0]).toEqual(["/tmp/freee-mcp/tokens.json", deps.readTextFile("/tmp/freee-mcp/tokens.json")]);
    expect(writeTextFile.mock.invocationCallOrder[0]).toBeLessThan(fetchFn.mock.invocationCallOrder[0]);
  });

  it("expired: a failed write check stops before fetch", async () => {
    const fetchFn = okFetch();
    const writeTextFile = vi.fn(() => { throw new Error("EACCES sentinel-path"); });
    const error = await loadApiAuth(fileDeps(CLIENT_ENV, fetchFn, writeTextFile)).catch((cause: unknown) => cause) as Error;
    expect(error.message).toContain("書き込めない");
    expect(error.message).not.toContain("sentinel-");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(writeTextFile).toHaveBeenCalledTimes(1);
  });
});

describe("runOAuthRefresh", () => {
  it("checks the store is writable, refreshes regardless of expiry, saves, and reports without secrets", async () => {
    const store = makeStore(NOW + 3_600_000);
    const fetchFn = okFetch();
    const message = await runOAuthRefresh({ profile: "alpha", env: CLIENT_ENV, store, fetchFn, now: () => NOW, lockDir });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.save).toHaveBeenNthCalledWith(1, "alpha", { ...OLD_BUNDLE, expiresAt: NOW + 3_600_000 });
    expect(store.save).toHaveBeenNthCalledWith(2, "alpha", NEW_BUNDLE);
    expect(store.save.mock.invocationCallOrder[0]).toBeLessThan(fetchFn.mock.invocationCallOrder[0]);
    expect(message).toContain("profile: alpha");
    expect(message).toContain(new Date(NOW + 21_600_000).toISOString());
    expect(message).not.toContain("sentinel-");
    expect(await readdir(lockDir)).toEqual([]);
  });

  it("write check failure: neither fetches nor saves a new token, leaks no secrets, releases the lock", async () => {
    const store = makeStore(NOW + 3_600_000);
    store.save.mockRejectedValueOnce(storeFailure());
    const fetchFn = okFetch();
    const error = await runOAuthRefresh({ profile: "alpha", env: CLIENT_ENV, store, fetchFn, now: () => NOW, lockDir })
      .catch((cause: unknown) => cause) as TokenStoreNotWritableError;
    expect(error).toBeInstanceOf(TokenStoreNotWritableError);
    expect(error.message).toContain("refresh tokenは使っていません");
    expect(`${error.message} ${JSON.stringify(error)} ${error.stack}`).not.toContain("sentinel-");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(await readdir(lockDir)).toEqual([]);

    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      reportCliError(error);
    } finally {
      spy.mockRestore();
    }
    expect(lines.join("\n")).toContain("書き込めない");
    expect(lines.join("\n")).toContain("stage=edit");
    expect(lines.join("\n")).not.toContain("sentinel-");
  });

  it("save failure after refresh: says the token may not be saved, keeps sanitized diagnostics, leaks no secrets", async () => {
    const store = makeStore(NOW + 3_600_000);
    store.save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(storeFailure());
    const error = await runOAuthRefresh({ profile: "alpha", env: CLIENT_ENV, store, fetchFn: okFetch(), now: () => NOW, lockDir })
      .catch((cause: unknown) => cause) as RefreshedTokenNotSavedError;
    expect(error).toBeInstanceOf(RefreshedTokenNotSavedError);
    expect(error.message).toContain("保存されていない可能性があります");
    expect(error.message).toContain("freee auth login --profile alpha");
    expect(error.diagnostic.stage).toBe("edit");
    expect(`${error.message} ${JSON.stringify(error)} ${error.stack}`).not.toContain("sentinel-");
    expect(await readdir(lockDir)).toEqual([]);

    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      reportCliError(error);
    } finally {
      spy.mockRestore();
    }
    expect(lines.join("\n")).toContain("保存されていない可能性があります");
    expect(lines.join("\n")).toContain("stage=edit");
    expect(lines.join("\n")).not.toContain("sentinel-");
    expect(process.exitCode).toBe(1);
  });

  it("invalid refresh: guides to auth login and does not save a new token", async () => {
    const store = makeStore(1);
    const fetchFn = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const error = await runOAuthRefresh({ profile: "alpha", env: CLIENT_ENV, store, fetchFn, now: () => NOW, lockDir })
      .catch((cause: unknown) => cause) as Error;
    expect(error.message).toContain("freee auth login --profile alpha");
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).not.toHaveBeenCalledWith("alpha", expect.objectContaining({ accessToken: "sentinel-new-access" }));
  });

  it.each(["disabled", "bogus"])("FREEE_TOKEN_REFRESH=%s: neither loads, refreshes, saves, nor locks", async (value) => {
    const store = makeStore(1);
    const fetchFn = okFetch();
    const error = await runOAuthRefresh({
      profile: "alpha", env: { ...CLIENT_ENV, FREEE_TOKEN_REFRESH: value }, store, fetchFn, now: () => NOW, lockDir,
    }).catch((cause: unknown) => cause) as Error;
    expect(error.message).toContain("FREEE_TOKEN_REFRESH");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.load).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    await expect(readdir(lockDir)).rejects.toThrow();
  });

  it("disabled: says refresh is forbidden here, not that the token expired, and does not suggest auth refresh", async () => {
    const error = await runOAuthRefresh({
      profile: "alpha", env: { ...CLIENT_ENV, FREEE_TOKEN_REFRESH: "disabled" }, store: makeStore(1), fetchFn: okFetch(), now: () => NOW, lockDir,
    }).catch((cause: unknown) => cause) as Error;
    expect(error.message).toContain("この環境ではtokenの更新を禁止しています");
    expect(error.message).not.toContain("期限が切れています");
    expect(error.message).not.toContain("freee auth refresh");
  });

  it("fails immediately when the profile lock is held, without loading or fetching", async () => {
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "alpha.lock"), `${process.pid} other\n`);
    const store = makeStore(1);
    const fetchFn = okFetch();
    const error = await runOAuthRefresh({ profile: "alpha", env: CLIENT_ENV, store, fetchFn, now: () => NOW, lockDir })
      .catch((cause: unknown) => cause) as Error;
    expect(error.message).toContain("同じprofileのtoken更新が既に実行中です");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(await readdir(lockDir)).toEqual(["alpha.lock"]);
  });
});

describe("--help", () => {
  it("documents FREEE_TOKEN_REFRESH on the root and on auth refresh", () => {
    const program = createProgram();
    expect(program.helpInformation()).toContain("FREEE_TOKEN_REFRESH");
    const refresh = program.commands.find((c) => c.name() === "auth")!.commands.find((c) => c.name() === "refresh")!;
    expect(refresh.helpInformation()).toContain("FREEE_TOKEN_REFRESH");
  });
});
