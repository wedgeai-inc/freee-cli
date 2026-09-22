import { describe, expect, it } from "vitest";
import { mimeTypeToExtension } from "../../src/lib/mime.js";

describe("mimeTypeToExtension", () => {
  it("maps common receipt mime types", () => {
    expect(mimeTypeToExtension("image/jpeg")).toBe("jpg");
    expect(mimeTypeToExtension("image/png")).toBe("png");
    expect(mimeTypeToExtension("application/pdf")).toBe("pdf");
    expect(mimeTypeToExtension("image/gif")).toBe("gif");
    expect(mimeTypeToExtension("image/heic")).toBe("heic");
    expect(mimeTypeToExtension("image/heif")).toBe("heif");
    expect(mimeTypeToExtension("image/tiff")).toBe("tiff");
    expect(mimeTypeToExtension("image/webp")).toBe("webp");
  });

  it("is case-insensitive and ignores parameters", () => {
    expect(mimeTypeToExtension("IMAGE/JPEG")).toBe("jpg");
    expect(mimeTypeToExtension("image/jpeg; charset=binary")).toBe("jpg");
  });

  it("falls back to bin for unknown or empty types", () => {
    expect(mimeTypeToExtension("application/octet-stream")).toBe("bin");
    expect(mimeTypeToExtension("")).toBe("bin");
    expect(mimeTypeToExtension("image/jpeg2000")).toBe("bin");
  });
});
