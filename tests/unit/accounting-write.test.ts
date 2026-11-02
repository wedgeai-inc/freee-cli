import { expect, it, vi } from "vitest";
import { auditedAccountingWrite } from "../../src/lib/accounting-write.js";
import { FreeeApiError } from "../../src/lib/clients/freee-public-client.js";
import type { DealAuditEntry } from "../../src/lib/audit/deal-audit.js";
const base = { event: "deal_create" as const, mode: "execute" as const, company_id: 1, task_id: "sample", payload_redacted: {} };
const now = () => new Date("2026-01-15T00:00:00Z");
it("監査保存失敗は送信前に止め、送信後の失敗は結果不明として記録し、元のエラーを公開しない", async () => {
  const send = vi.fn(async () => new Response('{"deal":{"id":6}}'));
  await expect(auditedAccountingWrite(base, { now, appendAudit: async () => { throw new Error("private-audit-value"); } }, send, "deal")).rejects.toThrow("audit write failed");
  expect(send).not.toHaveBeenCalled();
  const failures = [new Error("private-transport-value"), new FreeeApiError({ status: 503, path: "/api/1/deals", bodySnippet: "private-response" }), new FreeeApiError({ status: 422, path: "/api/1/deals", bodySnippet: "private-response" })];
  for (const failure of failures) {
    const appendAudit = vi.fn<(entry: DealAuditEntry) => Promise<void>>().mockResolvedValue(undefined);
    const error = await auditedAccountingWrite(base, { now, appendAudit }, async () => { throw failure; }, "deal").catch(e => e);
    expect(error.message).toContain("再実行");
    expect(error.message).not.toContain("private-");
    expect(appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", write_state: failure instanceof FreeeApiError && failure.status === 422 ? "rejected" : "unknown" }));
  }
  const appendAudit = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("private-audit-value")).mockResolvedValue(undefined);
  await expect(auditedAccountingWrite(base, { now, appendAudit }, send, "deal")).rejects.toThrow("作成・更新済み");
  expect(appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", created_id: 6, write_state: "succeeded" }));
});
it("作成応答のID・事業所と更新対象IDを照合し、不正な応答では成功にしない", async () => {
  for (const payload of ["not-json", "{}", '{"deal":{"id":0}}', '{"deal":{"id":6,"company_id":2}}', '{"deal":{"id":7,"company_id":1}}']) {
    const appendAudit = vi.fn().mockResolvedValue(undefined);
    await expect(auditedAccountingWrite({ ...base, target_id: 6 }, { now, appendAudit }, async () => new Response(payload), "deal")).rejects.toThrow("作成・更新済み");
    expect(appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", write_state: "succeeded", reason: "invalid_response" }));
  }
});
