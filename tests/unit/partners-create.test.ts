import { describe, expect, it, vi } from "vitest";
import { FreeeApiError, PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { formatPartnerCreate, PartnerCreatedButUnverifiedError, runPartnersCreate } from "../../src/commands/partners/create.js";
import { PARTNER_PLAN_FIELDS } from "../../src/domain/partner-plan.js";

const options = { companyId: 1, planPath: "plan.json", execute: false, logDir: "audit", taskId: "task" };
const plan = JSON.stringify({ name: "取引先", shortcut1: "one", invoice_payment_term_attributes: { cutoff_day: 32, additional_months: 1, fixed_day: 32 } });

function deps(fetchFn = vi.fn()) {
  return {
    getClient: vi.fn(async () => new PublicFreeeClient({ baseUrl: "https://api.example.test", token: "token", fetchFn })),
    readFile: vi.fn(async () => plan), appendAudit: vi.fn(async () => undefined), now: () => new Date("2026-09-07T00:00:00.000Z"),
  };
}
const response = (partner: Record<string, unknown>, status = 200) => new Response(JSON.stringify({ partner }), { status });
const post = () => response({ id: 2 }, 201);
const basePartner = () => ({ id: 2, company_id: 1, name: "取引先", code: null });
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target;
  for (const key of path.slice(0, -1)) current = (current[key] ??= {}) as Record<string, unknown>;
  current[path.at(-1)!] = value;
}
function fullMetadataPlan(): Record<string, unknown> {
  const plan: Record<string, unknown> = {};
  for (const field of PARTNER_PLAN_FIELDS) setPath(plan, field.path, field.validValue);
  return plan;
}

