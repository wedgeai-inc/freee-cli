import { describe, expect, it, vi } from "vitest";
import { createInvoiceClient } from "../../src/lib/clients/freee-invoice-client.js";
import { AuditWriteError, InvoiceCreatedButUnverifiedError, ResponseParseError, classifyFailure, formatInvoiceCreate, runInvoicesCreate } from "../../src/commands/invoices/create.js";
import { FreeeApiError } from "../../src/lib/clients/freee-public-client.js";
import { createProgram } from "../../src/cli.js";
import { writeFileSync } from "node:fs";
import { appendInvoiceAudit, type InvoiceAuditEntry } from "../../src/lib/audit/invoice-audit.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plan = {
  billing_date: "2026-09-05",
  partner_id: 123,
  partner_title: "御中",
  partner_contact_email_to: "billing@example.com",
  partner_contact_email_cc: "a@example.com,b@example.com",
  memo: "contact billing@example.com for questions",
  tax_entry_method: "out",
  tax_fraction: "omit",
  withholding_tax_entry_method: "out",
  lines: [{ description: "開発支援", quantity: 56.07, unit: "時間", unit_price: "10000", tax_rate: 10 }],
};

function deps(fetchMock: ReturnType<typeof vi.fn>, planOverride: Record<string, unknown> = plan) {
  const audits: InvoiceAuditEntry[] = [];
  const client = createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch });
  return {
    audits,
    deps: {
      getClient: async () => client,
      readFile: async () => JSON.stringify(planOverride),
      appendAudit: async (e: InvoiceAuditEntry) => {
        audits.push(e);
      },
      now: () => new Date("2026-09-05T13:00:00Z"),
    },
  };
}

const opts = { companyId: 999, planPath: "plan.json", logDir: "./audit-logs", taskId: "t-1" };

