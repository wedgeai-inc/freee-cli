import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  buildChildEnvironment,
  exchangeAuthorizationCode,
  extractAuthorizationCode,
  parseExportPlan,
  parseRuntimePlan,
} from "../../src/lib/runtime-oauth.js";

describe("runtime OAuth", () => {
  it("builds an authorization URL with state and callback but without the client secret", () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:54321/callback",
        state: "random-state",
      }),
    );

    expect(url.origin).toBe("https://accounts.secure.freee.co.jp");
    expect(url.pathname).toBe("/public_api/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback");
    expect(url.searchParams.get("state")).toBe("random-state");
    expect(url.search).not.toContain("client-secret");
  });

  it("accepts only callbacks with the expected state and a code", () => {
    expect(
      extractAuthorizationCode(
        new URL("http://127.0.0.1:54321/callback?code=valid-code&state=expected"),
        "expected",
      ),
    ).toBe("valid-code");
    expect(() =>
      extractAuthorizationCode(
        new URL("http://127.0.0.1:54321/callback?code=valid-code&state=wrong"),
        "expected",
      ),
    ).toThrow(/state/i);
    expect(() =>
      extractAuthorizationCode(new URL("http://127.0.0.1:54321/callback?state=expected"), "expected"),
    ).toThrow(/code/i);
  });

  it("exchanges a code without exposing an error response body", async () => {
    const config = {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://127.0.0.1:54321/callback",
      state: "state",
    };
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 21600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(exchangeAuthorizationCode(config, "code", fetchFn)).resolves.toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 21600,
    });
    await expect(
      exchangeAuthorizationCode(
        config,
        "bad-code",
        async () => new Response("client_secret=leak&code=leak", { status: 401 }),
      ),
    ).rejects.toThrow(/^freee token exchange failed: 401$/);
  });

  it.each([
    ["empty access token", { access_token: "", refresh_token: "refresh", expires_in: 21600 }],
    ["blank refresh token", { access_token: "access", refresh_token: "  ", expires_in: 21600 }],
    ["zero expiry", { access_token: "access", refresh_token: "refresh", expires_in: 0 }],
    ["negative expiry", { access_token: "access", refresh_token: "refresh", expires_in: -1 }],
    ["too long expiry", { access_token: "access", refresh_token: "refresh", expires_in: 21601 }],
    ["infinite expiry", { access_token: "access", refresh_token: "refresh", expires_in: Infinity }],
  ])("rejects malformed token payloads: %s", async (_name, payload) => {
    await expect(
      exchangeAuthorizationCode(
        {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "http://127.0.0.1:54321/callback",
          state: "state",
        },
        "code",
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    ).rejects.toThrow(/^freee token exchange returned an invalid response$/);
  });

  it("uses a fixed message for network and invalid JSON failures", async () => {
    const config = {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://127.0.0.1:54321/callback",
      state: "state",
    };
    await expect(
      exchangeAuthorizationCode(config, "code", async () => {
        throw new Error("client_secret=leak&code=leak");
      }),
    ).rejects.toThrow(/^freee token exchange request failed$/);
    await expect(
      exchangeAuthorizationCode(
        config,
        "code",
        async () => new Response("client_secret=leak", { status: 200 }),
      ),
    ).rejects.toThrow(/^freee token exchange returned an invalid response$/);
    await expect(
      exchangeAuthorizationCode(
        config,
        "code",
        async () =>
          new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    ).rejects.toThrow(/^freee token exchange returned an invalid response$/);
  });

  it("injects only the access token into the child process environment", () => {
    const env = buildChildEnvironment(
      {
        PATH: "/bin",
        HOME: "/home/test",
        TMPDIR: "/tmp/test",
        LANG: "ja_JP.UTF-8",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        GITHUB_TOKEN: "github-token",
        FREEE_REFRESH_TOKEN: "refresh-token",
        FREEE_ACCESS_TOKEN: "stale",
        FREEE_CLIENT_ID: "client-id",
        FREEE_CLIENT_SECRET: "client-secret",
        FREEE_AUTHORIZATION_CODE: "authorization-code",
        OP_SERVICE_ACCOUNT_TOKEN: "op-token",
      },
      "fresh-access-token",
    );

    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      TMPDIR: "/tmp/test",
      LANG: "ja_JP.UTF-8",
      FREEE_ACCESS_TOKEN: "fresh-access-token",
    });
    expect(JSON.stringify(env)).not.toContain("refresh-token");
    expect(JSON.stringify(env)).not.toContain("github-token");
    expect(JSON.stringify(env)).not.toContain("aws-secret");
    expect(() => buildChildEnvironment({}, "  ")).toThrow(/access token/i);
  });

  it("accepts runtime plan v2 commands and normalizes legacy export commands", () => {
    expect(
      parseRuntimePlan(
        JSON.stringify({
          commands: [
            ["companies", "list"],
            ["partners", "search", "--company-id", "1"],
            ["partners", "create", "--company-id", "1", "--plan", "p.json"],
            ["partners", "get", "--company-id", "1", "--id", "100"],
            ["partners", "update", "--company-id", "1", "--id", "100", "--plan", "p.json"],
            ["invoices", "create", "--company-id", "1", "--plan", "p.json"],
            ["invoices", "cancel", "--company-id", "1", "--id", "2"],
            ["invoices", "uncancel", "--company-id", "1", "--id", "2"],
            ["export", "journals", "--company-id", "1"],
            ["journals", "--company-id", "1"],
          ],
        }),
      ),
    ).toEqual([
      ["companies", "list"],
      ["partners", "search", "--company-id", "1"],
      ["partners", "create", "--company-id", "1", "--plan", "p.json"],
      ["partners", "get", "--company-id", "1", "--id", "100"],
      ["partners", "update", "--company-id", "1", "--id", "100", "--plan", "p.json"],
      ["invoices", "create", "--company-id", "1", "--plan", "p.json"],
      ["invoices", "cancel", "--company-id", "1", "--id", "2"],
      ["invoices", "uncancel", "--company-id", "1", "--id", "2"],
      ["export", "journals", "--company-id", "1"],
      ["export", "journals", "--company-id", "1"],
    ]);
  });

  it("allows all quotation runtime commands and rejects quotation update", () => {
    const commands = ["list", "get", "templates", "create", "cancel", "uncancel"].map((subcommand) => ["quotations", subcommand]);
    expect(parseRuntimePlan(JSON.stringify({ commands }))).toEqual(commands);
    expect(() => parseRuntimePlan(JSON.stringify({ commands: [["quotations", "update"]] }))).toThrow(/^Invalid runtime plan/);
  });

  it("accepts only allowlisted runtime commands in a bounded plan without echoing input", () => {
    expect(
      parseExportPlan(
        JSON.stringify({
          commands: [
            ["export", "journals", "--company-id", "1234567", "--month", "2026-07", "--out", "/tmp/journals"],
            ["export", "receipts", "--company-id", "1234567", "--month", "2026-07", "--out", "/tmp/receipts"],
          ],
        }),
      ),
    ).toHaveLength(2);

    for (const invalid of [
      { commands: [["expense", "register-deal", "--execute"]] },
      { commands: [["auth", "runtime-oauth-exec"]] },
      { commands: [["invoices"]] },
      { commands: [["export"]] },
      { commands: [["export", "unknown"]] },
      { commands: [["env"]] },
      { commands: [["journals", 1]] },
      { commands: [] },
      { commands: Array.from({ length: 501 }, () => ["journals"]) },
    ]) {
      const input = JSON.stringify(invalid);
      expect(() => parseExportPlan(input)).toThrow(/^Invalid runtime plan/);
      try {
        parseExportPlan(input);
      } catch (error) {
        expect((error as Error).message).not.toContain(input);
      }
    }
  });
});
