import { createHash } from "node:crypto";

export type RedactionLevel = "strict" | "default";

const SENSITIVE_HEADER_KEYS = new Set([
  "cookie",
  "cookie_full_string",
  "x-csrf-token",
  "csrf-token",
  "csrf_token",
  "authorization",
  "set-cookie",
  "_session_id",
  "_n_auth_session_id",
]);

const SENSITIVE_FIELD_PATTERNS = [
  /^email$/i,
  /email$/i,
  // キー名に email を含むもの（partner_contact_email_to / _cc 等）は値の形式を問わず伏せる。
  // 値だけの判定（EMAIL_ANY_RE）はキー名に依らず値を伏せるが、"@" を含む自由テキスト全般を伏せるので、キー名判定と併用して確実にする
  /(^|_)e?mail(_|$)/i,
  /^name$/i,
  /^display_name$/i,
  /^user_name$/i,
  /^partner_name$/i,
  /^approver_email$/i,
  /^applicant_name$/i,
  // decided_by は監査の「誰の判断か」を記録するため、人名が入らないよう伏せる。
  /^decided_by$/i,
  // インボイス制度の適格請求書発行事業者番号（事業者を特定可能なため PII 扱い）。
  // audit log への raw 値出力を fail-closed で禁止する。
  /^partner_invoice_number$/i,
  /^(long_name|name_kana|contact_name|phone|zipcode|street_name1|street_name2|invoice_registration_number)$/i,
];

const STRICT_ID_KEYS = new Set(["applicant_id", "approver_id"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
// 文字列の一部に含まれるメールアドレス（"contact a@example.com" や "a@example.com,b@example.net"）も伏せる。
// ドメイン部の "." は必須にしない（"ops@localhost" のようなイントラネット宛も伏せる。監査は fail-closed 優先で、
// "@単価" のような記法を巻き込む過剰伏字は許容する）
const EMAIL_ANY_RE = /[^\s@,;]+@[^\s@,;]+/g;

function isSensitiveKey(key: string, extraKeys: string[]): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_HEADER_KEYS.has(lower)) return true;
  if (extraKeys.includes(key)) return true;
  return SENSITIVE_FIELD_PATTERNS.some((re) => re.test(key));
}

/** Single source of truth: redactor と audit-logger guard で共用するキー判定関数 */
export function isSensitivePiiKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_HEADER_KEYS.has(lower)) return true;
  return SENSITIVE_FIELD_PATTERNS.some((re) => re.test(key));
}

function hashId(value: unknown): string {
  return "hash:" + createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

export function redact(
  value: unknown,
  keys: string[] = [],
  level: RedactionLevel = "default",
): unknown {
  if (typeof value === "string") {
    if (EMAIL_RE.test(value.trim())) return "[REDACTED]";
    return value.replace(EMAIL_ANY_RE, "[REDACTED]");
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, keys, level));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k, keys)) {
        result[k] = "[REDACTED]";
      } else if (level === "strict" && STRICT_ID_KEYS.has(k)) {
        result[k] = hashId(v);
      } else {
        result[k] = redact(v, keys, level);
      }
    }
    return result;
  }

  return value;
}