describe("runInvoicesCreate", () => {
  it("dry-run does not call fetch and records a planned audit", async () => {
    const fetchMock = vi.fn();
    const d = deps(fetchMock);
    const result = await runInvoicesCreate({ ...opts, execute: false }, d.deps);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("dry-run");
    expect(result.totals).toEqual({ subtotal: 560_700, tax: 56_070, total: 616_770 });
    expect(d.audits).toHaveLength(1);
    expect(d.audits[0]?.status).toBe("planned");
    expect(formatInvoiceCreate(result)).toContain("参考値");
  });

  it("execute posts then reads back and records created", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 555 } }), { status: 201 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ invoice: { id: 555, invoice_number: "INV-1", total_amount: 616770 } }), { status: 200 }),
      );
    const d = deps(fetchMock);
    const result = await runInvoicesCreate({ ...opts, execute: true }, d.deps);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [postUrl, postInit] = fetchMock.mock.calls[0]!;
    expect(String(postUrl)).toBe("https://api.freee.co.jp/iv/invoices");
    expect(postInit.method).toBe("POST");
    const body = JSON.parse(postInit.body);
    expect(body.company_id).toBe(999);
    expect(body.lines[0].unit_price).toBe("10000");
    const [getUrl, getInit] = fetchMock.mock.calls[1]!;
    expect(String(getUrl)).toBe("https://api.freee.co.jp/iv/invoices/555?company_id=999");
    expect(getInit.method).toBe("GET");
    expect(result.created).toEqual({
      id: 555,
      invoice_number: "INV-1",
      total_amount: 616770,
      webUrl: "https://invoice.secure.freee.co.jp/reports/invoices/555",
    });
    expect(d.audits.map((a) => a.status)).toEqual(["created"]);
    expect(d.audits[0]?.created_id).toBe(555);
  });

  it("execute failure records failed and throws", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const d = deps(fetchMock);
    await expect(runInvoicesCreate({ ...opts, execute: true }, d.deps)).rejects.toThrow();
    expect(d.audits.map((a) => a.status)).toEqual(["failed"]);
    expect(d.audits[0]?.reason).toBe("api_error:500:/invoices");
  });

  it("keeps created_id when read-back fails after a successful POST", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 777 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const d = deps(fetchMock);
    const err = await runInvoicesCreate({ ...opts, execute: true }, d.deps).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceCreatedButUnverifiedError);
    expect((err as InvoiceCreatedButUnverifiedError).createdId).toBe(777);
    expect(d.audits.map((a) => [a.status, a.created_id])).toEqual([["failed", 777]]);
    expect(d.audits[0]?.reason).toBe("api_error:500:/invoices/777");
  });

  it("treats a 2xx POST without invoice.id as possibly created (no re-run)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }));
    const d = deps(fetchMock);
    const err = await runInvoicesCreate({ ...opts, execute: true }, d.deps).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceCreatedButUnverifiedError);
    expect((err as InvoiceCreatedButUnverifiedError).createdId).toBeUndefined();
    expect(String(err)).toContain("id 不明");
    expect(d.audits.map((a) => [a.status, a.reason])).toEqual([["failed", "invalid_response:/invoices"]]);
  });

  it("keeps AuditWriteError when the created audit fails once and the failed audit would succeed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 12 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 12, invoice_number: "N", total_amount: 1 } }), { status: 200 }));
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch });
    const appendAudit = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const err = await runInvoicesCreate({ ...opts, execute: true }, {
      getClient: async () => client,
      readFile: async () => JSON.stringify(plan),
      appendAudit,
      now: () => new Date(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AuditWriteError);
    expect((err as AuditWriteError).createdId).toBe(12);
    expect(appendAudit).toHaveBeenCalledTimes(1); // failed audit で置き換えない
  });

  it("classifies non-JSON POST and GET responses by path", async () => {
    const d1 = deps(vi.fn().mockResolvedValueOnce(new Response("<html>", { status: 201 })));
    await runInvoicesCreate({ ...opts, execute: true }, d1.deps).catch(() => undefined);
    expect(d1.audits[0]?.reason).toBe("invalid_response:/invoices");
    const d2 = deps(vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 3 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response("<html>", { status: 200 })));
    await runInvoicesCreate({ ...opts, execute: true }, d2.deps).catch(() => undefined);
    expect(d2.audits[0]?.reason).toBe("invalid_response:/invoices/{id}");
    expect(d2.audits[0]?.created_id).toBe(3);
  });

  it("when both created and failed audits cannot be written, the error still says the POST succeeded", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 21 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch });
    const err = await runInvoicesCreate({ ...opts, execute: true }, {
      getClient: async () => client,
      readFile: async () => JSON.stringify(plan),
      appendAudit: async () => { throw new Error("disk full"); },
      now: () => new Date(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AuditWriteError);
    expect((err as AuditWriteError).postState).toBe("succeeded");
    expect((err as AuditWriteError).createdId).toBe(21);
    expect(String((err as Error).message)).toContain("再実行せず");
    expect(String((err as Error).message)).toContain("id=21");
  });

  it("CLI prints the no-rerun warning when a post-2xx failure happens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-cli-"));
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 31 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const saved = process.env.FREEE_ACCESS_TOKEN;
    process.env.FREEE_ACCESS_TOKEN = "dummy-token";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = await createProgram()
        .parseAsync(["invoices", "create", "--company-id", "1", "--plan", planPath, "--log-dir", dir, "--execute"], { from: "user" })
        .catch((e) => e);
      // cli.ts の top-level catch は error.message を表示する。message 自体が再実行禁止を伝えること
      expect(String((err as Error).message)).toContain("再実行せず");
      expect(String((err as Error).message)).toContain("id=31");
    } finally {
      vi.unstubAllGlobals();
      errSpy.mockRestore();
      if (saved === undefined) delete process.env.FREEE_ACCESS_TOKEN;
      else process.env.FREEE_ACCESS_TOKEN = saved;
    }
  });

  it("treats a network failure during POST as unknown outcome (no re-run), even when audit cannot be written", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed: socket hang up"));
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch });
    // audit が書ける場合
    const audits: InvoiceAuditEntry[] = [];
    const err = await runInvoicesCreate({ ...opts, execute: true }, {
      getClient: async () => client,
      readFile: async () => JSON.stringify(plan),
      appendAudit: async (e) => { audits.push(e); },
      now: () => new Date(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceCreatedButUnverifiedError);
    expect((err as InvoiceCreatedButUnverifiedError).postState).toBe("unknown");
    expect(String((err as Error).message)).toContain("結果が不明");
    expect(String((err as Error).message)).toContain("再実行せず");
    expect(audits.map((a) => a.status)).toEqual(["failed"]);
    // audit も書けない場合: AuditWriteError でも「結果不明・再実行せず」を伝える
    const fetchMock2 = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));
    const client2 = createInvoiceClient({ token: "t", fetchFn: fetchMock2 as unknown as typeof fetch });
    const err2 = await runInvoicesCreate({ ...opts, execute: true }, {
      getClient: async () => client2,
      readFile: async () => JSON.stringify(plan),
      appendAudit: async () => { throw new Error("disk full"); },
      now: () => new Date(),
    }).catch((e) => e);
    expect(err2).toBeInstanceOf(AuditWriteError);
    expect((err2 as AuditWriteError).postState).toBe("unknown");
    expect(String((err2 as Error).message)).toContain("再実行せず");
  });

  it("treats a 4xx POST response as rejected (re-run allowed)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    const d = deps(fetchMock);
    const err = await runInvoicesCreate({ ...opts, execute: true }, d.deps).catch((e) => e);
    expect(err).toBeInstanceOf(FreeeApiError);
    expect(d.audits.map((a) => [a.status, a.reason])).toEqual([["failed", "api_error:400:/invoices"]]);
  });

  it("treats a 5xx POST response as unknown outcome (no re-run), including when audit fails", async () => {
    const d = deps(vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 })));
    const err = await runInvoicesCreate({ ...opts, execute: true }, d.deps).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceCreatedButUnverifiedError);
    expect((err as InvoiceCreatedButUnverifiedError).postState).toBe("unknown");
    expect(String((err as Error).message)).toContain("5xx");
    expect(String((err as Error).message)).toContain("再実行せず");
    expect(d.audits.map((a) => [a.status, a.reason])).toEqual([["failed", "api_error:500:/invoices"]]);
    const client2 = createInvoiceClient({ token: "t", fetchFn: vi.fn().mockResolvedValueOnce(new Response("boom", { status: 503 })) as unknown as typeof fetch });
    const err2 = await runInvoicesCreate({ ...opts, execute: true }, {
      getClient: async () => client2,
      readFile: async () => JSON.stringify(plan),
      appendAudit: async () => { throw new Error("disk full"); },
      now: () => new Date(),
    }).catch((e) => e);
    expect(err2).toBeInstanceOf(AuditWriteError);
    expect((err2 as AuditWriteError).postState).toBe("unknown");
    expect(String((err2 as Error).message)).toContain("再実行せず");
  });

  it("rejects a read-back response without invoice_number / total_amount", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 5 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: {} }), { status: 200 }));
    const d = deps(fetchMock);
    const err = await runInvoicesCreate({ ...opts, execute: true }, d.deps).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceCreatedButUnverifiedError);
    expect(d.audits[0]?.status).toBe("failed");
    expect(d.audits[0]?.created_id).toBe(5);
    expect(d.audits[0]?.reason).toBe("invalid_response:/invoices/{id}");
  });

  it("does not replace the original outcome when the audit writer fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 9 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 9, invoice_number: "N", total_amount: 1 } }), { status: 200 }));
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch });
    const err = await runInvoicesCreate({ ...opts, execute: true }, {
      getClient: async () => client,
      readFile: async () => JSON.stringify(plan),
      appendAudit: async () => { throw new Error("disk full"); },
      now: () => new Date(),
    }).catch((e) => e);
    // created 記録が書けず、failed 記録も書けない → AuditWriteError だが created_id は保持される
    expect(err).toBeInstanceOf(AuditWriteError);
    expect((err as AuditWriteError).createdId).toBe(9);
  });

  it("redacts email in the audit payload, including partial and comma-separated values", async () => {
    const d = deps(vi.fn());
    await runInvoicesCreate({ ...opts, execute: false }, d.deps);
    const json = JSON.stringify(d.audits[0]?.payload_redacted);
    expect(json).not.toContain("example.com");
    expect(json).toContain("contact [REDACTED] for questions");
  });

  it("redacts email keys even when the value has no dot in the domain (ops@localhost)", async () => {
    const d = deps(vi.fn(), { ...plan, partner_contact_email_to: "ops@localhost", partner_contact_email_cc: "a@b" });
    await runInvoicesCreate({ ...opts, execute: false }, d.deps);
    const redacted = d.audits[0]?.payload_redacted as Record<string, unknown>;
    expect(redacted.partner_contact_email_to).toBe("[REDACTED]");
    expect(redacted.partner_contact_email_cc).toBe("[REDACTED]");
    expect(JSON.stringify(redacted)).not.toContain("localhost");
  });

  it("redacts a dot-less email inside free text (memo: contact ops@localhost)", async () => {
    const d = deps(vi.fn(), { ...plan, subject: "contact ops@localhost for questions" });
    await runInvoicesCreate({ ...opts, execute: false }, d.deps);
    const json = JSON.stringify(d.audits[0]?.payload_redacted);
    expect(json).not.toContain("ops@localhost");
    expect(json).toContain("[REDACTED]");
  });

  it("writes through the real audit writer without leaking emails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-audit-"));
    const client = createInvoiceClient({ token: "t", fetchFn: vi.fn() as unknown as typeof fetch });
    await runInvoicesCreate({ ...opts, execute: false, logDir: dir }, {
      getClient: async () => client,
      readFile: async () => JSON.stringify(plan),
      appendAudit: (e) => appendInvoiceAudit(dir, e),
      now: () => new Date("2026-09-05T13:00:00Z"),
    });
    const text = readFileSync(join(dir, "freee-invoice-create-2026-09-05.jsonl"), "utf8");
    expect(text).not.toContain("example.com");
    expect(text).toContain('"status":"planned"');
  });

  it("does not request the client (no auth, no fetch) in dry-run", async () => {
    const getClient = vi.fn();
    await runInvoicesCreate({ ...opts, execute: false }, {
      getClient,
      readFile: async () => JSON.stringify(plan),
      appendAudit: async () => {},
      now: () => new Date(),
    });
    expect(getClient).not.toHaveBeenCalled();
  });

  it("CLI dry-run completes without loading credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-cli-"));
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const saved = process.env.FREEE_ACCESS_TOKEN;
    delete process.env.FREEE_ACCESS_TOKEN;
    try {
      await createProgram().parseAsync(["invoices", "create", "--company-id", "1", "--plan", planPath, "--log-dir", dir], { from: "user" });
    } finally {
      if (saved !== undefined) process.env.FREEE_ACCESS_TOKEN = saved;
    }
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("mode: dry-run");
    log.mockRestore();
  });

  it("classifies failures into fixed reasons without raw messages", () => {
    expect(classifyFailure(new FreeeApiError({ status: 500, path: "/invoices", bodySnippet: "boom" }))).toBe("api_error:500:/invoices");
    expect(classifyFailure(new Error("invoice create: response did not include invoice.id"))).toBe("invalid_response:/invoices");
    expect(classifyFailure(new ResponseParseError("/invoices"))).toBe("invalid_response:/invoices");
    expect(classifyFailure(new ResponseParseError("/invoices/{id}"))).toBe("invalid_response:/invoices/{id}");
    expect(classifyFailure(new TypeError("fetch failed: ECONNRESET secret-host"))).toBe("request_failed:/invoices");
  });
});

