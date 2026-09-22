/**
 * freee ファイルボックスの証憑 MIME タイプをファイル拡張子へ変換する。
 * 大文字小文字とパラメータ (`; charset=...`) を無視し、未知の型は "bin" を返す。
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

export function mimeTypeToExtension(mimeType: string): string {
  const base = (mimeType.toLowerCase().split(";")[0] ?? "").trim();
  return EXTENSION_BY_MIME[base] ?? "bin";
}
