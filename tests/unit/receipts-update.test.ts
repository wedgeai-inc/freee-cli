import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runReceiptsUpdate } from "../../src/commands/receipts/update.js";
const options = { id: 5, companyId: 1, logDir: "unused", taskId: "sample" };
const current = { id: 5, receipt_metadatum: { partner_name: "架空旧発行元", issue_date: "2026-01-01", amount: 123 } };
function setup() {
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const metadata = init?.method === "PUT" ? JSON.parse(String(init.body)).receipt_metadatum : {};
    return new Response(JSON.stringify({ receipt: { ...current, receipt_metadatum: { ...current.receipt_metadatum, ...metadata } } }));
  });
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn });
  return { fetchFn, deps: { getClient: vi.fn(async () => client), appendAudit: vi.fn().mockResolvedValue(undefined), now: () => new Date("2026-01-15T00:00:00Z") } };
}
it.each([{}, { id: 0, amount: 0 }, { companyId: 0, amount: 0 }, { amount: 1.5 }, { amount: Infinity }, { amount: 1000000000000 }, { amount: -1000000000000 }, { issueDate: "2026-02-30" }, { partnerName: "a".repeat(256) }])("不正入力%jは認証前に拒否", async patch => {
  const { deps } = setup();
  await expect(runReceiptsUpdate({ ...options, ...patch }, deps)).rejects.toThrow();
  expect(deps.getClient).not.toHaveBeenCalled();
  expect(deps.appendAudit).not.toHaveBeenCalled();
});
it.each([0, -999999999999, 999999999999])("dry-runはcurrentと指定項目だけのpayloadを返す: %s", async amount => {
  const { deps, fetchFn } = setup();
  expect(await runReceiptsUpdate({ ...options, amount }, deps)).toEqual({ mode: "dry-run", current, payload: { company_id: 1, receipt_metadatum: { amount } } });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(deps.appendAudit.mock.calls[0]![0]).toMatchObject({ event: "receipt_update", target_id: 5, status: "planned", payload_redacted: { current: { receipt_metadatum: { partner_name: "[REDACTED]", amount: 123 } }, payload: { receipt_metadatum: { amount } } } });
  expect(JSON.stringify(deps.appendAudit.mock.calls)).not.toContain("架空旧発行元");
});
it.each([{ company_id: 2 }, { id: 6 }])("GETの対象不一致%jでは更新しない", async patch => {
  const { deps, fetchFn } = setup();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ receipt: { ...current, ...patch } })));
  await expect(runReceiptsUpdate({ ...options, amount: 0, execute: true }, deps)).rejects.toThrow();
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
it.each([{ amount: 0 }, { partnerName: "架空新発行元" }, { issueDate: "2026-01-15" }, { partnerName: "", issueDate: "2026-01-15", amount: -2 }])("company_idなしの応答でも指定項目%jのみPUTしてGETで検証", async patch => {
  const { deps, fetchFn } = setup();
  const metadata = { ...(patch.amount === undefined ? {} : { amount: patch.amount }), ...(patch.partnerName === undefined ? {} : { partner_name: patch.partnerName }), ...(patch.issueDate === undefined ? {} : { issue_date: patch.issueDate }) };
  fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ receipt: current })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ receipt: { id: 5 } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ receipt: { ...current, receipt_metadatum: { ...current.receipt_metadatum, ...metadata } } })));
  const result = await runReceiptsUpdate({ ...options, ...patch, execute: true }, deps);
  expect(result.readback).toEqual({ ...(patch.amount === undefined ? {} : { amountMatches: true }), ...(patch.partnerName === undefined ? {} : { partnerNameMatches: true }), ...(patch.issueDate === undefined ? {} : { issueDateMatches: true }) });
  expect(JSON.parse(String(fetchFn.mock.calls[1]![1]?.body))).toEqual({ company_id: 1, receipt_metadatum: metadata });
  expect(fetchFn.mock.calls.map(c => c[1]?.method)).toEqual(["GET", "PUT", "GET"]);
  for (const [url, init] of fetchFn.mock.calls) {
    expect(new URL(url as string).pathname).toBe("/api/1/receipts/5");
    if (init?.method === "GET") expect(new URL(url as string).searchParams.get("company_id")).toBe("1");
  }
  expect(deps.appendAudit.mock.calls.map(c => c[0].status)).toEqual(["attempting", "succeeded"]);
});
it.each(["mismatch", "partner", "date", "missing-metadata", "network", "wrong-id", "wrong-company", "audit"]) ("更新後%sはID入り再実行禁止と監査を残す", async failure => {
  const { deps, fetchFn } = setup();
  fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ receipt: current }))).mockResolvedValueOnce(new Response(JSON.stringify({ receipt: { id: 5 } })));
  if (failure === "network") fetchFn.mockRejectedValueOnce(new Error("private"));
  else fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ receipt: { ...current, receipt_metadatum: failure === "missing-metadata" ? null : { partner_name: failure === "partner" ? "架空別発行元" : "架空発行元", issue_date: failure === "date" ? "2026-01-16" : "2026-01-15", amount: failure === "mismatch" || failure === "audit" ? 1 : 0 }, ...(failure === "wrong-id" ? { id: 6 } : {}), ...(failure === "wrong-company" ? { company_id: 2 } : {}) } })));
  if (failure === "audit") deps.appendAudit.mockImplementation(async entry => { if (entry.reason === "readback_failed") throw new Error("disk"); });
  await expect(runReceiptsUpdate({ ...options, amount: 0, partnerName: "架空発行元", issueDate: "2026-01-15", execute: true }, deps)).rejects.toThrow(/更新済み.*receipt_id=5.*再実行しない/);
  expect(deps.appendAudit.mock.calls.at(-1)![0]).toMatchObject({ write_state: "succeeded", reason: "readback_failed", target_id: 5 });
});
it("送信前の監査失敗ではPUTしない", async () => {
  const { deps, fetchFn } = setup();
  deps.appendAudit.mockRejectedValue(new Error("disk"));
  await expect(runReceiptsUpdate({ ...options, amount: 0, execute: true }, deps)).rejects.toThrow("not_attempted");
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