describe("partners create", () => {
  it("dry-run neither gets a client nor fetches and audits planned", async () => {
    const d = deps();
    await expect(runPartnersCreate(options, d)).resolves.toMatchObject({ mode: "dry-run", payload: { company_id: 1, name: "取引先" } });
    expect(d.getClient).not.toHaveBeenCalled();
    expect(d.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ status: "planned" }));
  });

  it("redacts partner PII before passing a dry-run audit entry to its dependency", async () => {
    const rawPii = {
      name_kana: "トリヒキサキ", contact_name: "担当者", phone: "03-1234-5678",
      invoice_registration_number: "T1234567890123",
      address_attributes: { zipcode: "1000001", street_name1: "千代田", street_name2: "1-1" },
    };
    const d = deps(); d.readFile.mockResolvedValue(JSON.stringify({ name: "取引先", ...rawPii }));
    await expect(runPartnersCreate(options, d)).resolves.toMatchObject({ mode: "dry-run" });
    const entry = (d.appendAudit.mock.calls as unknown[][])[0]![0] as { payload_redacted: unknown };
    expect(entry.payload_redacted).toEqual(expect.objectContaining({
      name_kana: "[REDACTED]", contact_name: "[REDACTED]", phone: "[REDACTED]", invoice_registration_number: "[REDACTED]",
      address_attributes: { zipcode: "[REDACTED]", street_name1: "[REDACTED]", street_name2: "[REDACTED]" },
    }));
    for (const value of [rawPii.name_kana, rawPii.contact_name, rawPii.phone, rawPii.invoice_registration_number, ...Object.values(rawPii.address_attributes)]) expect(JSON.stringify(entry)).not.toContain(value);
  });

  // 応答は必ず { partner: {...} } でラップされる。ラップ無しを受理する形へ緩めると
  // freee 側の形式変更に気づけなくなるので、拒否することを固定する
  it("rejects an unwrapped POST response envelope", async () => {
    // response() は { partner: ... } でラップするので、ここでは生の Response を使う
    const unwrapped = () => new Response(JSON.stringify({ id: 2, company_id: 1, name: "取引先", code: null }), { status: 201 });
    const d = deps(vi.fn().mockResolvedValue(unwrapped()));
    const error = await runPartnersCreate({ ...options, execute: true }, d).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartnerCreatedButUnverifiedError);
    expect(error).toMatchObject({ reason: "invalid_response:/api/1/partners", postState: "succeeded", createdId: undefined });
  });

  it("posts an unwrapped payload then reads the wrapped response", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ partner: { id: 2 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ partner: { id: 2, company_id: 1, name: "取引先", code: null, shortcut1: "one", invoice_payment_term_attributes: { cutoff_day: 32, additional_months: 1, fixed_day: 32 } } }), { status: 200 }));
    const d = deps(fetchFn);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).resolves.toMatchObject({ created: { id: 2, name: "取引先", ignored: [] } });
    expect(JSON.parse(fetchFn.mock.calls[0]![1].body)).toMatchObject({ company_id: 1, name: "取引先" });
    expect(JSON.parse(fetchFn.mock.calls[0]![1].body)).not.toHaveProperty("partner");
    expect(fetchFn.mock.calls[1]![0]).toContain("/api/1/partners/2?company_id=1");
    expect(d.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "created", mode: "execute", created_id: 2, ignored: [], post_state: "succeeded" }));
  });

  it("treats any post-success readback failure as non-rerunnable", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ partner: { id: 2 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ partner: { id: 2, company_id: 1, name: "別名", code: null } }), { status: 200 }));
    await expect(runPartnersCreate({ ...options, execute: true }, deps(fetchFn))).rejects.toMatchObject({
      name: PartnerCreatedButUnverifiedError.name, reason: "mismatch:name", postState: "succeeded", createdId: 2,
    });
  });

  it("reports a nonempty ignored list in the result, audit entry, and formatted output", async () => {
    const source = JSON.stringify({ name: "取引先", invoice_payment_term_attributes: { cutoff_day: 1 } });
    const fetchFn = vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response({ ...basePartner(), invoice_payment_term_attributes: { cutoff_day: 2 } }));
    const d = deps(fetchFn); d.readFile.mockResolvedValue(source);
    const result = await runPartnersCreate({ ...options, execute: true }, d);
    expect(result.created?.ignored).toEqual(["invoice_payment_term_attributes.cutoff_day"]);
    expect(d.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ ignored: ["invoice_payment_term_attributes.cutoff_day"] }));
    expect(JSON.parse(formatPartnerCreate(result))).toMatchObject({ created: { ignored: ["invoice_payment_term_attributes.cutoff_day"] } });
  });

  it("does not accept a readback from another company", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ partner: { id: 2 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ partner: { id: 2, company_id: 9, name: "取引先", code: null } }), { status: 200 }));
    await expect(runPartnersCreate({ ...options, execute: true }, deps(fetchFn))).rejects.toMatchObject({ reason: "mismatch:company_id", postState: "succeeded" });
  });

  // 302 is reachable here only through a stub: fetch follows redirect statuses in production.
  it.each([[500, "unknown"], [302, "unknown"]])("classifies POST %i as %s", async (status, state) => {
    const d = deps(vi.fn().mockResolvedValue(new Response("failure", { status })));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ postState: state, reason: `post_http:${status}` });
  });

  // 103 is reachable here only through an injected client stub.
  it("classifies an injected 103 POST as unknown", async () => {
    const d = deps();
    d.getClient.mockResolvedValue({ post: async () => { throw new (await import("../../src/lib/clients/freee-public-client.js")).FreeeApiError({ status: 103, path: "/api/1/partners", bodySnippet: "" }); } } as never);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ postState: "unknown", reason: "post_http:103" });
  });

  it("normalizes only the request-side registration number", async () => {
    const source = JSON.stringify({ name: "取引先", invoice_registration_number: "1234567890123" });
    const fetchFn = vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response({ ...basePartner(), invoice_registration_number: "T1234567890123" }));
    const d = deps(fetchFn); d.readFile.mockResolvedValue(source);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).resolves.toMatchObject({ created: { ignored: [] } });
  });

  it.each(["1234567890123", "T0123456789012"]) ("rejects malformed response registration number %s", async (registration) => {
    const source = JSON.stringify({ name: "取引先", invoice_registration_number: "1234567890123" });
    const fetchFn = vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response({ ...basePartner(), invoice_registration_number: registration }));
    const d = deps(fetchFn); d.readFile.mockResolvedValue(source);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "invalid_response:/api/1/partners/2" });
  });

  it.each([[null, []], [undefined, ["invoice_registration_number"]]])("handles registration response %j by contract", async (registration, ignored) => {
    const source = JSON.stringify({ name: "取引先", invoice_registration_number: registration === null ? null : "1234567890123" });
    const detail: Record<string, unknown> = { ...basePartner() }; if (registration !== undefined) detail.invoice_registration_number = registration;
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response(detail))); d.readFile.mockResolvedValue(source);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).resolves.toMatchObject({ created: { ignored } });
  });

  it("keeps rejected POST rerunnable", async () => {
    const d = deps(vi.fn().mockResolvedValue(new Response("bad", { status: 400 })));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.not.toBeInstanceOf(PartnerCreatedButUnverifiedError);
    expect(d.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", post_state: "rejected", reason: "post_http:400" }));
  });

  it.each(["succeeded", "unknown"] as const)("wraps audit failure after a %s POST", async (state) => {
    const d = deps(state === "succeeded" ? vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response(basePartner())) : vi.fn().mockResolvedValue(new Response("bad", { status: 500 })));
    d.appendAudit.mockRejectedValue(new Error("audit unavailable"));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ name: PartnerCreatedButUnverifiedError.name, reason: "audit_write_failed", postState: state });
  });

  it("records getClient failure before POST", async () => {
    const d = deps(); d.getClient.mockRejectedValue(new Error("no client"));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toThrow("no client");
    expect(d.appendAudit).toHaveBeenCalledTimes(1);
    expect(d.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", reason: "client_unavailable", post_state: "not_attempted" }));
  });

  it.each([["company_id", "1"], ["id", 0]])("classifies invalid %s as invalid_response", async (key, value) => {
    const detail = { ...basePartner(), [key]: value };
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response(detail)));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "invalid_response:/api/1/partners/2" });
  });

  it.each(["id", "company_id"] as const)("rejects every unsafe positive-integer boundary for readback %s", async (key) => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response({ ...basePartner(), [key]: value })));
      await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "invalid_response:/api/1/partners/2", postState: "succeeded", createdId: 2 });
    }
  });

  it.each([
    ["missing", {}], ["string", { id: "2" }], ["zero", { id: 0 }], ["negative", { id: -1 }],
    ["fractional", { id: 1.5 }], ["unsafe", { id: Number.MAX_SAFE_INTEGER + 1 }],
  ])("wraps a %s POST response id as an unverified create", async (_case, partner) => {
    const d = deps(vi.fn().mockResolvedValue(response(partner, 201)));
    const error = await runPartnersCreate({ ...options, execute: true }, d).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartnerCreatedButUnverifiedError);
    expect(error).toMatchObject({ reason: "invalid_response:/api/1/partners", postState: "succeeded", createdId: undefined });
    expect((error as Error).message).toContain("再実行の前に partners search で作成済みか確認すること");
  });

  it("derives every ordinary ignored comparison from PARTNER_PLAN_FIELDS", async () => {
    const full = fullMetadataPlan();
    const paths = PARTNER_PLAN_FIELDS.map((field) => field.path).filter((path) => !["name", "code", "invoice_registration_number"].includes(path[0]!));
    for (const path of paths) {
      const detail = structuredClone({ ...basePartner(), ...full }) as Record<string, unknown>;
      detail.invoice_registration_number = "T1234567890123";
      let current = detail; for (const key of path.slice(0, -1)) current = current[key] as Record<string, unknown>; delete current[path.at(-1)!];
      const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response(detail))); d.readFile.mockResolvedValue(JSON.stringify(full));
      await expect(runPartnersCreate({ ...options, execute: true }, d)).resolves.toMatchObject({ created: { ignored: expect.arrayContaining([path.join(".")]) } });

      const different = structuredClone({ ...basePartner(), ...full }) as Record<string, unknown>;
      different.invoice_registration_number = "T1234567890123";
      current = different; for (const key of path.slice(0, -1)) current = current[key] as Record<string, unknown>; current[path.at(-1)!] = null;
      const mismatchDeps = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response(different))); mismatchDeps.readFile.mockResolvedValue(JSON.stringify(full));
      await expect(runPartnersCreate({ ...options, execute: true }, mismatchDeps)).resolves.toMatchObject({ created: { ignored: expect.arrayContaining([path.join(".")]) } });
    }
  });

  it.each([undefined, 1, true, {}, []])("rejects missing or malformed readback code: %j", async (code) => {
    const detail: Record<string, unknown> = basePartner();
    if (code === undefined) delete detail.code; else detail.code = code;
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response(detail)));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "invalid_response:/api/1/partners/2" });
  });

  it.each([
    ["id", "missing", undefined, "error", "invalid_response:/api/1/partners/2"],
    ["id", "wrong type", "2", "error", "invalid_response:/api/1/partners/2"],
    ["id", "wrong value", 3, "error", "mismatch:id"],
    ["company_id", "missing", undefined, "error", "invalid_response:/api/1/partners/2"],
    ["company_id", "wrong type", "1", "error", "invalid_response:/api/1/partners/2"],
    ["company_id", "wrong value", 9, "error", "mismatch:company_id"],
    ["name", "missing", undefined, "error", "invalid_response:/api/1/partners/2"],
    ["name", "wrong type", null, "error", "invalid_response:/api/1/partners/2"],
    ["name", "wrong value", "別名", "error", "mismatch:name"],
    ["code", "missing", undefined, "error", "invalid_response:/api/1/partners/2"],
    ["code", "wrong type", 1, "error", "invalid_response:/api/1/partners/2"],
    ["code", "wrong value", null, "ignored", "code"],
    ["invoice_registration_number", "missing", undefined, "ignored", "invoice_registration_number"],
    ["invoice_registration_number", "wrong type", 1, "error", "invalid_response:/api/1/partners/2"],
    ["invoice_registration_number", "null value", null, "ignored", "invoice_registration_number"],
    ["invoice_registration_number", "different valid value", "T9876543210987", "ignored", "invoice_registration_number"],
  ] as const)("covers the special-field contract: %s %s", async (field, _cell, value, outcome, expected) => {
    const source = field === "code"
      ? JSON.stringify({ name: "取引先", code: "code" })
      : field === "invoice_registration_number"
        ? JSON.stringify({ name: "取引先", invoice_registration_number: "1234567890123" })
        : plan;
    const detail: Record<string, unknown> = basePartner();
    if (value === undefined) delete detail[field]; else detail[field] = value;
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response(detail))); d.readFile.mockResolvedValue(source);
    if (outcome === "ignored") {
      await expect(runPartnersCreate({ ...options, execute: true }, d)).resolves.toMatchObject({ created: { ignored: [expected] } });
    } else {
      await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ name: PartnerCreatedButUnverifiedError.name, reason: expected, postState: "succeeded", createdId: 2 });
    }
  });

  it.each([["code", []], ["different", ["code"]]])("checks a sent code when the readback value is %s", async (code, ignored) => {
    const source = JSON.stringify({ name: "取引先", code: "code" });
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response({ ...basePartner(), code })));
    d.readFile.mockResolvedValue(source);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).resolves.toMatchObject({ created: { code, ignored } });
  });

  it.each([undefined, 1, true, {}, []])("classifies missing or malformed readback name as invalid_response: %j", async (name) => {
    const detail: Record<string, unknown> = basePartner();
    if (name === undefined) delete detail.name; else detail.name = name;
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response(detail)));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "invalid_response:/api/1/partners/2", postState: "succeeded", createdId: 2 });
  });

  it.each([1, true, {}, []])("rejects a non-string readback registration number: %j", async (invoice_registration_number) => {
    const source = JSON.stringify({ name: "取引先", invoice_registration_number: "1234567890123" });
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response({ ...basePartner(), invoice_registration_number })));
    d.readFile.mockResolvedValue(source);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "invalid_response:/api/1/partners/2", postState: "succeeded", createdId: 2 });
  });

  it("classifies a GET network failure as readback_network", async () => {
    const d = deps();
    d.getClient.mockResolvedValue({ post: async () => post(), get: async () => { throw new TypeError("network"); } } as never);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "readback_network", postState: "succeeded", createdId: 2 });
  });

  it("classifies a POST network failure as post_network", async () => {
    const d = deps();
    d.getClient.mockResolvedValue({ post: async () => { throw new TypeError("network"); } } as never);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "post_network", postState: "unknown" });
  });

  it.each([
    ["unknown", () => deps(vi.fn().mockResolvedValue(new Response("bad", { status: 500 })))],
    ["succeeded", () => deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response({ ...basePartner(), name: "別名" })) )],
  ] as const)("includes the no-rerun warning in a %s error message", async (_state, makeDeps) => {
    const error = await runPartnersCreate({ ...options, execute: true }, makeDeps()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartnerCreatedButUnverifiedError);
    expect((error as Error).message).toContain("再実行の前に partners search で作成済みか確認すること");
  });

  it.each([400, 500, 302])("classifies GET HTTP %i by readback phase", async (status) => {
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(new Response("bad", { status })));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: `readback_http:${status}`, postState: "succeeded" });
  });

  // 103 is reachable here only through an injected client stub.
  it("classifies an injected 103 GET by readback phase", async () => {
    const d = deps();
    d.getClient.mockResolvedValue({ post: async () => post(), get: async () => { throw new FreeeApiError({ status: 103, path: "/api/1/partners/2", bodySnippet: "" }); } } as never);
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ name: PartnerCreatedButUnverifiedError.name, reason: "readback_http:103", postState: "succeeded", createdId: 2 });
  });

  it.each(["not-json", JSON.stringify({})])("classifies malformed GET payload", async (body) => {
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(new Response(body)));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "invalid_response:/api/1/partners/2" });
  });

  it("classifies a safe but wrong readback id as mismatch:id", async () => {
    const d = deps(vi.fn().mockResolvedValueOnce(post()).mockResolvedValueOnce(response({ ...basePartner(), id: 3 })));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ reason: "mismatch:id" });
  });

  it.each(["not_attempted", "rejected"] as const)("leaves audit error unwrapped for %s", async (state) => {
    const d = deps(state === "rejected" ? vi.fn().mockResolvedValue(new Response("bad", { status: 400 })) : vi.fn());
    if (state === "not_attempted") d.getClient.mockRejectedValue(new Error("no client"));
    d.appendAudit.mockRejectedValue(new Error("audit unavailable"));
    await expect(runPartnersCreate({ ...options, execute: true }, d)).rejects.toMatchObject({ name: "AuditWriteError" });
  });

  it.each([async (d: ReturnType<typeof deps>) => d.readFile.mockRejectedValue(new Error("missing")), async (d: ReturnType<typeof deps>) => d.readFile.mockResolvedValue("{"), async (d: ReturnType<typeof deps>) => d.readFile.mockResolvedValue(JSON.stringify({ name: "" }))])("does not audit plan loading or validation failure", async (setup) => {
    const d = deps(); await setup(d);
    await expect(runPartnersCreate(options, d)).rejects.toThrow();
    expect(d.appendAudit).not.toHaveBeenCalled();
  });
});
