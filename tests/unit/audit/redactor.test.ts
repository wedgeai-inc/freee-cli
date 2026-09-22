import { describe, expect, it } from "vitest";
import { redact } from "../../../src/lib/audit/redactor.js";

describe("redact - header keys", () => {
  it("redacts cookie key", () => {
    const result = redact({ cookie: "session=abc123" });
    expect((result as Record<string, unknown>)["cookie"]).toBe("[REDACTED]");
  });

  it("redacts x-csrf-token key", () => {
    const result = redact({ "x-csrf-token": "tok123" });
    expect((result as Record<string, unknown>)["x-csrf-token"]).toBe("[REDACTED]");
  });

  it("redacts authorization key", () => {
    const result = redact({ authorization: "Bearer eyxxx" });
    expect((result as Record<string, unknown>)["authorization"]).toBe("[REDACTED]");
  });

  it("redacts set-cookie key", () => {
    const result = redact({ "set-cookie": "id=1; Path=/" });
    expect((result as Record<string, unknown>)["set-cookie"]).toBe("[REDACTED]");
  });

  it("is case-insensitive for header keys", () => {
    const result = redact({ Authorization: "Bearer tok", Cookie: "a=b" });
    const r = result as Record<string, unknown>;
    expect(r["Authorization"]).toBe("[REDACTED]");
    expect(r["Cookie"]).toBe("[REDACTED]");
  });
});

describe("redact - PII field keys (default mode)", () => {
  it("redacts email field", () => {
    const result = redact({ email: "user@example.com" });
    expect((result as Record<string, unknown>)["email"]).toBe("[REDACTED]");
  });

  it("redacts name field", () => {
    const result = redact({ name: "田中太郎" });
    expect((result as Record<string, unknown>)["name"]).toBe("[REDACTED]");
  });

  it("redacts partner_name field", () => {
    const result = redact({ partner_name: "山田花子" });
    expect((result as Record<string, unknown>)["partner_name"]).toBe("[REDACTED]");
  });

  it("redacts approver_email field", () => {
    const result = redact({ approver_email: "approver@example.com" });
    expect((result as Record<string, unknown>)["approver_email"]).toBe("[REDACTED]");
  });

  it("preserves applicant_id (PII low)", () => {
    const result = redact({ applicant_id: 12345 });
    expect((result as Record<string, unknown>)["applicant_id"]).toBe(12345);
  });

  it("preserves approver_id (PII low)", () => {
    const result = redact({ approver_id: 67890 });
    expect((result as Record<string, unknown>)["approver_id"]).toBe(67890);
  });
});

describe("redact - email detection by regex", () => {
  it("redacts string value matching email pattern", () => {
    const result = redact("user@example.com");
    expect(result).toBe("[REDACTED]");
  });

  it("preserves non-email string", () => {
    const result = redact("plain text without email");
    expect(result).toBe("plain text without email");
  });
});

describe("redact - nested objects", () => {
  it("redacts nested email field", () => {
    const obj = { partner: { name: "山田", email: "partner@example.com" } };
    const result = redact(obj) as Record<string, Record<string, unknown>>;
    expect(result["partner"]!["name"]).toBe("[REDACTED]");
    expect(result["partner"]!["email"]).toBe("[REDACTED]");
  });

  it("redacts in arrays", () => {
    const obj = { items: [{ email: "a@example.com" }, { email: "c@example.com" }] };
    const result = redact(obj) as Record<string, Array<Record<string, unknown>>>;
    expect(result["items"]![0]!["email"]).toBe("[REDACTED]");
    expect(result["items"]![1]!["email"]).toBe("[REDACTED]");
  });

  it("preserves non-sensitive fields", () => {
    const obj = { id: 1, amount: 1000, status: "approved" };
    const result = redact(obj) as Record<string, unknown>;
    expect(result["id"]).toBe(1);
    expect(result["amount"]).toBe(1000);
    expect(result["status"]).toBe("approved");
  });
});

