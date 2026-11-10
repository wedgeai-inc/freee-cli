import { describe, expect, it, vi } from "vitest";
import { formatCompaniesList, runCompaniesList } from "../../src/commands/companies/list.js";
import { createProgram } from "../../src/cli.js";
import { OnePasswordTokenStore, TokenStoreUpdateError } from "../../src/lib/one-password-token-store.js";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("runCompaniesList", () => {
  it("GET /api/1/companies を1回だけ呼び、2件をtable形式で返す", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/1/companies");
      expect([...parsed.searchParams]).toEqual([]);
      return jsonRes({
        companies: [
          { id: 1, name: "Alpha", display_name: "Alpha Co.", role: "admin" },
          { id: 2, name: "Beta", display_name: "Beta Co.", role: "member" },
        ],
      });
    });
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    const result = await runCompaniesList({ client });

    expect(result.items).toHaveLength(2);
    expect(formatCompaniesList(result, "table")).toContain("1");
    expect(formatCompaniesList(result, "table")).toContain("2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("companies キーがない payload は空配列として返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({}));
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    await expect(runCompaniesList({ client })).resolves.toEqual({ items: [] });
  });
});

describe("runCompaniesList field mapping", () => {
  it("drops fields that are not part of CompanySummary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ companies: [{ id: 1, name: "A", display_name: "A社", role: "admin", company_number: "abc", secret_flag: true, contact_email: "x@example.com" }] }),
    );
    const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "t", fetchFn: fetchMock });
    const result = await runCompaniesList({ client });
    expect(result.items[0]).toEqual({ id: 1, name: "A", display_name: "A社", role: "admin", company_number: "abc" });
    expect(JSON.stringify(result.items)).not.toContain("secret_flag");
  });
});

describe("companies list authentication failure", () => {
  it("does not call the companies API or write stdout when saving refreshed tokens fails", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 21600 })));
    vi.stubGlobal("fetch", fetchFn);
    vi.stubEnv("FREEE_ACCESS_TOKEN", undefined);
    vi.stubEnv("FREEE_CLIENT_ID", "synthetic-client");
    vi.stubEnv("FREEE_CLIENT_SECRET", "synthetic-secret");
    vi.spyOn(OnePasswordTokenStore.prototype, "load").mockResolvedValue({ accessToken: "expired", refreshToken: "old", expiresAt: 1 });
    // The first save is the pre-refresh write check; the second (rotated bundle) fails.
    vi.spyOn(OnePasswordTokenStore.prototype, "save").mockResolvedValueOnce(undefined).mockRejectedValue(new TokenStoreUpdateError("preread", "get", "nonzero"));
    try {
      const error = await createProgram().parseAsync(["companies", "list", "--format", "table"], { from: "user" }).catch((error: unknown) => error);
      expect(error).toMatchObject({ message: "freee OAuth token store could not be updated", stage: "preread", operation: "get", category: "nonzero" });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://accounts.secure.freee.co.jp/public_api/token");
      expect(stdout).not.toHaveBeenCalled();
      expect(`${String(error)} ${JSON.stringify(error)} ${JSON.stringify(stderr.mock.calls)}`).not.toContain("synthetic-");
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
