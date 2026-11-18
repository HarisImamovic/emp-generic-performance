export type Cell = string | number | boolean | null;
export type Kind = "money" | "int" | "num" | "pct";

const EMPTY_TOKENS = new Set(["", "--", "-", "—", "n/a", "na", "none", "null"]);
const NON_NUMERIC_CHARACTERS = /[^\d,.\-]/g;
const PLAIN_DECIMAL = /^-?(\d+\.?\d*|\.\d+)$/;

export function pythonStr(value: Cell): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

export function isEmpty(value: Cell): boolean {
  return value === null || EMPTY_TOKENS.has(pythonStr(value).trim().toLowerCase());
}

export function normalizeKey(value: Cell | undefined): string {
  if (value === null || value === undefined) return "";
  return pythonStr(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeSeparators(digits: string): string {
  const hasComma = digits.includes(",");
  const hasDot = digits.includes(".");
  if (hasComma && hasDot) {
    const commaIsDecimal = digits.lastIndexOf(",") > digits.lastIndexOf(".");
    return commaIsDecimal ? digits.replace(/\./g, "").replace(/,/g, ".") : digits.replace(/,/g, "");
  }
  if (hasComma) {
    const parts = digits.split(",");
    const commaIsDecimal = parts.length === 2 && parts[1].length !== 3;
    return commaIsDecimal ? digits.replace(/,/g, ".") : digits.replace(/,/g, "");
  }
  const dotCount = (digits.match(/\./g) ?? []).length;
  return dotCount > 1 ? digits.replace(/\./g, "") : digits;
}

export function toNumber(value: Cell | undefined): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return value;

  const text = value.trim().replace(/ /g, "");
  if (EMPTY_TOKENS.has(text.toLowerCase())) return null;

  const isPercent = text.endsWith("%");
  const isNegativeInParentheses = text.startsWith("(") && text.endsWith(")");
  const digits = text.replace(NON_NUMERIC_CHARACTERS, "");
  if (!digits || digits === "-") return null;

  const decimal = normalizeSeparators(digits);
  if (!PLAIN_DECIMAL.test(decimal)) return null;

  const number = isNegativeInParentheses ? -Math.abs(Number(decimal)) : Number(decimal);
  return isPercent ? number / 100 : number;
}

export function pythonRound(x: number): number {
  const rounded = Math.round(x);
  const isTie = Math.abs(x % 1) === 0.5;
  const result = isTie && rounded % 2 !== 0 ? rounded - 1 : rounded;
  return result === 0 ? 0 : result;
}

function isExactTieAtTwoDecimals(x: number): boolean {
  const eighths = x * 8;
  return Number.isInteger(eighths) && eighths % 2 !== 0;
}

function pythonFixed2(absolute: number): string {
  if (!isExactTieAtTwoDecimals(absolute)) return absolute.toFixed(2);
  const lower = Math.floor(absolute * 100);
  const even = lower % 2 === 0 ? lower : lower + 1;
  return (even / 100).toFixed(2);
}

function withThousandsSeparators(integerDigits: string): string {
  return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatInteger(n: number, thousands: boolean): string {
  const digits = BigInt(Math.abs(n)).toString();
  const sign = n < 0 ? "-" : "";
  return sign + (thousands ? withThousandsSeparators(digits) : digits);
}

function formatTwoDecimals(x: number, thousands: boolean): string {
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const [integerPart, fraction] = pythonFixed2(Math.abs(x)).split(".");
  return `${sign}${thousands ? withThousandsSeparators(integerPart) : integerPart}.${fraction}`;
}

function isWholeNumber(value: number): boolean {
  return Math.abs(value - pythonRound(value)) < 1e-9;
}

function formatByKind(value: number, kind: Kind, thousands: boolean): string {
  switch (kind) {
    case "int":
      return formatInteger(pythonRound(value), thousands);
    case "pct":
      return formatTwoDecimals(value * 100, false) + "%";
    case "num":
      return isWholeNumber(value) ? formatInteger(pythonRound(value), thousands) : formatTwoDecimals(value, thousands);
    case "money":
      return formatTwoDecimals(value, thousands);
  }
}

function applyDecimalSeparator(text: string, decimalSeparator: string, thousands: boolean): string {
  if (decimalSeparator === ".") return text;
  return text
    .replace(/,/g, "\0")
    .replace(/\./g, decimalSeparator)
    .replace(/\0/g, thousands ? "." : "");
}

function withCurrency(text: string): string {
  return text.startsWith("-") ? "-$" + text.slice(1) : "$" + text;
}

export function formatValue(value: number | null, kind: Kind, decimalSeparator = ".", thousands = false): string {
  if (value === null) return "";
  const text = applyDecimalSeparator(formatByKind(value, kind, thousands), decimalSeparator, thousands);
  return kind === "money" ? withCurrency(text) : text;
}

export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export function pythonSum(values: number[]): number {
  let total = 0;
  let compensation = 0;
  for (const x of values) {
    const next = total + x;
    compensation += Math.abs(total) >= Math.abs(x) ? total - next + x : x - next + total;
    total = next;
  }
  return compensation && Number.isFinite(compensation) ? total + compensation : total;
}
