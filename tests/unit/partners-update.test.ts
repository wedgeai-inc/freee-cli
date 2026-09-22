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
