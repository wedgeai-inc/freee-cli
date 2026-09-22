#!/usr/bin/env node
/**
 * freee請求書 API の OpenAPI から `InvoiceShowResponse_invoice` と
 * `..._lines` のプロパティ名を抜き出し、テスト用の oracle を再生成する。
 *
 *   curl -fsSL <UPSTREAM> -o .iv-schema.yml   # UPSTREAM は下の定数
 *   node scripts/gen-iv-invoice-show-keys.mjs
 *
 * oracle を実装（src/commands/invoices/update.ts の写像表）から導出しないこと。
 * 導出すると、写像表を変える変異を検出できなくなる。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SOURCE = ".iv-schema.yml";
// 取得元。SOURCE はこの URL の写しで、sha256 を fixture へ残す（第三者が同じ手順で再現できるようにする）
const UPSTREAM = "https://raw.githubusercontent.com/freee/freee-api-schema/master/iv/open-api-3/api-schema.yml";
const OUT = "tests/fixtures/iv-invoice-show-keys.json";

if (!existsSync(SOURCE)) {
  console.error(`${SOURCE} がありません。先に取得してください:\n  curl -fsSL ${UPSTREAM} -o ${SOURCE}`);
  process.exit(1);
}
const yaml = readFileSync(SOURCE, "utf8");
const properties = (name) => {
  const block = yaml.match(new RegExp(`^    ${name}:\\n([\\s\\S]*?)(?=^    \\S)`, "m"))?.[1];
  if (!block) throw new Error(`schema not found: ${name}`);
  const keys = [...block.matchAll(/^        ([a-zA-Z0-9_]+):$/gm)].map((m) => m[1]);
  if (keys.length === 0) throw new Error(`no properties parsed: ${name}`);
  return keys;
};

const enumOf = (schema, property) => {
  const block = yaml.match(new RegExp(`^    ${schema}:\\n([\\s\\S]*?)(?=^    \\S)`, "m"))?.[1];
  if (!block) throw new Error(`schema not found: ${schema}`);
  const lines = block.split("\n");
  const head = lines.findIndex((line) => line === `        ${property}:`);
  if (head < 0) throw new Error(`property not found: ${schema}.${property}`);
  const body = [];
  for (const line of lines.slice(head + 1)) {
    if (/^ {8}\S/.test(line)) break;   // 次の property
    body.push(line);
  }
  // description の箇条書きを拾わないため、`enum:` の直下だけを読む
  const enumHead = body.findIndex((line) => /^ {10}enum:$/.test(line));
  if (enumHead < 0) throw new Error(`enum not found: ${schema}.${property}`);
  const values = [];
  for (const line of body.slice(enumHead + 1)) {
    const item = line.match(/^ {10}- (.+)$/);
    if (!item) break;                  // enum のリストが終わったら終わり
    const raw = item[1].trim().replace(/^['"]|['"]$/g, "");
    values.push(/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
  }
  if (values.length === 0) throw new Error(`no enum parsed: ${schema}.${property}`);
  return values;
};

const constraintsOf = (schema) => {
  const block = yaml.match(new RegExp(`^    ${schema}:\\n([\\s\\S]*?)(?=^    \\S)`, "m"))?.[1];
  if (!block) throw new Error(`schema not found: ${schema}`);
  const lines = block.split("\n");
  const result = {};
  for (const [index, line] of lines.entries()) {
    const property = line.match(/^        ([a-zA-Z0-9_]+):$/)?.[1];
    if (!property) continue;
    const value = {};
    for (const propertyLine of lines.slice(index + 1)) {
      if (/^ {8}\S/.test(propertyLine)) break;
      const match = propertyLine.match(/^          (type|minLength|maxLength|pattern|minimum|maximum):\s*(.+)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      const raw = rawValue.trim().replace(/^['"]|['"]$/g, "");
      value[key] = ["minLength", "maxLength", "minimum", "maximum"].includes(key) ? Number(raw) : raw;
    }
    if (value.type === undefined) throw new Error(`type not found: ${schema}.${property}`);
    result[property] = value;
  }
  return result;
};

writeFileSync(
  OUT,
  JSON.stringify(
    {
      _source: SOURCE,
      _upstream: UPSTREAM,
      _upstreamSha256: createHash("sha256").update(readFileSync(SOURCE)).digest("hex"),
      _retrieved: new Date().toISOString().slice(0, 10),
      _note: "scripts/gen-iv-invoice-show-keys.mjs で再生成する。手で編集しない。",
      invoice: properties("InvoiceShowResponse_invoice"),
      lines: properties("InvoiceShowResponse_invoice_lines"),
      putResponseLines: properties("InvoiceResponse_invoice_lines"),
      requestConstraints: constraintsOf("InvoiceRequest"),
      requestEnums: {
        tax_entry_method: enumOf("InvoiceRequest", "tax_entry_method"),
        tax_fraction: enumOf("InvoiceRequest", "tax_fraction"),
        line_amount_fraction: enumOf("InvoiceRequest", "line_amount_fraction"),
        withholding_tax_entry_method: enumOf("InvoiceRequest", "withholding_tax_entry_method"),
        partner_title: enumOf("InvoiceRequest", "partner_title"),
        payment_type: enumOf("InvoiceRequest", "payment_type"),
        "lines.type": enumOf("InvoiceRequest_lines", "type"),
        "lines.tax_rate": enumOf("InvoiceRequest_lines", "tax_rate"),
      },
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
console.log(`wrote ${OUT}`);
