import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import type { ExpenseApplicationSummary } from "../../types/expense.js";

export interface ExpenseListOptions {
  companyId: number;
  status?: string;
  startTransactionDate?: string;
  endTransactionDate?: string;
  limit?: number;
  format?: "json" | "table";
}

export interface ExpenseListDeps {
  client: PublicFreeeClient;
}

export interface ExpenseListResult {
  items: ExpenseApplicationSummary[];
}

/**
 * 経費申請一覧を取得する（pagination 対応）。
 */
export async function runExpenseList(
  opts: ExpenseListOptions,
  deps: ExpenseListDeps,
): Promise<ExpenseListResult> {
  const query: Record<string, string | number | boolean | null | undefined> = {
    company_id: opts.companyId,
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.startTransactionDate ? { start_transaction_date: opts.startTransactionDate } : {}),
    ...(opts.endTransactionDate ? { end_transaction_date: opts.endTransactionDate } : {}),
  };

  const items: ExpenseApplicationSummary[] = [];
  for await (const item of deps.client.listAll<ExpenseApplicationSummary>(
    "/api/1/expense_applications",
    query,
  )) {
    items.push(item);
  }

  return { items };
}

export function formatExpenseList(result: ExpenseListResult, format: "json" | "table"): string {
  if (format === "json") {
    return JSON.stringify(result.items, null, 2);
  }
  // table format: header + rows
  const lines = [
    "id\t\tstatus\t\tamount\t\ttitle",
    ...result.items.map(
      (item) => `${item.id}\t\t${item.status}\t\t${item.total_amount ?? "-"}\t\t${item.title ?? ""}`,
    ),
  ];
  return lines.join("\n");
}