describe("redact - strict mode", () => {
  it("hashes applicant_id in strict mode", () => {
    const result = redact({ applicant_id: 12345 }, undefined, "strict");
    const r = result as Record<string, unknown>;
    expect(typeof r["applicant_id"]).toBe("string");
    expect(r["applicant_id"]).not.toBe(12345);
    expect(r["applicant_id"]).not.toBe("[REDACTED]");
  });

  it("hashes approver_id in strict mode", () => {
    const result = redact({ approver_id: 67890 }, undefined, "strict");
    const r = result as Record<string, unknown>;
    expect(typeof r["approver_id"]).toBe("string");
    expect(r["approver_id"]).not.toBe(67890);
  });

  it("same id produces same hash (deterministic)", () => {
    const r1 = redact({ applicant_id: 12345 }, undefined, "strict") as Record<string, unknown>;
    const r2 = redact({ applicant_id: 12345 }, undefined, "strict") as Record<string, unknown>;
    expect(r1["applicant_id"]).toBe(r2["applicant_id"]);
  });
});

describe("redact - custom keys", () => {
  it("redacts custom specified keys", () => {
    const result = redact({ custom_secret: "topsecret" }, ["custom_secret"]);
    expect((result as Record<string, unknown>)["custom_secret"]).toBe("[REDACTED]");
  });
});

describe("redact - new secret keys (BLOCKER 1)", () => {
  it("redacts cookie_full_string key", () => {
    const result = redact({ cookie_full_string: "test_session=fake_session; sid=123" });
    expect((result as Record<string, unknown>)["cookie_full_string"]).toBe("[REDACTED]");
  });

  it("redacts csrf_token key", () => {
    const result = redact({ csrf_token: "abc123csrf" });
    expect((result as Record<string, unknown>)["csrf_token"]).toBe("[REDACTED]");
  });

  it("redacts csrf-token key (hyphenated)", () => {
    const result = redact({ "csrf-token": "abc123csrf" });
    expect((result as Record<string, unknown>)["csrf-token"]).toBe("[REDACTED]");
  });

  it("redacts _session_id key", () => {
    const result = redact({ _session_id: "session-secret-abc" });
    expect((result as Record<string, unknown>)["_session_id"]).toBe("[REDACTED]");
  });

  it("redacts _n_auth_session_id key", () => {
    const result = redact({ _n_auth_session_id: "n-auth-secret-xyz" });
    expect((result as Record<string, unknown>)["_n_auth_session_id"]).toBe("[REDACTED]");
  });

  it("redacts new keys case-insensitively", () => {
    const result = redact({ Cookie_Full_String: "session=x; id=y", CSRF_TOKEN: "secret" });
    const r = result as Record<string, unknown>;
    expect(r["Cookie_Full_String"]).toBe("[REDACTED]");
    expect(r["CSRF_TOKEN"]).toBe("[REDACTED]");
  });
});

// -----------------------------------------------------------------------
// Batch execution PII safety — strengthened coverage
// -----------------------------------------------------------------------

describe("redact - A: cookie_full_string with complex session value", () => {
  it("redacts full cookie string including session, uid, _ga segments", () => {
    const result = redact({ cookie_full_string: "_session_id=abc; uid=12345; _ga=GA1.1.123" });
    const r = result as Record<string, unknown>;
    // entire value must be [REDACTED] — no partial residue allowed
    expect(r["cookie_full_string"]).toBe("[REDACTED]");
    expect(r["cookie_full_string"]).not.toContain("abc");
    expect(r["cookie_full_string"]).not.toContain("12345");
  });
});

describe("redact - B: csrf-token with real-looking token value", () => {
  it("redacts x-csrf-token with alphanumeric token", () => {
    const result = redact({ "x-csrf-token": "87cNti6pMY-abc123" });
    expect((result as Record<string, unknown>)["x-csrf-token"]).toBe("[REDACTED]");
  });
});

