import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface MainModuleDeps {
  realpath?: (path: string) => string;
  toUrl?: (path: string) => URL;
}

/**
 * このモジュールが `node <path>` で直接起動されたかを判定する。
 * `import.meta.url` はパーセントエンコード済みの URL で、ESM の main はシンボリックリンクを解決した
 * 実体のパスになる。`process.argv[1]` は起動時のパスのままなので、実体へ解決してから URL に変換して比べる。
 */
export function isMainModule(moduleUrl: string, argv1: string | undefined, deps: MainModuleDeps = {}): boolean {
  if (argv1 === undefined) return false;
  const realpath = deps.realpath ?? realpathSync;
  const toUrl = deps.toUrl ?? pathToFileURL;
  let resolved = argv1;
  try {
    resolved = realpath(argv1);
  } catch {
    // 解決できないときは起動時のパスで比べる
  }
  return toUrl(resolved).href === moduleUrl;
}
