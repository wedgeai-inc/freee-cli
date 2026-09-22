/** 経費申請一覧（Public API `GET /api/1/expense_applications`）の 1 件。 */
export interface ExpenseApplicationSummary {
  id: number;
  status: string;
  title?: string;
  issue_date?: string;
  total_amount?: number | null;
  applicant_id?: number | null;
  approver_id?: number | null;
  approval_flow_route_id?: number | null;
  current_step_id?: number | null;
  current_round?: number | null;
  payroll_attached?: boolean;
}
