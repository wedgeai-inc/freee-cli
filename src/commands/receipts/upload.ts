import { assertId, assertDate } from "../../lib/accounting-validation.js";
import { auditedAccountingWrite } from "../../lib/accounting-write.js";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import type { ReceiptAuditEntry } from "../../lib/audit/receipt-audit.js";
import { redactAccountingPayload } from "../../lib/audit/accounting-audit.js";
export interface ReceiptsUploadOptions { companyId: number; file: string; issueDate: string; description?: string; execute?: boolean; expectSha256?: string; logDir: string; taskId: string; }
export interface ReceiptsUploadDeps { getClient: () => Promise<PublicFreeeClient>; readFile: (path: string) => Promise<Uint8Array>; appendAudit: (entry: ReceiptAuditEntry) => Promise<void>; now: () => Date; }
const MIME: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif", ".tif": "image/tiff", ".tiff": "image/tiff", ".webp": "image/webp" };
// freee/freee-api-schema v2020_06_15, POST /api/1/receipts: "64MBまで".
// MB is unspecified; interpret it as MiB to avoid rejecting permitted files.
const FREEE_RECEIPTS_64MB_LIMIT_INTERPRETED_AS_MIB_BYTES = 64 * 1024 * 1024;
export async function runReceiptsUpload(opts: ReceiptsUploadOptions, deps: ReceiptsUploadDeps) {
  assertId(opts.companyId, "company_id"); assertDate(opts.issueDate, "issue_date");
  if (opts.description !== undefined && [...opts.description].length > 255) throw new Error("description must contain at most 255 characters");
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await deps.readFile(opts.file)); } catch { throw new Error("receipt upload: file cannot be read"); }
  if (bytes.byteLength === 0) throw new Error("receipt upload: file is empty");
  if (bytes.byteLength > FREEE_RECEIPTS_64MB_LIMIT_INTERPRETED_AS_MIB_BYTES) throw new Error(`receipt upload: file size ${bytes.byteLength} bytes exceeds limit ${FREEE_RECEIPTS_64MB_LIMIT_INTERPRETED_AS_MIB_BYTES} bytes`);
  const file = { filename: basename(opts.file), size: bytes.byteLength, mime: MIME[extname(opts.file).toLowerCase()] ?? "application/octet-stream", sha256: createHash("sha256").update(bytes).digest("hex") };
  const fields = { company_id: opts.companyId, receipt_metadatum_issue_date: opts.issueDate, ...(opts.description === undefined ? {} : { description: opts.description }) };
  const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "receipt_upload" as const, mode, company_id: opts.companyId, filename: file.filename, sha256: file.sha256, payload_redacted: redactAccountingPayload(fields) };
  if (!opts.execute) {
    await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "planned" });
    if (opts.expectSha256 === undefined) return { mode, file, fields };
    const validFormat = /^[a-fA-F0-9]{64}$/.test(opts.expectSha256);
    const matches = validFormat && opts.expectSha256.toLowerCase() === file.sha256;
    const expectSha256 = { expected: opts.expectSha256, actual: file.sha256, matches,
      ...(!validFormat ? { reason: "expected SHA-256 must contain 64 hexadecimal characters" } : !matches ? { reason: "SHA-256 mismatch" } : {}) };
    return { mode, file, fields, checks: { expectSha256 } };
  }
  if (!opts.expectSha256 || !/^[a-fA-F0-9]{64}$/.test(opts.expectSha256) || opts.expectSha256.toLowerCase() !== file.sha256) throw new Error("--expect-sha256 must match file SHA-256");
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  form.set("receipt", new Blob([new Uint8Array(bytes)], { type: file.mime }), file.filename);
  const client = await deps.getClient();
  const created = await auditedAccountingWrite(base, deps, () => client.post("/api/1/receipts", { body: form }), "receipt");
  return { mode, file, fields, created };
}