describe("redact - C: nested headers object with x-company-id preserved", () => {
  it("redacts cookie and csrf inside headers, preserves x-company-id", () => {
    const obj = {
      headers: {
        cookie: "session=secret; sid=7654321",
        "x-csrf-token": "tok-secret-xyz",
        "x-company-id": "7654321",
      },
    };
    const result = redact(obj) as Record<string, Record<string, unknown>>;
    expect(result["headers"]!["cookie"]).toBe("[REDACTED]");
    expect(result["headers"]!["x-csrf-token"]).toBe("[REDACTED]");
    // x-company-id は識別子として保持する
    expect(result["headers"]!["x-company-id"]).toBe("7654321");
  });
});

describe("redact - D: email and display_name PII redaction", () => {
  it("redacts email field in nested user object", () => {
    const result = redact({ user: { email: "user@example.com", display_name: "Taro Example" } });
    const user = (result as Record<string, Record<string, unknown>>)["user"]!;
    expect(user["email"]).toBe("[REDACTED]");
  });

  it("redacts display_name field (氏名 PII)", () => {
    const result = redact({ user: { email: "user@example.com", display_name: "Taro Example" } });
    const user = (result as Record<string, Record<string, unknown>>)["user"]!;
    expect(user["display_name"]).toBe("[REDACTED]");
  });
});

describe("redact - E: Bearer token via authorization key", () => {
  it("redacts authorization header with Bearer token", () => {
    const result = redact({ authorization: "Bearer abc.def.ghi" });
    expect((result as Record<string, unknown>)["authorization"]).toBe("[REDACTED]");
    expect((result as Record<string, unknown>)["authorization"]).not.toContain("Bearer");
  });
});

describe("redact - G: array of objects containing cookie key", () => {
  it("redacts cookie key in each array element", () => {
    const obj = { items: [{ cookie: "sid=aaa" }, { cookie: "sid=bbb" }] };
    const result = redact(obj) as Record<string, Array<Record<string, unknown>>>;
    expect(result["items"]![0]!["cookie"]).toBe("[REDACTED]");
    expect(result["items"]![1]!["cookie"]).toBe("[REDACTED]");
  });

  it("preserves non-sensitive fields within array objects", () => {
    const obj = { items: [{ cookie: "sec", id: 1 }, { cookie: "sec", id: 2 }] };
    const result = redact(obj) as Record<string, Array<Record<string, unknown>>>;
    expect(result["items"]![0]!["id"]).toBe(1);
    expect(result["items"]![1]!["id"]).toBe(2);
  });
});

describe("redact - applicant_name PII", () => {
  it("redacts applicant_name with Japanese name", () => {
    const result = redact({ applicant_name: "山田" });
    expect((result as Record<string, unknown>)["applicant_name"]).toBe("[REDACTED]");
  });

  it("redacts applicant_name with ASCII name", () => {
    const result = redact({ applicant_name: "Tanaka Taro" });
    expect((result as Record<string, unknown>)["applicant_name"]).toBe("[REDACTED]");
  });

  it("redacts applicant_name case-insensitively (APPLICANT_NAME)", () => {
    const result = redact({ APPLICANT_NAME: "山田" });
    expect((result as Record<string, unknown>)["APPLICANT_NAME"]).toBe("[REDACTED]");
  });

  it("redacts nested applicant_name", () => {
    const result = redact({ user: { applicant_name: "山田" } }) as Record<string, Record<string, unknown>>;
    expect(result["user"]!["applicant_name"]).toBe("[REDACTED]");
  });
});

// ── I2: partner_invoice_number redaction ───────────────────────────

describe("redact - partner_invoice_number", () => {
  it("redacts partner_invoice_number field (インボイス登録番号)", () => {
    const result = redact({ partner_invoice_number: 1234567890123 });
    expect((result as Record<string, unknown>)["partner_invoice_number"]).toBe("[REDACTED]");
  });

  it("redacts nested partner_invoice_number inside current_receipt_partner_invoice_number", () => {
    const obj = {
      current_receipt_partner_invoice_number: {
        partner_invoice_number: 1234567890123,
      },
    };
    const result = redact(obj) as Record<string, Record<string, unknown>>;
    expect(result["current_receipt_partner_invoice_number"]!["partner_invoice_number"]).toBe("[REDACTED]");
  });
});
