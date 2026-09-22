export interface MonthRange {
  month: string;
  startDate: string;
  endDate: string;
}

export function parseMonth(value: string): MonthRange {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error("Invalid month format. Use YYYY-MM");
  }

  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const end = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    month: value,
    startDate: `${yearText}-${monthText}-01`,
    endDate: `${yearText}-${monthText}-${String(end).padStart(2, "0")}`,
  };
}
