import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInvoiceClient } from "../../src/lib/clients/freee-invoice-client.js";
import { FreeeApiError } from "../../src/lib/clients/freee-public-client.js";
import { createProgram } from "../../src/cli.js";
import { formatInvoiceUpdate, InvoiceUpdateGuardError, InvoiceUpdateUnverifiedError, RESPONSE_COPY_KEYS, RESPONSE_DROP_KEYS, RESPONSE_LINE_COPY_KEYS, RESPONSE_LINE_DROP_KEYS, PUT_RESPONSE_LINE_KEYS_LIST, PAYLOAD_CONSTRAINTS, PAYLOAD_ENUMS, UNOBSERVABLE_WARNING, runInvoicesUpdate, type InvoiceUpdateAuditEntry } from "../../src/commands/invoices/update.js";

const opts = { companyId: 999, id: 777, planPath: "plan.json", execute: false, logDir: "./audit", taskId: "update-test", allowDealRegistered: false };
const unobservable = { top: ["include_amount_brought_forward", "partner_contact_email_to", "partner_contact_email_cc", "partner_sending_method"], lines: ["account_item_id", "tax_code", "item_id", "section_id", "tag_ids", "segment_1_tag_id", "segment_2_tag_id", "segment_3_tag_id"] };
const invoice: Record<string, unknown> = {
  id: 777, company_id: 999, invoice_number: "INV-777", billing_date: "2026-09-08", tax_entry_method: "out", tax_fraction: "omit", withholding_tax_entry_method: "out", partner_title: "御中", partner_id: 2, subject: "before", memo: "memo", cancel_status: "uncanceled", deal_status: "unregistered", sending_status: "unsent", total_amount: 100,
  lines: [{ id: 9, type: "item", description: "old", quantity: 1, unit_price: "100", tax_rate: 10, amount_excluding_tax: 100 }],
};
const plan = { subject: "after" };
function deps(overrides: Partial<{ getClient: () => Promise<unknown>; readFile: () => Promise<string>; appendAudit: (entry: InvoiceUpdateAuditEntry) => Promise<void> }> = {}) {
  const audits: InvoiceUpdateAuditEntry[] = [];
  return { audits, getClient: overrides.getClient ?? (async () => ({ get: async () => ({ json: async () => ({ invoice }) }) })), readFile: overrides.readFile ?? (async () => JSON.stringify(plan)), appendAudit: overrides.appendAudit ?? (async (entry) => { audits.push(entry); }), now: () => new Date("2026-09-08T00:00:00Z") };
}
// oracle は OpenAPI から生成した固定ファイル（scripts/gen-iv-invoice-show-keys.mjs で再生成）。
// 実装の写像表から導出しないこと。導出すると写像表を変える変異を検出できなくなる。
const schemaKeys = JSON.parse(readFileSync("tests/fixtures/iv-invoice-show-keys.json", "utf8")) as { invoice: string[]; lines: string[]; requestEnums: Record<string, (string | number)[]>; requestConstraints: Record<string, unknown>; putResponseLines: string[] };
describe("invoices update", () => {
  it("classifies every schema-generated GET key exactly once", () => {
    expect(new Set([...RESPONSE_COPY_KEYS, ...RESPONSE_DROP_KEYS])).toEqual(new Set(schemaKeys.invoice));
    expect(RESPONSE_COPY_KEYS.some((key) => (RESPONSE_DROP_KEYS as readonly string[]).includes(key))).toBe(false);
    expect(new Set([...RESPONSE_LINE_COPY_KEYS, ...RESPONSE_LINE_DROP_KEYS])).toEqual(new Set(schemaKeys.lines));
    expect(RESPONSE_LINE_COPY_KEYS.some((key) => (RESPONSE_LINE_DROP_KEYS as readonly string[]).includes(key))).toBe(false);
  });
  it("matches the OpenAPI PUT response line keys exactly (oracle は仕様側)", () => {
    expect(new Set(PUT_RESPONSE_LINE_KEYS_LIST)).toEqual(new Set(schemaKeys.putResponseLines));
  });
  it("accepts a schema-valid PUT response line that carries required and accounting keys", async () => {
    const planWithLines = { lines: [{ type: "item", description: "new", quantity: 2, unit_price: ".5", tax_rate: 10 }] };
    // 応答は required な withholding、nullable、取引登録用の会計項目を含む。送ったキーだけを照合する
    const responseLine = { id: 11, type: "item", description: "new", quantity: 2, unit_price: "0.500", tax_rate: 10, withholding: false, reduced_tax_rate: false, unit: null, sales_date: null, amount_excluding_tax: 1, account_item_id: 5, tax_code: 2, item_id: 3, section_id: 4, tag_ids: [7], segment_1_tag_id: 1, segment_2_tag_id: 2, segment_3_tag_id: 3 };
    const d = deps({ readFile: async () => JSON.stringify(planWithLines), getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice: { ...invoice, lines: [responseLine] } }) }) }) });
    const result = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never);
    expect(result.updated).toMatchObject({ id: 777 });
  });
  it("treats an unknown PUT response line key as unverified", async () => {
    const planWithLines = { lines: [{ type: "item", description: "new", quantity: 2, unit_price: "20", tax_rate: 10 }] };
    const responseLine = { id: 11, type: "item", description: "new", quantity: 2, unit_price: "20.0", tax_rate: 10, withholding: false, future_line_key: true };
    const d = deps({ readFile: async () => JSON.stringify(planWithLines), getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice: { ...invoice, lines: [responseLine] } }) }) }) });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e);
    expect(error).toMatchObject({ putState: "succeeded", reason: "mismatch:lines" });
  });
  it("matches the OpenAPI enums exactly (oracle は仕様側。実装から導出しない)", () => {
    expect(PAYLOAD_ENUMS).toEqual(schemaKeys.requestEnums);
  });
  it("matches the OpenAPI request constraints exactly (oracle は仕様側。実装から導出しない)", () => {
    expect(schemaKeys.requestConstraints).toBeDefined();
    expect(PAYLOAD_CONSTRAINTS).toBeDefined();
    expect(PAYLOAD_CONSTRAINTS).toEqual(schemaKeys.requestConstraints);
  });
  it.each([
    ["over-long subject", { subject: "x".repeat(256) }],
    ["invalid zipcode", { partner_address_zipcode: "invalid" }],
    ["fractional amount brought forward", { amount_brought_forward: 1.5 }],
    ["out-of-range branch number", { branch_no: -1 }],
    ["invalid date format", { billing_date: "2026/09/08" }],
  ])("rejects a top-level constraint violation before PUT (%s)", async (_label, patch) => {
    const put = vi.fn(); const d = deps({ readFile: async () => "{}", getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, ...patch } }) }), put }) });
    await expect(runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never)).rejects.toThrow(/invalid response \/invoices\/777/);
    expect(put).not.toHaveBeenCalled();
  });
  it.each([
    { label: "payment_type: card", current: { payment_type: "card" } },
  ])("accepts a schema-valid current value that create's plan contract rejects ($label)", async ({ current }) => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, ...current } }) }) }) });
    const result = await runInvoicesUpdate(opts, d as never);
    expect(result.payload).toMatchObject(current);
  });
  it("normalizes a full-width blank partner title in dry-run and successful PUT", async () => {
    const put = vi.fn(async () => ({ json: async () => ({ invoice: { ...invoice, subject: "after", partner_title: "(空白)" } }) }));
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, partner_title: "（空白）" } }) }), put }) });
    const result = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never);
    expect(result.payload.partner_title).toBe("(空白)");
    expect(result.changes).toContainEqual({ path: "partner_title", current: "（空白）", next: "(空白)", same: false });
    expect(put).toHaveBeenCalledWith("/invoices/777", expect.objectContaining({ body: expect.objectContaining({ partner_title: "(空白)" }) }));
    expect(result.updated).toMatchObject({ id: 777 });
  });
  // 読み戻しの明細照合は無条件。plan が lines に触れない更新でも応答を検証する
  it.each([
    { label: "応答が lines を落とす", mutate: (base: Record<string, unknown>) => { const { lines: _drop, ...rest } = base; return rest; } },
    { label: "応答が lines を別物へ差し替える", mutate: (base: Record<string, unknown>) => ({ ...base, lines: [{ id: 99, type: "item", description: "別物", quantity: 9, unit_price: "9", tax_rate: 10, withholding: false }] }) },
  ])("verifies the response lines even when the plan does not touch them ($label)", async ({ mutate }) => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice: mutate({ ...invoice, subject: "after" }) }) }) }) });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(InvoiceUpdateUnverifiedError);
    expect(error).toMatchObject({ putState: "succeeded", reason: "mismatch:lines" });
  });
  // GET で required かつ補完の記述が無いキー（EMPTY_AS_UNSET）だけを落とす。**minLength からは導出しない**
  // （導出すると、省略時に取引先マスタから補完される項目まで落として帳票の宛先が変わる）。
  // 落とさないと「メモ未設定の請求書はそもそも更新できない」ことになる
  it.each(["memo", "subject"])("treats an empty current %s as unset instead of blocking the update", async (key) => {
    // plan は当該キーを上書きしない（既定 plan は subject を持つので空 plan を渡す）
    const d = deps({ readFile: async () => "{}", getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, [key]: "" } }) }) }) });
    const result = await runInvoicesUpdate(opts, d as never);
    expect(result.payload).not.toHaveProperty(key);
  });
  // 省略すると取引先マスタから補完される項目は落とさない。落とすと無関係な更新で帳票の宛先が変わる
  it.each(["partner_contact_department", "partner_contact_name", "partner_address_street_name1", "partner_address_zipcode"])("rejects an empty current %s instead of silently substituting the partner master", async (key) => {
    const put = vi.fn(); const d = deps({ readFile: async () => "{}", getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, [key]: "" } }) }), put }) });
    await expect(runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never)).rejects.toThrow(/invalid response/);
    expect(put).not.toHaveBeenCalled();
  });
  it("keeps an empty invoice_note because the request allows minLength 0", async () => {
    const d = deps({ readFile: async () => "{}", getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, invoice_note: "" } }) }) }) });
    const result = await runInvoicesUpdate(opts, d as never);
    expect(result.payload.invoice_note).toBe("");
  });
  it("read-modify-writes the full current body and only overlays the plan", async () => {
    const d = deps(); const result = await runInvoicesUpdate(opts, d as never);
    expect(result.payload).toMatchObject({ company_id: 999, billing_date: "2026-09-08", subject: "after", memo: "memo", lines: [{ type: "item", description: "old", quantity: 1, unit_price: "100", tax_rate: 10 }] });
    expect(result.changes).toContainEqual({ path: "subject", current: "before", next: "after", same: false });
    expect(result.unobservable).toEqual(unobservable); expect(d.audits).toEqual([expect.objectContaining({ status: "planned", put_state: "not_attempted", payload_redacted: expect.anything() })]);
  });
  it("updates a schema-valid GET fixture with a text line, nullable values, and null partner_code", async () => {
    const schemaValid = { ...invoice, partner_code: null, payment_date: null, lines: [
      { id: 9, type: "text", description: "note", withholding: false, sales_date: null, quantity: null, unit_price: null, tax_rate: null, amount_excluding_tax: 0 },
    ] };
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: schemaValid }) }) }) });
    const result = await runInvoicesUpdate(opts, d as never);
    // text 行は type / description だけを送る（完全一致で固定する）
    expect(result.payload.lines).toEqual([{ type: "text", description: "note" }]);
    expect(result.payload).toMatchObject({ company_id: 999, subject: "after" });
    expect(result.payload).not.toHaveProperty("partner_code"); expect(result.payload).not.toHaveProperty("payment_date");
  });
  it.each([
    { label: "quantity 欠落", line: { type: "item", description: "item", unit_price: "100", tax_rate: 10 } },
    { label: "tax_rate 欠落", line: { type: "item", description: "item", quantity: 1, unit_price: "100" } },
    { label: "quantity が 0", line: { type: "item", description: "item", quantity: 0, unit_price: "100", tax_rate: 10 } },
    { label: "quantity が上限超過", line: { type: "item", description: "item", quantity: 100_000_000, unit_price: "100", tax_rate: 10 } },
    { label: "quantity が Infinity", line: { type: "item", description: "item", quantity: Infinity, unit_price: "100", tax_rate: 10 } },
    { label: "unit_price の書式違反", line: { type: "item", description: "item", quantity: 1, unit_price: "1.2345", tax_rate: 10 } },
    { label: "sales_date の書式違反", line: { type: "item", description: "item", quantity: 1, unit_price: "100", tax_rate: 10, sales_date: "2026/09/08" } },
    { label: "description が空", line: { type: "item", description: "", quantity: 1, unit_price: "100", tax_rate: 10 } },
    { label: "description が長過ぎる", line: { type: "item", description: "x".repeat(256), quantity: 1, unit_price: "100", tax_rate: 10 } },
    { label: "reduced_tax_rate と tax_rate が不整合", line: { type: "item", description: "item", quantity: 1, unit_price: "100", tax_rate: 10, reduced_tax_rate: true } },
  ])("rejects an incomplete or invalid item line from GET ($label)", async ({ line }) => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, lines: [{ id: 9, amount_excluding_tax: 0, ...line }] } }) }) }) });
    await expect(runInvoicesUpdate(opts, d as never)).rejects.toThrow(/invalid response \/invoices\/777/);
  });
  it("strips copied item fields from a text line", async () => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, lines: [{ id: 9, type: "text", description: "note", withholding: false, amount_excluding_tax: 0 }] } }) }) }) });
    // copyLine drops text extras, so this remains the valid text request form.
    await expect(runInvoicesUpdate(opts, d as never)).resolves.toMatchObject({ payload: { lines: [{ type: "text", description: "note" }] } });
  });
  it("replaces lines as an array and emits indexed changes", async () => {
    const d = deps({ readFile: async () => JSON.stringify({ lines: [{ type: "item", description: "new", quantity: 2, unit_price: "20", tax_rate: 10 }, { type: "text", description: "note" }] }) }); const result = await runInvoicesUpdate(opts, d as never);
    expect(result.payload.lines).toHaveLength(2); expect(result.changes.map((x) => x.path)).toContain("lines[1].description");
  });
  it.each([
    { label: "top-level", mutate: (base: Record<string, unknown>) => ({ ...base, future_key: true }), reason: "unmapped_response_key:future_key" },
    { label: "lines[]", mutate: (base: Record<string, unknown>) => ({ ...base, lines: [{ ...(base.lines as Record<string, unknown>[])[0], future_line_key: true }] }), reason: "unmapped_response_key:lines[].future_line_key" },
  ])("fails closed on an unmapped GET key ($label) without PUT", async ({ mutate, reason }) => {
    const put = vi.fn(); const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: mutate(invoice) }) }), put }) });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(InvoiceUpdateGuardError); expect((error as InvoiceUpdateGuardError).reason).toBe(reason); expect(put).not.toHaveBeenCalled(); expect(d.audits[0]).toMatchObject({ status: "failed", put_state: "not_attempted" });
  });
  // reason まで固定する。instanceof だけだと reason を入れ替える変異が KILL されない
  it.each([
    { patch: { cancel_status: "canceled" }, reason: "canceled" },
    { patch: { deal_status: "registered" }, reason: "deal_registered" },
    { patch: { company_id: 1000 }, reason: "mismatch:company_id" },
    { patch: { invoice_number: "OTHER" }, reason: "mismatch:invoice_number" },
  ])("guards unsafe targets ($reason)", async ({ patch, reason }) => {
    const put = vi.fn(); const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, ...patch } }) }), put }) }); const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(InvoiceUpdateGuardError); expect(error).toMatchObject({ reason }); expect(put).not.toHaveBeenCalled();
  });
  it("requires the expected number before GET in execute mode", async () => { const d = deps(); await expect(runInvoicesUpdate({ ...opts, execute: true }, d as never)).rejects.toMatchObject({ reason: "mismatch:invoice_number" }); });
  it.each([400, 401, 403, 404, 408, 429, 500])("records the closed PUT-state table for %i", async (status) => {
    const audits: InvoiceUpdateAuditEntry[] = []; const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => { throw new FreeeApiError({ status, path: "/invoices/777", bodySnippet: "" }); } }), appendAudit: async (entry) => { audits.push(entry); } });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e); expect(audits).toHaveLength(1); expect(audits[0]).toMatchObject({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "update-test", event: "invoice_update", mode: "execute", status: "failed", company_id: 999, invoice_id: 777, reason: `put_http:${status}`, put_state: [400, 401, 403, 404].includes(status) ? "rejected" : "unknown" }); expect(Object.keys(audits[0]!).sort()).toEqual(["company_id", "event", "invoice_id", "mode", "payload_redacted", "put_state", "reason", "status", "task_id", "timestamp"]); if ([400, 401, 403, 404].includes(status)) expect(error).not.toBeInstanceOf(InvoiceUpdateUnverifiedError); else expect(error).toBeInstanceOf(InvoiceUpdateUnverifiedError);
  });
  // reason まで固定する。instanceof だけだと、別の検査が代わりに落としても通ってしまう
  it.each([
    { patch: { id: 778 }, reason: "mismatch:id" },
    { patch: { company_id: 1000 }, reason: "mismatch:company_id" },
    { patch: { invoice_number: 1 }, reason: "invalid_response:/invoices/777" },
    { patch: { total_amount: "1" }, reason: "invalid_response:/invoices/777" },
  ])("treats invalid successful readback as succeeded but unverified ($patch)", async ({ patch, reason }) => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice: { ...invoice, ...patch } }) }) }) }); const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e); expect(error).toBeInstanceOf(InvoiceUpdateUnverifiedError); expect(error).toMatchObject({ putState: "succeeded", reason });
  });
  it("treats a successful response that did not apply a planned top-level field as unverified", async () => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice: { ...invoice, subject: "before" } }) }) }) });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(InvoiceUpdateUnverifiedError); expect(error).toMatchObject({ putState: "succeeded", reason: "mismatch:subject" });
  });
  it.each(["success", "guard rejection", "PUT failure"])("always writes the fixed warning to stderr on %s", async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), "invoice-update-warning-")); const planPath = join(dir, "plan.json"); writeFileSync(planPath, JSON.stringify(plan));
    const getInvoice = scenario === "guard rejection" ? { ...invoice, cancel_status: "canceled" } : invoice;
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice: getInvoice }), { status: 200 })); if (scenario === "success") fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ invoice }), { status: 200 })); if (scenario === "PUT failure") fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));
    let warningCalls = 0; const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => { if (message === UNOBSERVABLE_WARNING) warningCalls += 1; }); const logSpy = vi.spyOn(console, "log").mockImplementation(() => {}); vi.stubGlobal("fetch", fetchMock); process.env.FREEE_ACCESS_TOKEN = "test";
    try { await createProgram().parseAsync(["invoices", "update", "--company-id", "999", "--id", "777", "--plan", planPath, "--expect-invoice-number", "INV-777", ...(scenario === "guard rejection" ? [] : ["--execute"]), "--log-dir", dir], { from: "user" }).catch(() => {}); } finally { vi.unstubAllGlobals(); errorSpy.mockRestore(); logSpy.mockRestore(); delete process.env.FREEE_ACCESS_TOKEN; }
    expect(warningCalls).toBe(1);
  });
  // PUT が unknown（5xx / 通信断）になった後、失敗記録の audit も失敗する組合せ。
  // audit の失敗を put_* で覆い隠さない（cancel と同じ意味論）
  it.each([
    { label: "PUT 500", put: async () => { throw new FreeeApiError({ status: 500, path: "/invoices/777", bodySnippet: "" }); } },
    { label: "PUT 通信断", put: async () => { throw new Error("socket hang up"); } },
  ])("reports audit_write_failed when the failure audit also fails after $label", async ({ put }) => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put }), appendAudit: async () => { throw new Error("disk full"); } });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(InvoiceUpdateUnverifiedError);
    expect(error).toMatchObject({ putState: "unknown", reason: "audit_write_failed" });
  });
  it("reports an audit write failure after a successful PUT as audit_write_failed", async () => {
    const updatedInvoice = { ...invoice, subject: "after" };
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice: updatedInvoice }) }) }), appendAudit: async () => { throw new Error("disk full"); } });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(InvoiceUpdateUnverifiedError);
    // audit の失敗は audit_write_failed として伝える（put_network 等へ誤分類しない）
    expect(error).toMatchObject({ putState: "succeeded", reason: "audit_write_failed" });
  });
  it("records updated audit exactly and wires CLI --execute to PUT", async () => {
    const updatedInvoice = { ...invoice, subject: "after" }; const audit: InvoiceUpdateAuditEntry[] = []; const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice: updatedInvoice }) }) }), appendAudit: async (entry) => { audit.push(entry); } });
    await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never);
    expect(audit).toEqual([{ timestamp: "2026-09-08T00:00:00.000Z", task_id: "update-test", event: "invoice_update", mode: "execute", status: "updated", company_id: 999, invoice_id: 777, payload_redacted: expect.anything(), put_state: "succeeded" }]);
    const dir = mkdtempSync(join(tmpdir(), "invoice-update-cli-")); const planPath = join(dir, "plan.json"); writeFileSync(planPath, JSON.stringify(plan)); const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ invoice: updatedInvoice }), { status: 200 })); const logSpy = vi.spyOn(console, "log").mockImplementation(() => {}); const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {}); vi.stubGlobal("fetch", fetchMock); process.env.FREEE_ACCESS_TOKEN = "test";
    try { await createProgram().parseAsync(["invoices", "update", "--company-id", "999", "--id", "777", "--plan", planPath, "--expect-invoice-number", "INV-777", "--execute", "--log-dir", dir], { from: "user" }); } finally { vi.unstubAllGlobals(); logSpy.mockRestore(); errorSpy.mockRestore(); delete process.env.FREEE_ACCESS_TOKEN; }
    expect(fetchMock).toHaveBeenCalledTimes(2); expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("PUT");
  });
  it("echo-compares lines with unit_price treated as a decimal value", async () => {
    const planWithLines = { lines: [{ type: "item", description: "new", quantity: 2, unit_price: "20", tax_rate: 10 }] };
    // 応答は API 正規化後の形（id が付き、unit_price が "20.0" になる）。十進値として同値なので通る
    const normalized = { ...invoice, lines: [{ id: 11, type: "item", description: "new", quantity: 2, unit_price: "20.0", tax_rate: 10, amount_excluding_tax: 40 }] };
    const d = deps({ readFile: async () => JSON.stringify(planWithLines), getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice: normalized }) }) }) });
    const result = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never);
    expect(result.updated).toMatchObject({ id: 777 });
  });
  it("treats an unchanged or missing lines response as succeeded but unverified", async () => {
    const planWithLines = { lines: [{ type: "item", description: "new", quantity: 2, unit_price: "20", tax_rate: 10 }] };
    const d = deps({ readFile: async () => JSON.stringify(planWithLines), getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice }) }) }) });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((value) => value);
    expect(error).toBeInstanceOf(InvoiceUpdateUnverifiedError);
    expect(error).toMatchObject({ putState: "succeeded", reason: "mismatch:lines" });
  });
  it("treats a response without lines as succeeded but unverified", async () => {
    const planWithLines = { lines: [{ type: "item", description: "new", quantity: 2, unit_price: "20", tax_rate: 10 }] };
    const { lines: _lines, ...withoutLines } = invoice;
    const d = deps({ readFile: async () => JSON.stringify(planWithLines), getClient: async () => ({ get: async () => ({ json: async () => ({ invoice }) }), put: async () => ({ json: async () => ({ invoice: withoutLines }) }) }) });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((value) => value);
    expect(error).toMatchObject({ putState: "succeeded", reason: "mismatch:lines" });
  });
  // InvoiceRequest は partner_id / partner_code の「どちらか一方を必ず」要求する。
  // 排他化だけでは 0 個を許すため、境界（0・負・空文字・欠落）まで固定する
  it.each([
    { label: "現在値が partner_id のみ", current: { partner_id: 2 }, expect: { partner_id: 2 } },
    { label: "現在値が partner_code のみ", current: { partner_code: "SOM-001" }, expect: { partner_code: "SOM-001" } },
    { label: "現在値が両方（partner_id を優先）", current: { partner_id: 2, partner_code: "SOM-001" }, expect: { partner_id: 2 } },
    { label: "partner_id が不正で partner_code が有効", current: { partner_id: 0, partner_code: "SOM-001" }, expect: { partner_code: "SOM-001" } },
  ])("keeps exactly one current partner selector ($label)", async ({ current, expect: want }) => {
    const base: Record<string, unknown> = { ...invoice }; delete base.partner_id;
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...base, ...current } }) }) }) });
    const result = await runInvoicesUpdate(opts, d as never);
    const selectors = Object.fromEntries(Object.entries(result.payload).filter(([k]) => k === "partner_id" || k === "partner_code"));
    expect(selectors).toEqual(want);
  });
  it.each([
    { label: "どちらも無い", current: {} },
    { label: "partner_id が 0", current: { partner_id: 0 } },
    { label: "partner_id が負", current: { partner_id: -1 } },
    { label: "partner_code が空文字", current: { partner_code: "" } },
    { label: "partner_id が非整数", current: { partner_id: 1.5 } },
    { label: "partner_id が安全整数を超える", current: { partner_id: 2 ** 53 } },
  ])("rejects a GET response without a usable partner selector ($label)", async ({ current }) => {
    const put = vi.fn(); const base: Record<string, unknown> = { ...invoice }; delete base.partner_id;
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...base, ...current } }) }), put }) });
    await expect(runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never)).rejects.toThrow(/invalid response/);
    expect(put).not.toHaveBeenCalled();
  });
  it("accepts a plan that selects the partner by code", async () => {
    const d = deps({ readFile: async () => JSON.stringify({ partner_code: "SOM-001" }) });
    const result = await runInvoicesUpdate(opts, d as never);
    expect(Object.fromEntries(Object.entries(result.payload).filter(([key]) => key === "partner_id" || key === "partner_code"))).toEqual({ partner_code: "SOM-001" });
  });
  it("keeps exactly one current partner selector, preferring partner_id", async () => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, partner_code: "OLD-001" } }) }) }) });
    const result = await runInvoicesUpdate(opts, d as never);
    expect(Object.fromEntries(Object.entries(result.payload).filter(([key]) => key === "partner_id" || key === "partner_code"))).toEqual({ partner_id: 2 });
  });
  it.each(["cancel_status", "deal_status", "sending_status"] as const)("rejects an unknown %s before PUT", async (field) => {
    const put = vi.fn(); const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, [field]: "future" } }) }), put }) });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain("invalid response /invoices/777"); expect(put).not.toHaveBeenCalled();
  });
  it("normalizes an omitted item type before computing dry-run totals", async () => {
    const d = deps({ readFile: async () => JSON.stringify({ lines: [{ description: "new", quantity: 2, unit_price: "100", tax_rate: 10 }] }) });
    const result = await runInvoicesUpdate(opts, d as never);
    expect(result.payload.lines).toEqual([{ type: "item", description: "new", quantity: 2, unit_price: "100", tax_rate: 10 }]);
    expect(result.totals).toMatchObject({ subtotal: 200, total: 220 });
  });
  it.each(["company_id", "billing_date", "tax_entry_method", "tax_fraction", "withholding_tax_entry_method", "partner_title", "lines"] as const)("rejects missing required payload key %s in dry-run", async (field) => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, [field]: null } }) }) }) });
    const error = await runInvoicesUpdate(opts, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain("invalid response /invoices/777");
  });
  it.each([
    ["tax_entry_method", "other"], ["tax_fraction", "floor"], ["withholding_tax_entry_method", "other"], ["partner_title", "先生"], ["lines", []],
  ])("rejects invalid payload value %s in dry-run", async (field, value) => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, [field]: value } }) }) }) });
    const error = await runInvoicesUpdate(opts, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain("invalid response /invoices/777");
  });
  it("formats only actionable changes with their count", async () => {
    const result = await runInvoicesUpdate(opts, deps() as never);
    const formatted = formatInvoiceUpdate(result);
    expect(formatted).toContain("changes: 1"); expect(formatted).toContain("subject: \"before\" -> \"after\""); expect(formatted).not.toContain("billing_date:");
  });
  it.each([
    ["date", { billing_date: 123 }],
    ["enum", { payment_type: "future" }],
    ["number", { branch_no: "1" }],
    ["string", { invoice_note: 123 }],
    ["line enum", { lines: [{ ...(invoice.lines as Record<string, unknown>[])[0], type: "future" }] }],
    ["line boolean", { lines: [{ ...(invoice.lines as Record<string, unknown>[])[0], withholding: "false" }] }],
  ])("rejects a payload %s type violation before PUT", async (_label, patch) => {
    const put = vi.fn(); const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, ...patch } }) }), put }) });
    const error = await runInvoicesUpdate({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, d as never).catch((e) => e);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain("invalid response /invoices/777"); expect(put).not.toHaveBeenCalled();
  });
  it("rejects a non-integer line tag_ids array before any request", async () => {
    const get = vi.fn(); const d = deps({ readFile: async () => JSON.stringify({ lines: [{ type: "item", description: "new", quantity: 1, unit_price: "100", tax_rate: 10, tag_ids: [1, "2"] }] }), getClient: async () => ({ get }) });
    await expect(runInvoicesUpdate(opts, d as never)).rejects.toThrow(/invoice plan/);
    expect(get).not.toHaveBeenCalled();
  });
  it.each([
    { label: "0 を含む", tag_ids: [0] },
    { label: "11 件", tag_ids: Array.from({ length: 11 }, (_, index) => index + 1) },
  ])("rejects line tag_ids that are not at most ten positive integers ($label)", async ({ tag_ids }) => {
    const get = vi.fn(); const d = deps({ readFile: async () => JSON.stringify({ lines: [{ type: "item", description: "new", quantity: 1, unit_price: "100", tax_rate: 10, tag_ids }] }), getClient: async () => ({ get }) });
    await expect(runInvoicesUpdate(opts, d as never)).rejects.toThrow(/invoice plan/);
    expect(get).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(256)])("rejects an invalid text description from GET", async (description) => {
    const d = deps({ getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, lines: [{ id: 9, type: "text", description, amount_excluding_tax: 0 }] } }) }) }) });
    await expect(runInvoicesUpdate(opts, d as never)).rejects.toThrow(/invalid response \/invoices\/777/);
  });
  it("redacts every update-specific PII and bank value from the audit entry", async () => {
    const sensitive = { partner_contact_name: "Contact Person", partner_contact_department: "Sales", partner_display_name: "Display", partner_address_zipcode: "100-0001", partner_address_prefecture_code: 13, partner_address_street_name1: "Street 1", partner_address_street_name2: "Street 2", partner_bank_account: "Bank Account", bank_account_to_transfer: "Transfer Account", company_contact_name: "Company Contact", partner_contact_email_to: "to@example.test", partner_contact_email_cc: "cc@example.test" };
    const { partner_contact_email_to, partner_contact_email_cc, ...getSensitive } = sensitive; const d = deps({ readFile: async () => JSON.stringify({ partner_contact_email_to, partner_contact_email_cc, lines: [{ type: "item", description: "new", quantity: 1, unit_price: "100", tax_rate: 10, tag_ids: [1] }] }), getClient: async () => ({ get: async () => ({ json: async () => ({ invoice: { ...invoice, ...getSensitive } }) }) }) }); await runInvoicesUpdate(opts, d as never);
    const serialized = JSON.stringify(d.audits[0]); for (const value of Object.values(sensitive)) expect(serialized).not.toContain(String(value));
  });
  it.each([
    ["plan invalid", { readFile: async () => "{" }, "plan_invalid"],
    ["plan read", { readFile: async () => { throw new Error("ENOENT"); } }, "plan_read_failed"],
    ["readback network", { getClient: async () => ({ get: async () => { throw new TypeError("network"); } }) }, "readback_network"],
  ])("records phase-correct audit reason for %s", async (_label, overrides, expectedReason) => {
    const audits: InvoiceUpdateAuditEntry[] = []; const error = await runInvoicesUpdate(opts, { ...deps(overrides as never), appendAudit: async (entry: InvoiceUpdateAuditEntry) => { audits.push(entry); } } as never).catch((e) => e);
    expect(error).toBeInstanceOf(Error); expect(audits).toEqual([expect.objectContaining({ status: "failed", reason: expectedReason, put_state: "not_attempted" })]);
  });
  it.each([
    { label: "未知キー", plan: { bogus: 1 } },
    // 既存 parser は日付の形式のみを見る（暦の妥当性は見ない）。ここで固定するのは形式違反
    { label: "形式違反の billing_date", plan: { billing_date: "2026-9-8" } },
    { label: "不正な tax_fraction", plan: { tax_fraction: "floor" } },
    { label: "不正な明細の quantity", plan: { lines: [{ type: "item", description: "x", quantity: -1, unit_price: "10", tax_rate: 10 }] } },
    { label: "partner_id と partner_code の併記", plan: { partner_id: 2, partner_code: "SOM-001" } },
  ])("rejects an invalid plan ($label) before any request", async ({ plan: invalid }) => {
    const get = vi.fn(); const d = deps({ readFile: async () => JSON.stringify(invalid), getClient: async () => ({ get }) });
    await expect(runInvoicesUpdate(opts, d as never)).rejects.toThrow(/invoice plan/);
    expect(get).not.toHaveBeenCalled();
  });
});
