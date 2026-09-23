import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface MainModuleDeps {
  realpath?: (path: string) => string;
  toUrl?: (path: string) => URL;
}

/**
 * このモジュールが `node <path>` で直接起動されたかを判定する。
 * `import.meta.url` はパーセントエンコード済みの URL で、ESM の main は通常シンボリックリンクを解決した
 * 実体のパスになる（`--preserve-symlinks-main` を付けるとリンク側のまま）。`process.argv[1]` は起動時の
 * パスのままなので、起動時のパスと実体のパスの両方を URL に変換して比べる。
 */
export function isMainModule(moduleUrl: string, argv1: string | undefined, deps: MainModuleDeps = {}): boolean {
  if (argv1 === undefined) return false;
  const realpath = deps.realpath ?? realpathSync;
  const toUrl = deps.toUrl ?? pathToFileURL;
  if (toUrl(argv1).href === moduleUrl) return true;
  try {
    return toUrl(realpath(argv1)).href === moduleUrl;
  } catch {
    // 解決できないときは起動時のパスでの比較結果だけで判定する
    return false;
  }
}
