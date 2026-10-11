/**
 * 書き込みの前に時刻を 1 回取り、以後の時計の失敗（例外・不正な Date）で最初の時刻へ戻す。
 * 書き込み（POST / PUT）の後に時計が壊れても、POST の状態を持つ例外・audit の記録まで届くようにする。
 * 最初の取得の失敗は、書き込みの前に出る（何も送られていない）。
 */
export function stableClock(now: () => Date): () => Date {
  const first = now();
  if (!(first instanceof Date) || Number.isNaN(first.getTime())) throw new Error("clock returned an invalid date");
  return () => {
    try {
      const d = now();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
    } catch {
      /* 最初の時刻へ戻す */
    }
    return first;
  };
}
