import { describe, expect, it } from "vitest";
import { parseCompanyId } from "../../src/lib/company-id.js";

describe("parseCompanyId", () => {
  it("parses positive integer", () => {
    expect(parseCompanyId("1234567")).toBe(1234567);
  });

  it("throws for non-numeric", () => {
    expect(() => parseCompanyId("abc")).toThrow();
  });

  // M2 security fix cases
  it("throws for undefined", () => {
    expect(() => parseCompanyId(undefined as unknown as string)).toThrow();
  });

  it("throws for empty string", () => {
    expect(() => parseCompanyId("")).toThrow();
  });

  it("throws for negative number", () => {
    expect(() => parseCompanyId("-1")).toThrow();
  });

  it("throws for zero", () => {
    expect(() => parseCompanyId("0")).toThrow();
  });

  it("throws for decimal", () => {
    expect(() => parseCompanyId("1234567.5")).toThrow();
  });

  it("throws for alphanumeric suffix", () => {
    expect(() => parseCompanyId("1234567abc")).toThrow();
  });

  it("throws if exceeds safe integer range", () => {
    expect(() => parseCompanyId("99999999999999999")).toThrow();
  });

  it("parses small valid id", () => {
    expect(parseCompanyId("1")).toBe(1);
  });
});
