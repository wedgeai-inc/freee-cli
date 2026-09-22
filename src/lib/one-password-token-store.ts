import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface OAuthTokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type OpRun = (args: readonly string[], stdin?: string) => Promise<{ stdout: string }>;
export type OAuthItemResolver = (profile: string) => string;
export type OAuthVaultResolver = (profile: string) => string | undefined;
export interface OpChild extends EventEmitter {
  stdout: EventEmitter;
  stdin: EventEmitter & { end(data?: string): void };
  kill(signal?: NodeJS.Signals): boolean;
}
export type OpSpawn = (args: readonly string[]) => OpChild;

export interface OnePasswordTokenStoreOptions {
  run?: OpRun;
  resolveItem?: OAuthItemResolver;
  resolveVault?: OAuthVaultResolver;
  spawnFn?: OpSpawn;
  opTimeoutMs?: number;
}

interface OnePasswordItem {
  fields?: Array<{ label?: unknown; value?: unknown }>;
}

/**
 * Resolves only an injected value. The resulting item reference must never be
 * logged, persisted, or placed in test fixtures.
 */
/**
 * profile から環境変数名の中核部分を作る。小文字と数字とハイフンだけに限る。
 * 大文字や _ を許すと、生成規則（大文字化 + "-"→"_"）で acme-a / acme_a /
 * ACME_A が同じ変数へ衝突し、別アカウントのつもりで使い分けた profile の
 * rotation が互いの item を上書きする。item 参照と vault の双方で同じ規則を使う。
 */
function profileEnvSuffix(profile: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) throw new Error("freee OAuth profile is invalid");
  return profile.toUpperCase().replace(/-/g, "_");
}

export function getOAuthItemReference(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  const reference = env[`FREEE_OAUTH_ITEM_REFERENCE_${profileEnvSuffix(profile)}`];
  if (reference === undefined || reference.trim().length === 0) {
    throw new Error("freee OAuth token store is not configured for this profile");
  }
  return reference.trim();
}

/**
 * Service account では `op item get` / `item edit` に vault の指定が要る
 * （"a vault query must be provided when this command is called by a service account"）。
 * 個人アカウントでは省略できるので、注入されたときだけ付ける。
 * vault 名は credential ではないが、参照と同じく実行時注入にしてコードへ埋め込まない。
 */
export function getOAuthVault(profile: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const vault = env[`FREEE_OAUTH_VAULT_${profileEnvSuffix(profile)}`];
  if (vault === undefined || vault.trim().length === 0) return undefined;
  return vault.trim();
}

export class OnePasswordTokenStore {
  readonly #run: OpRun;
  readonly #resolveItem: OAuthItemResolver;
  readonly #resolveVault: OAuthVaultResolver;

  constructor(options: OnePasswordTokenStoreOptions = {}) {
    this.#run = options.run ?? ((args, stdin) => runOp(args, stdin, {
      spawnFn: options.spawnFn,
      timeoutMs: options.opTimeoutMs,
    }));
    this.#resolveItem = options.resolveItem ?? getOAuthItemReference;
    this.#resolveVault = options.resolveVault ?? getOAuthVault;
  }

  async load(profile: string): Promise<OAuthTokenBundle> {
    const item = await this.#readItem(profile);
    return readBundle(item);
  }

  async save(profile: string, bundle: OAuthTokenBundle): Promise<void> {
    validateBundle(bundle);
    const reference = this.#resolveItem(profile);
    const vault = this.#resolveVault(profile);
    const item = await this.#readItemWithReference(reference, vault);
    const template = replaceBundle(item, bundle);
    try {
      // The template, including credentials, is intentionally supplied only on stdin.
      await this.#run(withVault(["item", "edit", reference], vault), `${JSON.stringify(template)}\n`);
      const saved = await this.#readItemWithReference(reference, vault);
      if (!bundlesMatch(readBundle(saved), bundle)) throw new Error("read-back mismatch");
    } catch {
      throw new Error("freee OAuth token store could not be updated");
    }
  }

  async #readItem(profile: string): Promise<OnePasswordItem> {
    return this.#readItemWithReference(this.#resolveItem(profile), this.#resolveVault(profile));
  }

  async #readItemWithReference(reference: string, vault?: string): Promise<OnePasswordItem> {
    let stdout: string;
    try {
      // --reveal が無いと concealed field がマスク値で返り、token の読み出しと
      // read-back 照合の両方が壊れる（op item get の既定は conceal）
      ({ stdout } = await this.#run(withVault(["item", "get", reference, "--format", "json", "--reveal"], vault)));
    } catch {
      throw new Error("freee OAuth token store could not be read");
    }
    try {
      const item = JSON.parse(stdout) as unknown;
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error();
      return item as OnePasswordItem;
    } catch {
      throw new Error("freee OAuth token store returned an invalid item");
    }
  }
}

