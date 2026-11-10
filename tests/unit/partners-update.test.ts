import { describe, expect, it, vi } from "vitest";
import { FreeeApiError, PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { PartnerPlanError, parsePartnerPlan, parsePartnerUpdatePlan } from "../../src/domain/partner-plan.js";
import { PartnerUpdateGuardError, PartnerUpdateUnverifiedError, runPartnersUpdate } from "../../src/commands/partners/update.js";

const options = { companyId: 1, id: 100, planPath: "plan.json", execute: false, logDir: "audit", taskId: "task" };
const partner = (extra: Record<string, unknown> = {}) => ({ id: 100, company_id: 1, name: "現在名", ...extra });
const response = (value: Record<string, unknown>) => new Response(JSON.stringify({ partner: value }));
function deps(fetchFn = vi.fn()) {
  return { getClient: vi.fn(async () => new PublicFreeeClient({ baseUrl: "https://api.example.test", token: "token", fetchFn })), readFile: vi.fn(async () => JSON.stringify({ shortcut1: "next" })), appendAudit: vi.fn(async () => undefined), now: () => new Date("2026-09-08T00:00:00.000Z") };
}

describe("partner update plan", () => {
  it("makes name optional, accepts available, accepts only complete or null payment terms", () => {
    expect(parsePartnerUpdatePlan({ available: false })).toEqual({ available: false });
    expect(parsePartnerUpdatePlan({ payment_term_attributes: null })).toEqual({ payment_term_attributes: null });
    expect(parsePartnerUpdatePlan({ payment_term_attributes: { cutoff_day: 1, additional_months: 0, fixed_day: 1 } })).toEqual({ payment_term_attributes: { cutoff_day: 1, additional_months: 0, fixed_day: 1 } });
    for (const plan of [{}, { available: "false" }, { payment_term_attributes: { cutoff_day: 1 } }, { org_code: null }, { invoice_registration_number: null }, { partner_doc_setting_attributes: { sending_method: null } }, { code: "x" }, { payer_walletable_id: 1 }]) expect(() => parsePartnerUpdatePlan(plan)).toThrow(PartnerPlanError);
    expect(parsePartnerPlan({ name: "取引先", org_code: null, invoice_registration_number: null, partner_doc_setting_attributes: { sending_method: null } })).toBeTruthy();
  });
});

describe("partners update", () => {
  it("dry-run GETs once, never PUTs, emits leaf changes and a complete planned audit", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(partner({ shortcut1: "old", invoice_registration_number: "T1234567890123" })));
    const d = deps(fetchFn); d.readFile.mockResolvedValue(JSON.stringify({ shortcut1: "next", invoice_registration_number: "1234567890123" }));
    const result = await runPartnersUpdate(options, d);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ mode: "dry-run", companyId: 1, id: 100, current: { name: "現在名" }, changes: [{ path: "name", current: "現在名", next: "現在名", same: true }, { path: "shortcut1", current: "old", next: "next", same: false }, { path: "invoice_registration_number", current: "T1234567890123", next: "1234567890123", same: true }], payload: { company_id: 1, name: "現在名", shortcut1: "next", invoice_registration_number: "1234567890123" } });
    expect(d.appendAudit).toHaveBeenCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "dry-run", status: "planned", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, name: "[REDACTED]", shortcut1: "next", invoice_registration_number: "[REDACTED]" }, put_state: "not_attempted" });
  });

  it("guards execute before GET and guards both modes before PUT", async () => {
    const missing = deps(); await expect(runPartnersUpdate({ ...options, execute: true }, missing)).rejects.toMatchObject({ name: PartnerUpdateGuardError.name, reason: "mismatch:name" }); expect(missing.getClient).not.toHaveBeenCalled();
    for (const execute of [false, true]) { const fetchFn = vi.fn().mockResolvedValue(response(partner())); const d = deps(fetchFn); await expect(runPartnersUpdate({ ...options, execute, expectName: "別名" }, d)).rejects.toMatchObject({ reason: "mismatch:name" }); expect(fetchFn).toHaveBeenCalledTimes(1); }
  });

  it("records an unavailable client exactly once and preserves its original error", async () => {
    const unavailable = new Error("client unavailable");
    const d = deps(); d.getClient.mockRejectedValue(unavailable);
    await expect(runPartnersUpdate(options, d)).rejects.toBe(unavailable);
    expect(d.appendAudit).toHaveBeenCalledTimes(1);
    expect(d.appendAudit).toHaveBeenCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "dry-run", status: "failed", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, shortcut1: "next" }, reason: "client_unavailable", put_state: "not_attempted" });
  });

  it("wraps a rejected execute audit after a succeeded PUT as unverified", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner({ shortcut1: "next" })));
    const d = deps(fetchFn); d.appendAudit.mockRejectedValue(new Error("audit unavailable"));
    await expect(runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, d)).rejects.toMatchObject({ name: "PartnerUpdateUnverifiedError", reason: "audit_write_failed", putState: "succeeded" });
    expect(d.appendAudit).toHaveBeenCalledTimes(1);
    expect(d.appendAudit).toHaveBeenCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "execute", status: "updated", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, name: "[REDACTED]", shortcut1: "next" }, ignored: [], put_state: "succeeded" });
  });

  it("leaves a rejected dry-run audit error unwrapped", async () => {
    const d = deps(vi.fn().mockResolvedValue(response(partner()))); d.appendAudit.mockRejectedValue(new Error("audit unavailable"));
    await expect(runPartnersUpdate(options, d)).rejects.toMatchObject({ name: "AuditWriteError" });
    expect(d.appendAudit).toHaveBeenCalledTimes(1);
    expect(d.appendAudit).toHaveBeenCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "dry-run", status: "planned", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, name: "[REDACTED]", shortcut1: "next" }, put_state: "not_attempted" });
  });

  it("leaves a failed rejected-PUT audit write unwrapped", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(new Response("rejected", { status: 400 }));
    const d = deps(fetchFn); d.appendAudit.mockRejectedValue(new Error("audit unavailable"));
    await expect(runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, d)).rejects.toMatchObject({ name: "AuditWriteError" });
    expect(d.appendAudit).toHaveBeenCalledTimes(1);
    expect(d.appendAudit).toHaveBeenCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "execute", status: "failed", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, name: "[REDACTED]", shortcut1: "next" }, reason: "put_http:400", put_state: "rejected" });
  });

  it("uses audit_write_failed when a succeeded-PUT readback failure cannot be audited", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(new Response("failure", { status: 500 }));
    const d = deps(fetchFn); d.appendAudit.mockRejectedValue(new Error("audit unavailable"));
    await expect(runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, d)).rejects.toMatchObject({ name: PartnerUpdateUnverifiedError.name, reason: "audit_write_failed", putState: "succeeded" });
    expect(d.appendAudit).toHaveBeenCalledTimes(1);
    expect(d.appendAudit).toHaveBeenCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "execute", status: "failed", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, name: "[REDACTED]", shortcut1: "next" }, reason: "readback_http:500", put_state: "succeeded" });
  });

  it.each([
    ["HTTP 500", () => { throw new FreeeApiError({ status: 500, path: "/api/1/partners/100", bodySnippet: "" }); }, "initial_get_http:500", FreeeApiError.name],
    ["network failure", () => { throw new TypeError("network"); }, "initial_get_network", TypeError.name],
  ] as const)("records %s during the initial GET without wrapping the original error", async (_case, initialGet, reason, errorName) => {
    const d = deps();
    d.getClient.mockResolvedValue({ get: initialGet } as never);
    const error = await runPartnersUpdate(options, d).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: errorName });
    expect(error).not.toBeInstanceOf(PartnerUpdateUnverifiedError);
    expect(d.appendAudit).toHaveBeenLastCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "dry-run", status: "failed", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, shortcut1: "next" }, reason, put_state: "not_attempted" });
  });

  it("PUTs unwrapped payload with manual redirects, reads back, projects missing nulls, and audits updated exactly", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner({ available: false })) ).mockResolvedValueOnce(response(partner({ available: false })));
    const d = deps(fetchFn); d.readFile.mockResolvedValue(JSON.stringify({ available: false, payment_term_attributes: null }));
    const result = await runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, d);
    expect(JSON.parse(fetchFn.mock.calls[1]![1].body)).toEqual({ company_id: 1, name: "現在名", available: false, payment_term_attributes: null });
    expect(fetchFn.mock.calls[1]![1].redirect).toBe("manual");
    expect(result.updated).toEqual({ id: 100, name: "現在名", ignored: [] });
    expect(d.appendAudit).toHaveBeenCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "execute", status: "updated", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, name: "[REDACTED]", available: false, payment_term_attributes: null }, ignored: [], put_state: "succeeded" });
  });

  it("marks a different readback value ignored", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner({ shortcut1: "old" })));
    const result = await runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, deps(fetchFn));
    expect(result.updated?.ignored).toEqual(["shortcut1"]);
  });

  it.each([
    ["id mismatch", { id: 101, company_id: 1, name: "現在名" }, "PartnerUpdateGuardError", "mismatch:id"],
    ["company mismatch", { id: 100, company_id: 2, name: "現在名" }, "PartnerUpdateGuardError", "mismatch:company_id"],
    ["numeric name", { id: 100, company_id: 1, name: 1 }, "ResponseParseError", "invalid_response:/api/1/partners/100"],
    ["missing name", { id: 100, company_id: 1 }, "ResponseParseError", "invalid_response:/api/1/partners/100"],
  ] as const)("rejects %s in the initial GET and audits the exact failure", async (_case, initial, errorName, reason) => {
    const d = deps(vi.fn().mockResolvedValue(response(initial as Record<string, unknown>)));
    const error = await runPartnersUpdate(options, d).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: errorName });
    if (errorName === "PartnerUpdateGuardError") expect(error).toMatchObject({ reason: reason });
    expect(d.appendAudit).toHaveBeenLastCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "dry-run", status: "failed", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, shortcut1: "next" }, reason, put_state: "not_attempted" });
  });

  it.each([
    ["id mismatch", { id: 101, company_id: 1, name: "現在名" }, "mismatch:id"],
    ["company mismatch", { id: 100, company_id: 2, name: "現在名" }, "mismatch:company_id"],
    ["numeric name", { id: 100, company_id: 1, name: 1 }, "invalid_response:/api/1/partners/100"],
    ["missing name", { id: 100, company_id: 1 }, "invalid_response:/api/1/partners/100"],
  ] as const)("wraps %s in the readback GET and audits the exact succeeded PUT failure", async (_case, readback, reason) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(readback as Record<string, unknown>));
    const d = deps(fetchFn);
    const error = await runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, d).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: PartnerUpdateUnverifiedError.name, reason, putState: "succeeded" });
    expect(d.appendAudit).toHaveBeenLastCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "execute", status: "failed", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, name: "[REDACTED]", shortcut1: "next" }, reason, put_state: "succeeded" });
  });

  it.each([
    ["HTTP 500", () => { throw new FreeeApiError({ status: 500, path: "/api/1/partners/100", bodySnippet: "" }); }, "readback_http:500"],
    ["network failure", () => { throw new TypeError("network"); }, "readback_network"],
  ] as const)("records %s during the readback as a readback failure after a succeeded PUT", async (_case, readback, reason) => {
    const d = deps();
    d.getClient.mockResolvedValue({ get: vi.fn().mockResolvedValueOnce(response(partner())).mockImplementationOnce(readback), put: vi.fn(async () => response(partner())) } as never);
    const error = await runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, d).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: PartnerUpdateUnverifiedError.name, reason, putState: "succeeded" });
    expect(d.appendAudit).toHaveBeenLastCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "execute", status: "failed", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, name: "[REDACTED]", shortcut1: "next" }, reason, put_state: "succeeded" });
  });

  it.each([
    ["T1234567890123", []],
    ["T9876543210987", ["invoice_registration_number"]],
  ])("projects registration-number readback %s before calculating ignored", async (registration, ignored) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner({ invoice_registration_number: registration })));
    const d = deps(fetchFn); d.readFile.mockResolvedValue(JSON.stringify({ invoice_registration_number: "1234567890123" }));
    await expect(runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, d)).resolves.toMatchObject({ updated: { ignored } });
  });

  it("classifies every status from 100 through 599 and audits failures exactly", async () => {
    for (let status = 100; status <= 599; status += 1) {
      const d = deps(); d.getClient.mockResolvedValue({ get: async () => response(partner()), put: async () => { throw new FreeeApiError({ status, path: "/api/1/partners/100", bodySnippet: "" }); } } as never);
      const error = await runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, d).catch((caught: unknown) => caught);
      const state = [400, 401, 403, 404].includes(status) ? "rejected" : "unknown";
      if (state === "unknown") expect(error).toBeInstanceOf(PartnerUpdateUnverifiedError); else expect(error).toBeInstanceOf(FreeeApiError);
      expect(d.appendAudit).toHaveBeenLastCalledWith({ timestamp: "2026-09-08T00:00:00.000Z", task_id: "task", event: "partner_update", mode: "execute", status: "failed", company_id: 1, partner_id: 100, payload_redacted: { company_id: 1, name: "[REDACTED]", shortcut1: "next" }, reason: `put_http:${status}`, put_state: state });
    }
  });
});

