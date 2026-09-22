import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isSensitivePiiKey } from "./redactor.js";
export interface PartnerAuditEntry { timestamp: string; task_id: string; event: "partner_create"; mode: "dry-run" | "execute"; status: "planned" | "created" | "failed"; company_id: number; payload_redacted: unknown; created_id?: number; ignored?: string[]; reason?: string; post_state?: "not_attempted" | "rejected" | "unknown" | "succeeded"; }
export interface PartnerUpdateAuditEntry { timestamp: string; task_id: string; event: "partner_update"; mode: "dry-run" | "execute"; status: "planned" | "updated" | "failed"; company_id: number; partner_id: number; payload_redacted: unknown; ignored?: string[]; reason?: string; put_state: "not_attempted" | "rejected" | "unknown" | "succeeded"; }
function safe(value: unknown): boolean {
  if (typeof value === "string") return !/bearer\s+\S+/i.test(value) && !/[^\s@,;]+@[^\s@,;]+/.test(value);
  if (Array.isArray(value)) return value.every(safe);
  return !value || typeof value !== "object" || Object.entries(value as Record<string, unknown>).every(([key, child]) => (!isSensitivePiiKey(key) || child === "[REDACTED]" || child == null) && safe(child));
}
export async function appendPartnerAudit(logDir: string, entry: PartnerAuditEntry): Promise<void> {
  if (!safe(entry)) throw new Error("PartnerAuditEntry: redact leak");
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, `freee-partner-create-${entry.timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
}
export async function appendPartnerUpdateAudit(logDir: string, entry: PartnerUpdateAuditEntry): Promise<void> {
  if (!safe(entry)) throw new Error("PartnerUpdateAuditEntry: redact leak");
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, `freee-partner-update-${entry.timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
}
