import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** 既存ディレクトリの権限を変えず、監査ログへ追記する。 */
export function secureAppend(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 最終要素のリンクを辿らず、FIFOでも検査前に待ち続けない。
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) throw new Error("監査ログの出力先は通常ファイルである必要があります");
    // 所有者の権限だけを制限したファイルは緩めず、追加の権限があれば締める。
    if ((file.mode & 0o7177) !== 0) fchmodSync(fd, 0o600);
    appendFileSync(fd, data, { encoding: "utf8", mode: 0o600 });
  } finally {
    closeSync(fd);
  }
}
