import { describe, expect, it } from "vitest";
import { parseMonth } from "../../src/lib/month.js";

describe("parseMonth", () => {
  it("parses YYYY-MM into range", () => {
    expect(parseMonth("2026-04")).toEqual({
      month: "2026-04",
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    });
  });

  it("rejects invalid format", () => {
    expect(() => parseMonth("2026/04")).toThrow("Invalid month format");
  });
});
