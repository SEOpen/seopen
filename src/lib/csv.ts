/**
 * One CSV cell. A text value starting with a formula character gets a leading apostrophe, because
 * these cells hold other sites' page titles and a spreadsheet would otherwise run them as formulas.
 */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  let s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (values: unknown[]) => `${values.map(csvCell).join(",")}\n`;