/** vault が注入されているときだけ --vault を足す。service account では必須、個人アカウントでは省略可 */
function withVault(args: readonly string[], vault?: string): string[] {
  return vault === undefined ? [...args] : [...args, "--vault", vault];
}

function readBundle(item: OnePasswordItem): OAuthTokenBundle {
  const accessToken = getField(item, "access_token");
  const refreshToken = getField(item, "refresh_token");
  const expiresAt = Number(getField(item, "expires_at"));
  const bundle = { accessToken, refreshToken, expiresAt };
  try {
    validateBundle(bundle);
  } catch {
    throw new Error("freee OAuth token store contains an invalid token bundle");
  }
  return bundle;
}

function replaceBundle(item: OnePasswordItem, bundle: OAuthTokenBundle): { fields: Array<{ label?: unknown; value?: unknown }> } {
  if (!Array.isArray(item.fields)) throw new Error("freee OAuth token store returned an invalid item");
  const values: Record<string, string> = {
    access_token: bundle.accessToken,
    refresh_token: bundle.refreshToken,
    expires_at: String(bundle.expiresAt),
  };
  const seen = new Set<string>();
  const fields = item.fields.map((field) => {
    if (typeof field.label === "string" && field.label in values) {
      seen.add(field.label);
      return { ...field, value: values[field.label] };
    }
    return field;
  });
  if (seen.size !== Object.keys(values).length) {
    throw new Error("freee OAuth token store contains an invalid token bundle");
  }
  return { fields };
}

function bundlesMatch(left: OAuthTokenBundle, right: OAuthTokenBundle): boolean {
  return left.accessToken === right.accessToken && left.refreshToken === right.refreshToken && left.expiresAt === right.expiresAt;
}

function getField(item: OnePasswordItem, label: string): string {
  const value = item.fields?.find((field) => field.label === label)?.value;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("invalid token field");
  return value.trim();
}

function validateBundle(bundle: OAuthTokenBundle): void {
  if (bundle.accessToken.trim().length === 0 || bundle.refreshToken.trim().length === 0 || !Number.isFinite(bundle.expiresAt) || bundle.expiresAt <= 0) {
    throw new Error("invalid token bundle");
  }
}

const DEFAULT_OP_TIMEOUT_MS = 30_000;
/** SIGTERM を無視された場合に SIGKILL へ昇格するまでの猶予 */
const ESCALATE_MS = 2_000;

/**
 * `op` は stdin が **FIFO のときだけ** item template として読む（**op 2.38.1 / macOS で実測**。
 * この前提が解消されれば、以下の cat 介在・detached・グループ kill・シグナル転送は
 * すべて不要になるので、版を上げたら再測すること）。
 * Node の `spawn` が `stdio: "pipe"` で子へ渡す stdin は macOS では **socketpair** になり、
 * `op` はそれを piped input と見なさない。その場合 `op item edit` は
 * **exit 0 を返し item の version も上げるのに、field の値だけ更新しない**（実測）。
 * 書き戻しが黙って失われるため、`cat` を挟んで本物の FIFO を作る。
 * credential は引き続き stdin だけを通り、argv にも一時ファイルにも出ない。
 */
export interface OpSpawnPlan {
  command: string;
  argv: string[];
  /** detached はプロセスグループを作るために必須。外すと timeout 時に op が生き残る */
  options: { stdio: ["pipe", "pipe", "ignore"]; detached: true };
}

export function buildOpSpawnArgs(args: readonly string[], executable = "op"): OpSpawnPlan {
  // "$@" の先頭は sh が $0 として消費するため、番兵として executable を 2 回渡す。
  // cat は絶対パスで指定して PATH の探索点を増やさない
  return {
    command: "/bin/sh",
    argv: ["-c", 'exec /bin/cat | "$@"', executable, executable, ...args],
    options: { stdio: ["pipe", "pipe", "ignore"], detached: true },
  };
}

