import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runInvoicesGet, formatInvoiceDetail } from "../../src/commands/invoices/get.js";
import { runInvoicesList, formatInvoicesList } from "../../src/commands/invoices/list.js";

it("請求書get・listのJSONはdeal_idの数値とnullを保持し、不正な型や未指定は省く", async () => {
  for (const dealId of [6, null, undefined, "6", false, {}, []]) {
    const invoice = { id: 8, company_id: 1, deal_id: dealId, cancel_status: "uncanceled" };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ invoice, invoices: [invoice] })));
    const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn });
    const detail = JSON.parse(formatInvoiceDetail(await runInvoicesGet({ companyId: 1, id: 8 }, { client }), "json")).invoice;
    const summary = JSON.parse(formatInvoicesList(await runInvoicesList({ companyId: 1 }, { client }), "json"))[0];
    for (const item of [detail, summary]) {
      if (typeof dealId === "number" || dealId === null) expect(item).toHaveProperty("deal_id", dealId);
      else expect(item).not.toHaveProperty("deal_id");
    }
  }
});
