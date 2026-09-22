import { describe, expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { formatPartnerGet, runPartnersGet } from "../../src/commands/partners/get.js";

describe("partners get", () => {
  it("gets one wrapped partner and formats its raw shape as JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ partner: { id: 100, company_id: 1, name: "取引先", payment_term_attributes: null } })));
    const client = new PublicFreeeClient({ baseUrl: "https://api.example.test", token: "token", fetchFn });

    const result = await runPartnersGet({ companyId: 1, id: 100 }, { client });

    expect(result).toEqual({ id: 100, company_id: 1, name: "取引先", payment_term_attributes: null });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toContain("/api/1/partners/100?company_id=1");
    expect(JSON.parse(formatPartnerGet(result))).toEqual(result);
  });

  it.each([
    ["id mismatch", { id: 101, company_id: 1, name: "取引先" }],
    ["company mismatch", { id: 100, company_id: 2, name: "取引先" }],
    ["missing wrapper", { id: 100, company_id: 1, name: "取引先" }],
  ])("rejects %s", async (kind, value) => {
    const body = kind === "missing wrapper" ? value : { partner: value };
    const client = new PublicFreeeClient({ baseUrl: "https://api.example.test", token: "token", fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify(body))) });
    await expect(runPartnersGet({ companyId: 1, id: 100 }, { client })).rejects.toThrow();
  });

  it("propagates a 404 from the API", async () => {
    const client = new PublicFreeeClient({ baseUrl: "https://api.example.test", token: "token", fetchFn: vi.fn().mockResolvedValue(new Response("missing", { status: 404 })) });
    await expect(runPartnersGet({ companyId: 1, id: 100 }, { client })).rejects.toMatchObject({ status: 404 });
  });
});