describe("appendInvoiceAudit", () => {
  const entry: InvoiceAuditEntry = {
    timestamp: "2026-09-05T13:00:00.000Z",
    task_id: "t-1",
    event: "invoice_create",
    mode: "dry-run",
    status: "planned",
    company_id: 1,
    payload_redacted: { subject: "x" },
  };

  it("appends one JSON line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-audit-"));
    await appendInvoiceAudit(dir, entry);
    const lines = readFileSync(join(dir, "freee-invoice-create-2026-09-05.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).status).toBe("planned");
  });

  it("rejects an email embedded in a longer string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-audit-"));
    await expect(
      appendInvoiceAudit(dir, { ...entry, payload_redacted: { memo: "mail me at a@example.com please" } }),
    ).rejects.toThrow(/email/);
  });

  it("rejects a dot-less email embedded in free text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-audit-"));
    await expect(
      appendInvoiceAudit(dir, { ...entry, payload_redacted: { memo: "contact ops@localhost please" } }),
    ).rejects.toThrow(/email/);
  });

  it("rejects an unredacted email key regardless of the value format", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-audit-"));
    await expect(
      appendInvoiceAudit(dir, { ...entry, payload_redacted: { partner_contact_email_to: "ops@localhost" } }),
    ).rejects.toThrow(/sensitive key at payload_redacted\.partner_contact_email_to/);
    await expect(
      appendInvoiceAudit(dir, { ...entry, payload_redacted: { partner_name: "株式会社テスト" } }),
    ).rejects.toThrow(/sensitive key/);
    // 伏字済みなら通る
    await appendInvoiceAudit(dir, { ...entry, payload_redacted: { partner_contact_email_to: "[REDACTED]" } });
  });

  it("rejects a bearer token in the payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-audit-"));
    await expect(
      appendInvoiceAudit(dir, { ...entry, payload_redacted: { memo: "Bearer abc.def" } }),
    ).rejects.toThrow(/Bearer/);
  });
});