/**
 * timeout 時に pipeline 全体を落とすため、子を **プロセスグループのリーダー**にする。
 * `child.kill()` は `/bin/sh` にしか届かず、pipeline の `op` は生き残って
 * reparent される。生き残った `op` は timeout 後に書き込みを完了しうるため、
 * 「失敗と報告したのに store は更新済み」という食い違いが起きる。
 * detached でグループを作り、`kill(-pid)` でグループごと落とす。
 */
/**
 * pipeline 用の kill を組み立てる。実プロセスに依存しないので直接検査できる。
 *
 * 守る性質は 2 つ。
 * 1. **fallback は差し替え前の kill を呼ぶ。** wrapped と child は同一オブジェクトなので、
 *    差し替え後の kill を fallback へ渡すと自分を再び呼び、無限再帰になる
 * 2. **終了後は group kill を呼ばない。** 保存済み pid へ `process.kill(-pid)` を送るため、
 *    終了後に呼ぶと pid 再利用で無関係なプロセスグループへ届きうる
 */
export function createPipelineKill(params: {
  pid: number | undefined;
  detached: boolean;
  originalKill: (signal?: NodeJS.Signals) => boolean;
  isExited: () => boolean;
  killGroup?: typeof killProcessGroup;
}): (signal?: NodeJS.Signals) => boolean {
  const killGroup = params.killGroup ?? killProcessGroup;
  return (signal?: NodeJS.Signals) => {
    if (params.isExited()) return false;
    return killGroup(params.pid, signal ?? "SIGTERM", { kill: params.originalKill }, params.detached);
  };
}

export function spawnOpChild(args: readonly string[], executable = "op"): OpChild {
  const { command, argv, options } = buildOpSpawnArgs(args, executable);
  const child = spawn(command, argv, options);
  const originalKill = child.kill.bind(child);
  let exited = false;
  child.once("close", () => { exited = true; });
  const wrapped = child as unknown as OpChild;
  wrapped.kill = createPipelineKill({
    pid: child.pid,
    detached: options.detached,
    originalKill,
    isExited: () => exited,
  });
  return wrapped;
}

function defaultSpawnOp(args: readonly string[]): OpChild {
  return spawnOpChild(args);
}

/**
 * 自分のプロセスグループを撃たないよう pid を検査してからグループへ送る。
 * `detached` が false なら子はグループリーダーではないので、-pid は無関係な
 * グループを指しうる。その場合はグループ kill を試みず子単体へ落とす。
 * `child.kill` には**差し替え前の実装**を渡すこと（差し替え後を渡すと自己再帰する）。
 */
export function killProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  child: { kill(s?: NodeJS.Signals): boolean },
  detached = false,
): boolean {
  if (!detached || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return child.kill(signal);
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // グループが既に消えている場合など。子単体へ落とす
    return child.kill(signal);
  }
}

/**
 * 停止シグナルを受けたときに、**この時点で走っている全 pipeline** をまとめて止める。
 *
 * pipeline ごとに handler を持つと、先に閉じた 1 本が親を終了させてしまい、
 * SIGTERM を無視する別の pipeline の SIGKILL 昇格が発火しないまま残る。
 * 調整役をプロセスに 1 つだけ置き、全件の close か共通の deadline を待ってから
 * 1 回だけ自己再送する。
 */
type ManagedPipeline = {
  kill: (signal: NodeJS.Signals) => void;
  abort: (error: Error) => void;
  isExited: () => boolean;
  onceClosed: (callback: () => void) => void;
};

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const activePipelines = new Set<ManagedPipeline>();
let signalHandlers: (readonly [NodeJS.Signals, () => void])[] | undefined;

function detachSignalHandlers(): void {
  if (!signalHandlers) return;
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers = undefined;
}

function attachSignalHandlers(): void {
  if (signalHandlers) return;
  signalHandlers = FORWARDED_SIGNALS.map((signal) => [signal, () => onStopSignal(signal)] as const);
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
}

