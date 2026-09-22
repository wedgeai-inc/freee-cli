import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FreeeApiError } from "../../src/lib/clients/freee-public-client.js";
import { appendInvoiceUncancelAudit } from "../../src/lib/audit/invoice-audit.js";
import { appendQuotationUncancelAudit } from "../../src/lib/audit/quotation-audit.js";
import { InvoiceUncancelAuditWriteError, InvoiceUncancelGuardError, InvoiceUncancelResponseParseError, InvoiceUncancelUnverifiedError, runInvoicesUncancel } from "../../src/commands/invoices/uncancel.js";
import { QuotationUncancelAuditWriteError, QuotationUncancelGuardError, QuotationUncancelResponseParseError, QuotationUncancelUnverifiedError, runQuotationsUncancel } from "../../src/commands/quotations/uncancel.js";
import { createProgram } from "../../src/cli.js";
import { runInvoicesCancel } from "../../src/commands/invoices/cancel.js";

const now = () => new Date("2026-09-08T00:00:00Z");
const invoice = { id: 7, company_id: 9, invoice_number: "INV-7", total_amount: 10, partner_id: 2, cancel_status: "canceled" };
const quotation = { id: 7, company_id: 9, quotation_number: "Q-7", total_amount: 10, partner_id: 2, cancel_status: "canceled" };

const subjects = [
  { name: "invoice", run: runInvoicesUncancel, AuditWriteError: InvoiceUncancelAuditWriteError, GuardError: InvoiceUncancelGuardError, ResponseError: InvoiceUncancelResponseParseError, UnverifiedError: InvoiceUncancelUnverifiedError, entity: "invoice", number: "invoice_number", event: "invoice_uncancel", append: appendInvoiceUncancelAudit },
  { name: "quotation", run: runQuotationsUncancel, AuditWriteError: QuotationUncancelAuditWriteError, GuardError: QuotationUncancelGuardError, ResponseError: QuotationUncancelResponseParseError, UnverifiedError: QuotationUncancelUnverifiedError, entity: "quotation", number: "quotation_number", event: "quotation_uncancel", append: appendQuotationUncancelAudit },
] as const;

