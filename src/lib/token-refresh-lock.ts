import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TokenRefreshLockOptions {
  /** Defaults to ~/.cache/freee-cli. Tests must inject a temporary directory. */
  lockDir?: string;
  /** Liveness probe for the PID recorded in an existing lock. Throws/false means not alive. */
  isProcessAlive?: (pid: number) => boolean;
}

export function defaultTokenRefreshLockDir(): string {
  return join(homedir(), ".cache", "freee-cli");
}

/**
 * Run `fn` while holding an exclusive per-profile lock file (O_EXCL). Never waits:
 * if another live process holds the lock, fails immediately. A lock whose PID is
 * no longer alive is removed once and re-acquired. Only the lock this call created
 * is removed afterwards.
 */
export async function withTokenRefreshLock<T>(
  profile: string,
  options: TokenRefreshLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  // Same rule as the 1Password profile suffix; also keeps the lock path inside lockDir.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) throw new Error("freee OAuth profile is invalid");
  const lockDir = options.lockDir ?? defaultTokenRefreshLockDir();
  const lockPath = join(lockDir, `${profile}.lock`);
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const content = `${process.pid} ${randomUUID()}\n`;

  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  if (!(await tryCreate(lockPath, content))) {
    const holder = await readHolderPid(lockPath);
    if (holder === undefined || isAlive(holder)) throw lockHeldError(lockPath);
    await unlink(lockPath).catch(() => undefined);
    if (!(await tryCreate(lockPath, content))) throw lockHeldError(lockPath);
  }
  try {
    return await fn();
  } finally {
    const current = await readFile(lockPath, "utf8").catch(() => undefined);
    if (current === content) await unlink(lockPath).catch(() => undefined);
  }
}

async function tryCreate(path: string, content: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return true;
}

async function readHolderPid(path: string): Promise<number | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  const token = text?.split(/\s/)[0] ?? "";
  if (!/^[1-9][0-9]*$/.test(token)) return undefined;
  const pid = Number(token);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else → treat as alive.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockHeldError(lockPath: string): Error {
  const home = homedir();
  const shown = lockPath.startsWith(`${home}/`) ? `~${lockPath.slice(home.length)}` : lockPath;
  return new Error(
    "同じprofileのtoken更新が既に実行中です。" +
    `終わるまで待つか、残ったlockファイル \`${shown}\` を確認してください。`,
  );
}
