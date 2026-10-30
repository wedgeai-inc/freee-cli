import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";

export type WalletableType = "bank_account" | "credit_card" | "wallet";

const WALLETABLE_TYPES: readonly WalletableType[] = ["bank_account", "credit_card", "wallet"];

export interface WalletableSummary {
  id: number;
  type: string;
  name: string;
  sync_status?: string;
  last_synced_at?: string;
}

export interface WalletablesListOptions {
  companyId: number;
  type?: WalletableType;
}

export interface WalletablesListDeps {
  client: PublicFreeeClient;
}

export interface WalletablesListResult {
  items: WalletableSummary[];
}

/** API 応答から Summary の項目だけを取り出す（未定義フィールドを JSON 出力へ素通ししない）。 */
function toWalletableSummary(raw: Record<string, unknown>): WalletableSummary {
  const item: WalletableSummary = {
    id: Number(raw.id),
    type: String(raw.type ?? ""),
    name: String(raw.name ?? ""),
  };
  if (typeof raw.sync_status === "string") item.sync_status = raw.sync_status;
  if (typeof raw.last_synced_at === "string") item.last_synced_at = raw.last_synced_at;
  return item;
}

export async function runWalletablesList(
  opts: WalletablesListOptions,
  deps: WalletablesListDeps,
): Promise<WalletablesListResult> {
  if (opts.type !== undefined && !(WALLETABLE_TYPES as readonly string[]).includes(opts.type)) {
    throw new Error(`type must be bank_account, credit_card, or wallet (got: "${opts.type}")`);
  }

  const query: Record<string, string | number | boolean | null | undefined> = {
    company_id: opts.companyId,
    with_sync_status: true,
    with_last_synced_at: true,
  };
  if (opts.type !== undefined) query.type = opts.type;

  const response = await deps.client.get("/api/1/walletables", { query });
  const payload = (await response.json()) as { walletables?: Array<Record<string, unknown>> };
  return { items: (payload.walletables ?? []).map(toWalletableSummary) };
}

export function formatWalletablesList(result: WalletablesListResult, format: "json" | "table"): string {
  if (format === "json") {
    return JSON.stringify(result.items, null, 2);
  }
  return [
    "id\ttype\tname\tsync_status\tlast_synced_at",
    ...result.items.map(
      (item) =>
        `${item.id}\t${item.type}\t${item.name}\t${item.sync_status ?? ""}\t${item.last_synced_at ?? ""}`,
    ),
  ].join("\n");
}
