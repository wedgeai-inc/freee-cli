import { describe, expect, it } from "vitest";
import { loadApiAuth, loadReadonlyAuth } from "../../src/lib/token-config-loader.js";

describe("loadReadonlyAuth", () => {
  it("uses FREEE_ACCESS_TOKEN when set", () => {
    const result = loadReadonlyAuth({
      env: { FREEE_ACCESS_TOKEN: "env-token" },
      readTextFile: () => {
        throw new Error("should not read file");
      },
    });
    expect(result.mode).toBe("env");
    expect(result.accessToken).toBe("env-token");
  });

  it("fails closed when FREEE_ACCESS_TOKEN is defined but empty", () => {
    expect(() =>
      loadReadonlyAuth({
        env: { FREEE_ACCESS_TOKEN: "" },
        readTextFile: () => {
          throw new Error("must not read token files");
        },
      }),
    ).toThrow("FREEE_ACCESS_TOKEN is empty");
  });

  it("loads token/config from files", () => {
    const result = loadReadonlyAuth({
      env: {},
      readTextFile: (path) => {
        if (path.endsWith("tokens.json")) {
          return JSON.stringify({ access_token: "file-token", refresh_token: "r", expires_at: 1 });
        }
        return JSON.stringify({ defaultCompanyId: 1234567, currentCompanyId: 1234568 });
      },
      configDir: "/tmp/freee-mcp",
    });

    expect(result.mode).toBe("config");
    expect(result.accessToken).toBe("file-token");
    expect(result.defaultCompanyId).toBe(1234567);
  });
});

describe("loadApiAuth", () => {
  it("fails closed when FREEE_ACCESS_TOKEN is defined but blank", async () => {
    await expect(
      loadApiAuth({
        env: { FREEE_ACCESS_TOKEN: "  " },
        readTextFile: () => {
          throw new Error("must not read token files");
        },
      }),
    ).rejects.toThrow("FREEE_ACCESS_TOKEN is empty");
  });
  it("prefers client credential environment variables when refreshing", async () => {
    const result = await loadApiAuth({
      env: {
        FREEE_CLIENT_ID: "env-client-id",
        FREEE_CLIENT_SECRET: "env-client-secret",
      },
      configDir: "/tmp/freee-mcp",
      now: () => 2_000_000,
      readTextFile: (path) => {
        if (path.endsWith("tokens.json")) {
          return JSON.stringify({
            access_token: "expired-token",
            refresh_token: "refresh-token",
            expires_at: 1,
          });
        }
        return JSON.stringify({
          clientId: "config-client-id",
          clientSecret: "config-client-secret",
          defaultCompanyId: 1234567,
        });
      },
      writeTextFile: () => undefined,
      fetchFn: async (_url, init) => {
        const body = String(init?.body);
        expect(body).toContain("client_id=env-client-id");
        expect(body).toContain("client_secret=env-client-secret");
        expect(body).not.toContain("config-client-id");
        expect(body).not.toContain("config-client-secret");
        return new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "fresh-refresh-token",
            expires_in: 3600,
            created_at: 1000,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(result.accessToken).toBe("fresh-token");
  });

  it.each([
    ["client ID only", { FREEE_CLIENT_ID: "partial-env-client-id" }],
    ["client secret only", { FREEE_CLIENT_SECRET: "partial-env-client-secret" }],
    ["both empty", { FREEE_CLIENT_ID: "", FREEE_CLIENT_SECRET: "" }],
    ["empty client secret", { FREEE_CLIENT_ID: "partial-env-client-id", FREEE_CLIENT_SECRET: "" }],
    ["empty client ID", { FREEE_CLIENT_ID: "", FREEE_CLIENT_SECRET: "partial-env-client-secret" }],
  ])("fails closed for invalid client credential environment: %s", async (_caseName, env) => {
    const error = await loadApiAuth({
      env,
      configDir: "/tmp/freee-mcp",
      now: () => 2_000_000,
      readTextFile: (path) => {
        if (path.endsWith("tokens.json")) {
          return JSON.stringify({
            access_token: "expired-token",
            refresh_token: "refresh-token",
            expires_at: 1,
          });
        }
        return JSON.stringify({
          clientId: "config-client-id",
          clientSecret: "config-client-secret",
        });
      },
      writeTextFile: () => undefined,
      fetchFn: async () => {
        throw new Error("fetch must not be called");
      },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("freee client credential environment is incomplete.");
    expect((error as Error).message).not.toContain("partial-env-client");
    expect((error as Error).message).not.toContain("config-client-secret");
  });

  it("refreshes expired config token and persists the updated token file", async () => {
    const writes: Record<string, string> = {};
    const result = await loadApiAuth({
      env: {},
      configDir: "/tmp/freee-mcp",
      now: () => 2_000_000,
      readTextFile: (path) => {
        if (path.endsWith("tokens.json")) {
          return JSON.stringify({
            access_token: "expired-token",
            refresh_token: "refresh-token",
            expires_at: 1,
            token_type: "bearer",
            scope: "accounting:wallet_txns:read",
          });
        }
        return JSON.stringify({
          clientId: "client-id",
          clientSecret: "client-secret",
          defaultCompanyId: 1234567,
        });
      },
      writeTextFile: (path, data) => {
        writes[path] = data;
      },
      fetchFn: async (_url, init) => {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        expect(String(init?.body)).toContain("client_id=client-id");
        expect(String(init?.body)).toContain("refresh_token=refresh-token");
        return new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "fresh-refresh-token",
            token_type: "bearer",
            expires_in: 3600,
            created_at: 1000,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(result.accessToken).toBe("fresh-token");
    const saved = JSON.parse(writes["/tmp/freee-mcp/tokens.json"] ?? "{}") as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
    };
    expect(saved.access_token).toBe("fresh-token");
    expect(saved.refresh_token).toBe("fresh-refresh-token");
    expect(saved.expires_at).toBe(4_600_000);
  });
});