describe("partners update: bank account", () => {
  const account = {
    bank_name: "サンプル銀行", bank_name_kana: "サンプルギンコウ", bank_code: "0001",
    branch_name: "テスト支店", branch_kana: "テストシテン", branch_code: "101",
    account_type: "ordinary", account_number: "1234567",
    long_account_name: "カブシキガイシャサンプル", account_name: "カブシキガイシャサンプル",
  };
  const existing = { ...account, bank_code: "0002", account_number: "7654321", account_name: "カンタロウ" };
  const bankDeps = (fetchFn = vi.fn()) => { const d = deps(fetchFn); d.readFile.mockResolvedValue(JSON.stringify({ partner_bank_account_attributes: account })); return d; };
  const execute = { ...options, execute: true, expectName: "現在名", expectAccountLast4: "4567" };
  const fullNumbers = /1234567|7654321/;

  it("dry-run by default: GETs once, never PUTs, shows masked current and next accounts side by side", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(partner({ partner_bank_account_attributes: existing })));
    const d = bankDeps(fetchFn);
    const result = await runPartnersUpdate(options, d);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe("dry-run");
    expect(result.bankAccount).toEqual({ registered: true, current: { ...existing, account_number: "***4321" }, next: { ...account, account_number: "***4567" } });
    expect(result.changes).toContainEqual({ path: "partner_bank_account_attributes.account_number", current: "***4321", next: "***4567", same: false });
    expect(JSON.stringify(result)).not.toMatch(fullNumbers);
    expect(JSON.stringify(d.appendAudit.mock.calls)).not.toMatch(fullNumbers);
    expect(d.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ status: "planned", payload_redacted: expect.objectContaining({ partner_bank_account_attributes: { ...account, account_number: "***4567" } }) }));
  });

  it("dry-run shows an unregistered current account as null and does not require the new flags", async () => {
    const result = await runPartnersUpdate(options, bankDeps(vi.fn().mockResolvedValue(response(partner()))));
    expect(result.bankAccount).toEqual({ registered: false, current: null, next: { ...account, account_number: "***4567" } });
  });

  it.each([
    ["missing --expect-account-last4", { expectAccountLast4: undefined }, "mismatch:account_last4"],
    ["different last four", { expectAccountLast4: "4566" }, "mismatch:account_last4"],
    ["leading digits instead of last four", { expectAccountLast4: "1234" }, "mismatch:account_last4"],
    ["non-four-digit value", { expectAccountLast4: "567" }, "invalid:expect_account_last4"],
    ["non-digit value", { expectAccountLast4: "45a7" }, "invalid:expect_account_last4"],
  ])("execute with %s stops before getClient", async (_case, extra, reason) => {
    const d = bankDeps();
    await expect(runPartnersUpdate({ ...execute, ...extra }, d)).rejects.toMatchObject({ name: PartnerUpdateGuardError.name, reason });
    expect(d.getClient).not.toHaveBeenCalled();
    expect(JSON.stringify(d.appendAudit.mock.calls)).not.toMatch(fullNumbers);
  });

  it("dry-run validates --expect-account-last4 when given", async () => {
    const d = bankDeps();
    await expect(runPartnersUpdate({ ...options, expectAccountLast4: "0000" }, d)).rejects.toMatchObject({ reason: "mismatch:account_last4" });
    expect(d.getClient).not.toHaveBeenCalled();
  });

  it("rejects --expect-account-last4 when the plan has no bank account", async () => {
    const d = deps();
    await expect(runPartnersUpdate({ ...options, expectAccountLast4: "4567" }, d)).rejects.toMatchObject({ reason: "unexpected:expect_account_last4" });
    expect(d.getClient).not.toHaveBeenCalled();
  });

  it("keeps ordinary updates working without the new flags", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner({ shortcut1: "next" })));
    const result = await runPartnersUpdate({ ...options, execute: true, expectName: "現在名" }, deps(fetchFn));
    expect(result.updated).toEqual({ id: 100, name: "現在名", ignored: [] });
    expect(result).not.toHaveProperty("bankAccount");
  });

  it("stops before PUT when an account is already registered and --allow-replace-bank-account is absent", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(partner({ partner_bank_account_attributes: existing })));
    const d = bankDeps(fetchFn);
    await expect(runPartnersUpdate(execute, d)).rejects.toMatchObject({ name: PartnerUpdateGuardError.name, reason: "bank_account_already_registered" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(d.appendAudit.mock.calls)).not.toMatch(fullNumbers);
  });

  it.each([
    ["missing key", partner()],
    ["all nulls", partner({ partner_bank_account_attributes: Object.fromEntries(Object.keys(account).map((key) => [key, null])) })],
    ["empty strings with default account_type", partner({ partner_bank_account_attributes: { ...Object.fromEntries(Object.keys(account).map((key) => [key, ""])), account_type: "ordinary" } })],
  ])("treats %s as unregistered and adds the account without --allow-replace-bank-account", async (_case, initial) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner({ partner_bank_account_attributes: account })));
    const result = await runPartnersUpdate(execute, bankDeps(fetchFn));
    expect(JSON.parse(fetchFn.mock.calls[1]![1].body)).toEqual({ company_id: 1, name: "現在名", partner_bank_account_attributes: account });
    expect(result.updated).toEqual({ id: 100, name: "現在名", ignored: [], bankAccount: { verified: true, account: { ...account, account_number: "***4567" } } });
  });

  it("replaces a registered account with --allow-replace-bank-account, sending the full number but printing it masked", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner({ partner_bank_account_attributes: existing }))).mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner({ partner_bank_account_attributes: account })));
    const d = bankDeps(fetchFn);
    const result = await runPartnersUpdate({ ...execute, allowReplaceBankAccount: true }, d);
    expect(JSON.parse(fetchFn.mock.calls[1]![1].body).partner_bank_account_attributes.account_number).toBe("1234567");
    expect(result.updated?.bankAccount?.verified).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(fullNumbers);
    expect(JSON.stringify(d.appendAudit.mock.calls)).not.toMatch(fullNumbers);
    expect(d.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "updated", payload_redacted: expect.objectContaining({ partner_bank_account_attributes: expect.objectContaining({ account_number: "***4567", account_name: "カブシキガイシャサンプル", bank_name: "サンプル銀行", branch_name: "テスト支店" }) }) }));
  });

  it.each([
    ["account_number", { ...account, account_number: "1234568" }],
    ["account_type", { ...account, account_type: "checking" }],
    ["account_name", { ...account, account_name: "サンプルカナ" }],
    ["missing account", undefined],
  ])("fails (not ignored) when the readback %s differs, without printing full numbers", async (field, after) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner())).mockResolvedValueOnce(response(partner(after ? { partner_bank_account_attributes: after } : {})));
    const d = bankDeps(fetchFn);
    const error = await runPartnersUpdate(execute, d).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartnerUpdateUnverifiedError);
    expect(error).toMatchObject({ putState: "succeeded" });
    expect((error as Error).message).toMatch(/bank_account_readback_mismatch/);
    if (after) expect((error as Error).message).toContain(`partner_bank_account_attributes.${field}`);
    expect((error as Error).message).not.toMatch(/1234567|1234568/);
    expect(JSON.stringify(d.appendAudit.mock.calls)).not.toMatch(/1234567|1234568/);
    expect(d.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", put_state: "succeeded" }));
  });
});