function onStopSignal(signal: NodeJS.Signals): void {
  const pipelines = [...activePipelines];
  activePipelines.clear();
  // **ハンドラを 1 つでも残すと Node は既定の終了動作を行わない。**
  // 先に解除しておき、撤去が終わってから自分へ送り直して既定へ委ねる。
  // この結果、2 回目の Ctrl+C は既定動作で即座に効く（昇格を待たない）。
  // 強制終了の意図を優先する側に倒している
  detachSignalHandlers();
  for (const pipeline of pipelines) {
    pipeline.kill(signal);
    pipeline.abort(new Error("op command interrupted"));
  }
  // **他に listener がいるなら再送しない。** 再送は「自分の handler を外したので
  // 既定の終了動作へ戻す」ための手段であって、終了そのものの要求ではない。
  // 呼び出し側が独自の listener を持つ場合、再送するとそれが 2 回発火し、
  // しかも listener が残っている以上 Node は既定の終了を行わない。
  // その場合は終了の判断を持ち主へ委ねる
  const reraise = () => {
    if (FORWARDED_SIGNALS.includes(signal) && process.listenerCount(signal) > 0) return;
    try { process.kill(process.pid, signal); } catch { /* 既に終了 */ }
  };
  const pending = pipelines.filter((pipeline) => !pipeline.isExited());
  if (pending.length === 0) { reraise(); return; }
  let remaining = pending.length;
  let deadline: NodeJS.Timeout | undefined;
  let done = false;
  const reraiseOnce = () => {
    if (done) return;
    done = true;
    if (deadline) clearTimeout(deadline);
    reraise();
  };
  // 無視する子がいても、SIGKILL 昇格の猶予を過ぎたら親は終了する
  deadline = setTimeout(reraiseOnce, ESCALATE_MS + 500);
  deadline.unref?.();
  for (const pipeline of pending) {
    pipeline.onceClosed(() => { remaining -= 1; if (remaining === 0) reraiseOnce(); });
  }
}

export function runOp(
  args: readonly string[],
  stdin?: string,
  options: { spawnFn?: OpSpawn; timeoutMs?: number } = {},
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      reject(new Error("op command timeout is invalid"));
      return;
    }
    const child = options.spawnFn?.(args) ?? defaultSpawnOp(args);
    let stdout = "";
    let settled = false;
    // detached でプロセスグループを分けたため、親が受ける停止シグナルは子へ届かない。
    // 転送しないと Ctrl+C やサービス停止のあとも op が書き込みを完了しうる
    // （timeout と同じ「中断したのに store は更新済み」になる）。
    // 転送そのものは、並行実行を踏まえてプロセス単位の調整役が行う
    const managed: ManagedPipeline = {
      kill: (signal) => killPipeline(signal),
      abort: (error) => finish(error),
      isExited: () => childExited,
      onceClosed: (callback) => { child.once("close", callback); },
    };
    const unregister = () => {
      activePipelines.delete(managed);
      if (activePipelines.size === 0) detachSignalHandlers();
    };
    activePipelines.add(managed);
    attachSignalHandlers();
    // SIGTERM を無視された場合に備えた SIGKILL。**1 回だけ張り、close で取り消す。**
    // 張りっぱなしにすると、終了後の pid へ再び kill を送る余地が残る
    let killer: NodeJS.Timeout | undefined;
    let childExited = false;
    const killPipeline = (signal: NodeJS.Signals) => {
      let sent = false;
      try { sent = child.kill(signal); } catch { /* 既に終了 */ }
      if (!sent || killer) return;
      killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 既に終了 */ } }, ESCALATE_MS);
      killer.unref?.();
    };
    child.once("close", () => {
      childExited = true;
      if (killer) { clearTimeout(killer); killer = undefined; }
    });
    const timeout = setTimeout(() => {
      killPipeline("SIGTERM");
      finish(new Error("op command timed out"));
    }, timeoutMs);
    const finish = (error?: Error, result?: { stdout: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unregister();
      // **失敗で抜けるとき pipeline を放置しない。** timeout を消し転送も外した後は
      // 止める仕掛けが何も残らず、op が動き続けて書き込みを完了しうる（待ちに上限も無い）。
      // 既に終了していれば killPipeline は何もしない（exited ガードと close 取消がある）
      if (error) killPipeline("SIGTERM");
      if (error) reject(error);
      else resolve(result!);
    };
    // 配線の途中で例外が出ても、登録したまま抜けない（handler が張りっぱなしになる）
    try {
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.once("error", () => finish(new Error("op command failed")));
      child.once("close", (code: number | null) => code === 0 ? finish(undefined, { stdout }) : finish(new Error("op command failed")));
      child.stdin.on("error", () => finish(new Error("op stdin failed")));
      child.stdin.end(stdin);
    } catch {
      finish(new Error("op stdin failed"));
    }
  });
}