for (const subject of subjects) describe(`${subject.name} uncancel`, () => {
  const target: Record<string, unknown> = subject.entity === "invoice" ? invoice : quotation;
  const options = { companyId: 9, id: 7, execute: false, logDir: "unused", taskId: " exact-task ", ...(subject.entity === "invoice" ? { expectInvoiceNumber: target[subject.number] as string } : { expectQuotationNumber: target[subject.number] as string }) };
  const getClient = (value = target, put?: () => Promise<Response>) => async () => ({ get: async () => new Response(JSON.stringify({ [subject.entity]: value })), put }) as never;
  const audit = { task_id: " exact-task ", event: subject.event, mode: "dry-run", company_id: 9, [subject.entity + "_id"]: 7 };

  it("dry-run only GETs a canceled target and writes exact planned audit", async () => {
    const entries: unknown[] = []; const result = await subject.run(options as never, { getClient: getClient(), appendAudit: async (e: unknown) => { entries.push(e); }, now } as never);
    expect(result).toMatchObject({ mode: "dry-run", id: 7 });
    expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, status: "planned", put_state: "not_attempted" }]);
  });

  it.each([false, true])("uses the state table for canceled, uncanceled, and invalid GET status in execute=%s", async (execute) => {
    for (const [cancelStatus, reason] of [["canceled", undefined], ["uncanceled", "not_canceled"], ["other", `invalid_response:/${subject.entity}s/7`], [undefined, `invalid_response:/${subject.entity}s/7`], [null, `invalid_response:/${subject.entity}s/7`]] as const) {
      const entries: unknown[] = []; const put = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: { id: 7, cancel_status: "uncanceled" } })));
      const error = await subject.run({ ...options, execute } as never, { getClient: getClient({ ...target, cancel_status: cancelStatus }, put), appendAudit: async (e: unknown) => { entries.push(e); }, now } as never).catch(e => e);
      if (reason) { expect(error).toBeInstanceOf(reason === "not_canceled" ? subject.GuardError : subject.ResponseError); if (reason === "not_canceled") expect((error as { reason: string }).reason).toBe(reason); expect(put).not.toHaveBeenCalled(); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: execute ? "execute" : "dry-run", status: "failed", reason: reason as string, put_state: "not_attempted" }]); }
      else if (execute) { expect(error).not.toBeInstanceOf(Error); expect(put).toHaveBeenCalledTimes(1); }
      else { expect(error).not.toBeInstanceOf(Error); expect(put).not.toHaveBeenCalled(); }
    }
  });

  it.each(Array.from({ length: 500 }, (_, index) => index + 100))("classifies status %i with exact audit and exception", async (status) => {
    const entries: unknown[] = []; const error = await subject.run({ ...options, execute: true } as never, { getClient: getClient(target, async () => { throw new FreeeApiError({ status, path: `/${subject.entity}s/7/uncancel`, bodySnippet: "" }); }), appendAudit: async (e: unknown) => { entries.push(e); }, now } as never).catch(e => e);
    const state = [400, 401, 403, 404].includes(status) ? "rejected" : "unknown";
    expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "failed", reason: `put_http:${status}`, put_state: state }]);
    if (state === "rejected") expect(error).toBeInstanceOf(FreeeApiError); else { expect(error).toBeInstanceOf(subject.UnverifiedError); expect((error as { reason: string }).reason).toBe(`put_http:${status}`); }
  });

  it("preserves audit-write failure through an unverified PUT", async () => {
    const error = await subject.run({ ...options, execute: true } as never, { getClient: getClient(target, async () => { throw new FreeeApiError({ status: 500, path: "x", bodySnippet: "" }); }), appendAudit: async () => { throw new Error("disk full"); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.UnverifiedError); expect((error as { reason: string }).reason).toBe("audit_write_failed");
  });

  it("surfaces AuditWriteError when a rejected PUT cannot be audited", async () => {
    const error = await subject.run({ ...options, execute: true } as never, { getClient: getClient(target, async () => { throw new FreeeApiError({ status: 400, path: "x", bodySnippet: "" }); }), appendAudit: async () => { throw new Error("disk full"); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.AuditWriteError);
  });

  it("audits client acquisition failure exactly once", async () => {
    const entries: unknown[] = []; const error = await subject.run(options as never, { getClient: async () => { throw new Error("no client"); }, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(Error); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, status: "failed", reason: "client_unavailable", put_state: "not_attempted" }]);
  });

  it("execute は期待番号なしでは認証前に拒否し、監査を一度だけ残す", async () => {
    const entries: unknown[] = []; const getClient = vi.fn(); const missingExpectation = { ...options, execute: true } as Record<string, unknown>;
    delete missingExpectation[subject.entity === "invoice" ? "expectInvoiceNumber" : "expectQuotationNumber"];
    const error = await subject.run(missingExpectation as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.GuardError); expect((error as { reason: string }).reason).toBe(`mismatch:${subject.number}`); expect(getClient).not.toHaveBeenCalled();
    expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "failed", reason: `mismatch:${subject.number}`, put_state: "not_attempted" }]);
  });

  it.each(["canceled", undefined, "other"] as const)("PUT 後の cancel_status=%s を未検証として監査し包む", async (cancelStatus) => {
    const entries: unknown[] = []; const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: target }))); const put = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: { id: 7, ...(cancelStatus === undefined ? {} : { cancel_status: cancelStatus }) } }))); const client = { get, put }; const getClient = vi.fn().mockResolvedValue(client);
    const error = await subject.run({ ...options, execute: true } as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.UnverifiedError); expect((error as { reason: string; putState: string }).reason).toBe("mismatch:cancel_status"); expect((error as { putState: string }).putState).toBe("succeeded");
    expect(getClient).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledTimes(1); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "failed", reason: "mismatch:cancel_status", put_state: "succeeded" }]);
  });

  it("PUT 後の別 ID を未検証として監査し包む", async () => {
    const entries: unknown[] = []; const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: target }))); const put = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: { id: 8, cancel_status: "uncanceled" } }))); const client = { get, put }; const getClient = vi.fn().mockResolvedValue(client);
    const error = await subject.run({ ...options, execute: true } as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.UnverifiedError); expect((error as { reason: string; putState: string }).reason).toBe("mismatch:id"); expect((error as { putState: string }).putState).toBe("succeeded");
    expect(getClient).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledTimes(1); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "failed", reason: "mismatch:id", put_state: "succeeded" }]);
  });

  it.each([
    ["total_amount 欠落", (() => { const { total_amount, ...rest } = target as Record<string, unknown>; return rest; })()],
    ["partner_id 欠落", (() => { const { partner_id, ...rest } = target as Record<string, unknown>; return rest; })()],
    ["company_id 非数値", { ...target, company_id: "9" }],
    [`${subject.number} 非文字列`, { ...target, [subject.number]: 7 }],
  ])("GET の応答形状が %s なら invalid_response として監査し PUT しない", async (_name, malformed) => {
    const entries: unknown[] = []; const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: malformed }))); const put = vi.fn(); const getClient = vi.fn().mockResolvedValue({ get, put });
    const error = await subject.run({ ...options, execute: true } as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.ResponseError); expect(put).not.toHaveBeenCalled();
    expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "failed", reason: `invalid_response:/${subject.entity}s/7`, put_state: "not_attempted" }]);
  });

  it.each([[{ ...target, id: 8 }, "mismatch:id"], [{ ...target, company_id: 10 }, "mismatch:company_id"]] as const)("GET の身元不一致 %s では PUT せず failed audit を残す", async (mismatchedTarget, reason) => {
    const entries: unknown[] = []; const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: mismatchedTarget }))); const put = vi.fn(); const getClient = vi.fn().mockResolvedValue({ get, put });
    const error = await subject.run({ ...options, execute: true } as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.GuardError); expect((error as { reason: string }).reason).toBe(reason); expect(getClient).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(put).not.toHaveBeenCalled(); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "failed", reason, put_state: "not_attempted" }]);
  });

  it.each([[new FreeeApiError({ status: 500, path: "/x", bodySnippet: "" }), "initial_get_http:500"], [new TypeError("network"), "initial_get_network"]] as const)("初回 GET の失敗を %s として監査する", async (getFailure, reason) => {
    const entries: unknown[] = []; const get = vi.fn().mockRejectedValue(getFailure); const put = vi.fn(); const getClient = vi.fn().mockResolvedValue({ get, put });
    const error = await subject.run(options as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBe(getFailure); expect(getClient).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(put).not.toHaveBeenCalled(); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, status: "failed", reason, put_state: "not_attempted" }]);
  });

  it("PUT の通信失敗を未検証として監査し包む", async () => {
    const entries: unknown[] = []; const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: target }))); const put = vi.fn().mockRejectedValue(new TypeError("network")); const getClient = vi.fn().mockResolvedValue({ get, put });
    const error = await subject.run({ ...options, execute: true } as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.UnverifiedError); expect((error as { reason: string; putState: string }).reason).toBe("put_network"); expect((error as { putState: string }).putState).toBe("unknown"); expect(getClient).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledTimes(1); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "failed", reason: "put_network", put_state: "unknown" }]);
  });

  it("成功した PUT の audit 書込み失敗を未検証として包む", async () => {
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: target }))); const put = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: { id: 7, cancel_status: "uncanceled" } }))); const getClient = vi.fn().mockResolvedValue({ get, put }); const appendAudit = vi.fn().mockRejectedValue(new Error("disk full"));
    const error = await subject.run({ ...options, execute: true } as never, { getClient, appendAudit, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.UnverifiedError); expect((error as { reason: string; putState: string }).reason).toBe("audit_write_failed"); expect((error as { putState: string }).putState).toBe("succeeded"); expect(getClient).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledTimes(1); expect(appendAudit).toHaveBeenCalledTimes(1);
  });

  it("dry-run の期待番号不一致では PUT せず failed audit を残す", async () => {
    const entries: unknown[] = []; const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: target }))); const put = vi.fn(); const getClient = vi.fn().mockResolvedValue({ get, put }); const wrongNumber = "other-number";
    const opts = subject.entity === "invoice" ? { ...options, expectInvoiceNumber: wrongNumber } : { ...options, expectQuotationNumber: wrongNumber };
    const error = await subject.run(opts as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.GuardError); expect((error as { reason: string }).reason).toBe(`mismatch:${subject.number}`); expect(getClient).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(put).not.toHaveBeenCalled(); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, status: "failed", reason: `mismatch:${subject.number}`, put_state: "not_attempted" }]);
  });

  it("番号不一致は状態異常より先に停止し、PUT しない", async () => {
    const entries: unknown[] = []; const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: { ...target, cancel_status: "uncanceled" } }))); const put = vi.fn(); const getClient = vi.fn().mockResolvedValue({ get, put }); const wrongNumber = "other-number";
    const opts = subject.entity === "invoice" ? { ...options, execute: true, expectInvoiceNumber: wrongNumber } : { ...options, execute: true, expectQuotationNumber: wrongNumber };
    const error = await subject.run(opts as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.GuardError); expect((error as { reason: string }).reason).toBe(`mismatch:${subject.number}`); expect(getClient).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(put).not.toHaveBeenCalled(); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "failed", reason: `mismatch:${subject.number}`, put_state: "not_attempted" }]);
  });

  it("PUTs only after the guards, with company_id and manual redirect", async () => {
    const put = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: { id: 7, cancel_status: "uncanceled" } }))); const entries: unknown[] = [];
    const result = await subject.run({ ...options, execute: true } as never, { getClient: getClient(target, put), appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never);
    expect(put).toHaveBeenCalledWith(`/${subject.entity}s/7/uncancel`, { body: { company_id: 9 }, redirect: "manual" }); expect(result).toMatchObject({ uncanceled: { id: 7, cancel_status: "uncanceled" } }); expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "uncanceled", put_state: "succeeded" }]);
  });

  it("writes an audit file and refuses bearer or email leakage", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${subject.name}-uncancel-`)); const entry = { timestamp: now().toISOString(), ...audit, status: "planned" as const, put_state: "not_attempted" as const };
    await subject.append(dir, entry as never); const content = readFileSync(join(dir, `freee-${subject.name}-uncancel-2026-09-08.jsonl`), "utf8"); expect(JSON.parse(content)).toEqual(entry);
    await expect(subject.append(dir, { ...entry, task_id: "Bearer secret" } as never)).rejects.toThrow(/redact/);
  });
});

for (const subject of subjects) describe(`${subject.name} uncancel の応答解析と CLI execute`, () => {
  const target: Record<string, unknown> = subject.entity === "invoice" ? invoice : quotation;
  const options = { companyId: 9, id: 7, execute: false, logDir: "unused", taskId: " exact-task ", ...(subject.entity === "invoice" ? { expectInvoiceNumber: target[subject.number] as string } : { expectQuotationNumber: target[subject.number] as string }) };
  const audit = { task_id: " exact-task ", event: subject.event, mode: "dry-run", company_id: 9, [subject.entity + "_id"]: 7 };

  // parseJson の catch を外すと reason が initial_get_network / put_network へ落ちる
  it("初回 GET の壊れた JSON を invalid_response として監査する", async () => {
    const entries: unknown[] = []; const get = vi.fn().mockResolvedValue(new Response("not json")); const put = vi.fn(); const getClient = vi.fn().mockResolvedValue({ get, put });
    const error = await subject.run(options as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.ResponseError); expect(put).not.toHaveBeenCalled();
    expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, status: "failed", reason: `invalid_response:/${subject.entity}s/7`, put_state: "not_attempted" }]);
  });

  it("PUT 応答の壊れた JSON を invalid_response として監査する", async () => {
    const entries: unknown[] = []; const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [subject.entity]: target }))); const put = vi.fn().mockResolvedValue(new Response("not json")); const getClient = vi.fn().mockResolvedValue({ get, put });
    const error = await subject.run({ ...options, execute: true } as never, { getClient, appendAudit: async (entry: unknown) => { entries.push(entry); }, now } as never).catch(e => e);
    expect(error).toBeInstanceOf(subject.UnverifiedError); expect((error as { reason: string }).reason).toBe(`invalid_response:/${subject.entity}s/7/uncancel`);
    expect(entries).toEqual([{ timestamp: now().toISOString(), ...audit, mode: "execute", status: "failed", reason: `invalid_response:/${subject.entity}s/7/uncancel`, put_state: "succeeded" }]);
  });

  // CLI 配線を execute: false に固定しても、不一致は dry-run でも起きるため既存テストは通る
  it("CLI は --execute で GET のあと PUT する", async () => {
    const number = target[subject.number] as string;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ [subject.entity]: target })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ [subject.entity]: { id: 7, cancel_status: "uncanceled" } })));
    const prior = process.env.FREEE_ACCESS_TOKEN; process.env.FREEE_ACCESS_TOKEN = "test"; vi.stubGlobal("fetch", fetchMock); const log = vi.spyOn(console, "log").mockImplementation(() => {}); const dir = mkdtempSync(join(tmpdir(), "uncancel-cli-execute-"));
    const option = subject.entity === "invoice" ? "expect-invoice-number" : "expect-quotation-number";
    try { await createProgram().parseAsync([`${subject.entity}s`, "uncancel", "--company-id", "9", "--id", "7", "--execute", `--${option}`, number, "--log-dir", dir], { from: "user" }); }
    finally { log.mockRestore(); vi.unstubAllGlobals(); if (prior === undefined) delete process.env.FREEE_ACCESS_TOKEN; else process.env.FREEE_ACCESS_TOKEN = prior; }
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "PUT"]);
  });
});

describe("invoice cancel and uncancel ID boundary", () => {
  it.each([[0, false], [1, true], [2_147_483_647, true], [2_147_483_648, false]] as const)("both commands apply the same boundary to id=%i", async (id, valid) => {
    const cancelClient = vi.fn().mockResolvedValue({ get: vi.fn().mockResolvedValue(new Response(JSON.stringify({ invoice: { ...invoice, id, deal_status: "unregistered" } }))) }); const uncancelClient = vi.fn().mockResolvedValue({ get: vi.fn().mockResolvedValue(new Response(JSON.stringify({ invoice: { ...invoice, id } }))) });
    const cancel = runInvoicesCancel({ companyId: 9, id, execute: false, logDir: "unused", taskId: "id-boundary", allowDealDeletion: false }, { getClient: cancelClient, appendAudit: async () => {}, now });
    const restore = runInvoicesUncancel({ companyId: 9, id, execute: false, logDir: "unused", taskId: "id-boundary" }, { getClient: uncancelClient, appendAudit: async () => {}, now });
    if (valid) { await expect(cancel).resolves.toMatchObject({ id }); await expect(restore).resolves.toMatchObject({ id }); expect(cancelClient).toHaveBeenCalledTimes(1); expect(uncancelClient).toHaveBeenCalledTimes(1); }
    else { await expect(cancel).rejects.toThrow("--id must be an integer between 1 and 2147483647"); await expect(restore).rejects.toThrow("--id must be an integer between 1 and 2147483647"); expect(cancelClient).not.toHaveBeenCalled(); expect(uncancelClient).not.toHaveBeenCalled(); }
  });
});

describe("uncancel CLI", () => {
  it.each(["invoices", "quotations"] as const)("%s rejects an out-of-range ID before authentication", async (plural) => {
    const prior = process.env.FREEE_ACCESS_TOKEN; process.env.FREEE_ACCESS_TOKEN = "";
    try { await expect(createProgram().parseAsync([plural, "uncancel", "--company-id", "9", "--id", "2147483648"], { from: "user" })).rejects.toThrow("--id must be an integer between 1 and 2147483647"); }
    finally { if (prior === undefined) delete process.env.FREEE_ACCESS_TOKEN; else process.env.FREEE_ACCESS_TOKEN = prior; }
  });
  it.each([["invoices", "invoice", "invoice_number", "INV-7", "expect-invoice-number"], ["quotations", "quotation", "quotation_number", "Q-7", "expect-quotation-number"]] as const)("%s は期待番号と GET の path / query を加工せずに渡す", async (plural, entity, number, expected, option) => {
    const spaced = ` ${expected} `;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [entity]: { ...(entity === "invoice" ? invoice : quotation), cancel_status: "canceled", [number]: spaced } })));
    const prior = process.env.FREEE_ACCESS_TOKEN; process.env.FREEE_ACCESS_TOKEN = "test"; vi.stubGlobal("fetch", fetchMock); const log = vi.spyOn(console, "log").mockImplementation(() => {}); const dir = mkdtempSync(join(tmpdir(), "uncancel-cli-forward-"));
    try { await createProgram().parseAsync([plural, "uncancel", "--company-id", "9", "--id", "7", `--${option}`, spaced, "--log-dir", dir], { from: "user" }); }
    finally { log.mockRestore(); vi.unstubAllGlobals(); if (prior === undefined) delete process.env.FREEE_ACCESS_TOKEN; else process.env.FREEE_ACCESS_TOKEN = prior; }
    // 前後に空白を含む期待番号が trim されずに応答と一致する（trim されるとここで mismatch になる）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/iv/${plural}/7`);
    expect(url.searchParams.get("company_id")).toBe("9");
  });

  it.each([["invoices", "invoice", "invoice_number", "INV-7"], ["quotations", "quotation", "quotation_number", "Q-7"]] as const)("%s does not authenticate for malformed args and preserves task id", async (plural, entity, number, expected) => {
    const previous = process.env.FREEE_ACCESS_TOKEN; process.env.FREEE_ACCESS_TOKEN = "";
    try { await expect(createProgram().parseAsync([plural, "uncancel", "--company-id", "bad", "--id", "7"], { from: "user" })).rejects.toThrow(/company-id/); }
    finally { if (previous === undefined) delete process.env.FREEE_ACCESS_TOKEN; else process.env.FREEE_ACCESS_TOKEN = previous; }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [entity]: { ...(entity === "invoice" ? invoice : quotation), cancel_status: "canceled", [number]: expected } })));
    const prior = process.env.FREEE_ACCESS_TOKEN; process.env.FREEE_ACCESS_TOKEN = "test"; vi.stubGlobal("fetch", fetchMock); const log = vi.spyOn(console, "log").mockImplementation(() => {}); const dir = mkdtempSync(join(tmpdir(), "uncancel-cli-"));
    try { await createProgram().parseAsync([plural, "uncancel", "--company-id", "9", "--id", "7", "--task-id", " exact-task ", "--log-dir", dir], { from: "user" }); }
    finally { log.mockRestore(); vi.unstubAllGlobals(); if (prior === undefined) delete process.env.FREEE_ACCESS_TOKEN; else process.env.FREEE_ACCESS_TOKEN = prior; }
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["GET"]); const content = readFileSync(join(dir, `freee-${entity}-uncancel-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8"); expect(JSON.parse(content).task_id).toBe(" exact-task ");
  });
  it.each([["invoices", "invoice", "invoice_number", "INV-7", "expect-invoice-number"], ["quotations", "quotation", "quotation_number", "Q-7", "expect-quotation-number"]] as const)("%s mismatch does not PUT", async (plural, entity, number, expected, option) => {
    const prior = process.env.FREEE_ACCESS_TOKEN; process.env.FREEE_ACCESS_TOKEN = "test"; const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ [entity]: { ...(entity === "invoice" ? invoice : quotation), [number]: expected } }))); vi.stubGlobal("fetch", fetchMock); const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try { await expect(createProgram().parseAsync([plural, "uncancel", "--company-id", "9", "--id", "7", "--execute", `--${option}`, "wrong"], { from: "user" })).rejects.toThrow(/mismatch/); }
    finally { log.mockRestore(); vi.unstubAllGlobals(); if (prior === undefined) delete process.env.FREEE_ACCESS_TOKEN; else process.env.FREEE_ACCESS_TOKEN = prior; }
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["GET"]);
  });
});
