import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isSensitivePiiKey } from "./redactor.js";

export interface InvoiceAuditEntry {
  timestamp: string;
  task_id: string;
  event: "invoice_create";
  mode: "dry-run" | "execute";
  status: "planned" | "created" | "failed";
  company_id: number;
  payload_redacted: unknown;
  created_id?: number;
  reason?: string;
}

export interface InvoiceCancelAuditEntry {
  timestamp: string;
  task_id: string;
  event: "invoice_cancel";
  mode: "dry-run" | "execute";
  status: "planned" | "canceled" | "failed";
  company_id: number;
  invoice_id: number;
  reason?: string;
  put_state?: "not_attempted" | "rejected" | "unknown" | "succeeded";
}

export interface InvoiceUncancelAuditEntry {
  timestamp: string;
  task_id: string;
  event: "invoice_uncancel";
  mode: "dry-run" | "execute";
  status: "planned" | "uncanceled" | "failed";
  company_id: number;
  invoice_id: number;
  reason?: string;
  put_state?: "not_attempted" | "rejected" | "unknown" | "succeeded";
}

export interface InvoiceUpdateAuditEntry {
  timestamp: string; task_id: string; event: "invoice_update"; mode: "dry-run" | "execute";
  status: "planned" | "updated" | "failed"; company_id: number; invoice_id: number;
  payload_redacted: unknown; reason?: string; put_state: "not_attempted" | "rejected" | "unknown" | "succeeded";
}

const REDACTED = "[REDACTED]";
const BEARER_RE = /bearer\s+\S+/i;
const EMAIL_ANY_RE = /[^\s@,;]+@[^\s@,;]+/;

function detectLeakage(value: unknown, path: string): string | null {
  if (typeof value === "string") {
    if (BEARER_RE.test(value)) return `Bearer token at ${path}`;
    if (EMAIL_ANY_RE.test(value)) return `email value at ${path}`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = detectLeakage(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      // 値の形式に依らない独立検査: PII キー（email 系・name 系）が伏字以外の値を持っていれば拒否する
      if (isSensitivePiiKey(k) && v !== undefined && v !== null && v !== REDACTED) {
        return `unredacted sensitive key at ${childPath}`;
      }
      const found = detectLeakage(v, childPath);
      if (found) return found;
    }
  }
  return null;
}

/**
 * invoices create の audit log（JSONL）。payload_redacted に Bearer / メールアドレス（文字列の一部でも）が残っている、
 * または PII キー（isSensitivePiiKey）が伏字以外の値を持っていれば fail-closed で拒否する。
 * ファイル名は `freee-invoice-create-<YYYY-MM-DD>.jsonl`（timestamp の日付・UTC）。
 */
export async function appendInvoiceAudit(logDir: string, entry: InvoiceAuditEntry): Promise<void> {
  const leakage = detectLeakage(entry, "");
  if (leakage) throw new Error(`InvoiceAuditEntry: redact漏れを検知 — ${leakage}`);
  const day = entry.timestamp.slice(0, 10);
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, `freee-invoice-create-${day}.jsonl`), JSON.stringify(entry) + "\n", "utf8");
}

/** invoices cancel の audit log（JSONL）。create と同じ redact 漏れ guard を共有する。 */
export async function appendInvoiceCancelAudit(logDir: string, entry: InvoiceCancelAuditEntry): Promise<void> {
  const leakage = detectLeakage(entry, "");
  if (leakage) throw new Error(`InvoiceCancelAuditEntry: redact漏れを検知 — ${leakage}`);
  const day = entry.timestamp.slice(0, 10);
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, `freee-invoice-cancel-${day}.jsonl`), JSON.stringify(entry) + "\n", "utf8");
}

/** invoices uncancel の audit log（JSONL）。 */
export async function appendInvoiceUncancelAudit(logDir: string, entry: InvoiceUncancelAuditEntry): Promise<void> {
  const leakage = detectLeakage(entry, "");
  if (leakage) throw new Error(`InvoiceUncancelAuditEntry: redact漏れを検知 — ${leakage}`);
  const day = entry.timestamp.slice(0, 10);
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, `freee-invoice-uncancel-${day}.jsonl`), JSON.stringify(entry) + "\n", "utf8");
}

export async function appendInvoiceUpdateAudit(logDir: string, entry: InvoiceUpdateAuditEntry): Promise<void> {
  const leakage = detectLeakage(entry, "");
  if (leakage) throw new Error(`InvoiceUpdateAuditEntry: redact漏れを検知 — ${leakage}`);
  const day = entry.timestamp.slice(0, 10);
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, `freee-invoice-update-${day}.jsonl`), JSON.stringify(entry) + "\n", "utf8");
}
