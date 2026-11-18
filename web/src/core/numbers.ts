// Number parsing and formatting.
// Port of to_number / fmt_value / pct_change in desktop/generic_performance.py.
// Rounding and summing deliberately copy Python's behaviour so both apps print
// the same digits.

/** A cell value as read from a CSV or Excel file. */
export type Cell = string | number | boolean | null;

const EMPTY_TOKENS = new Set(["", "--", "-", "—", "n/a", "na", "none", "null"]);
const NON_NUMERIC = /[^\d,.\-]/g;

/** Python's str() for the cell types we produce. */
export function pyStr(value: Cell): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

export function isEmpty(value: Cell): boolean {
  return value === null || EMPTY_TOKENS.has(pyStr(value).trim().toLowerCase());
}

export function norm(value: Cell | undefined): string {
  if (value === null || value === undefined) return "";
  return pyStr(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function toNumber(value: Cell | undefined): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return value;
  let s = value.trim().replace(/ /g, "");
  if (EMPTY_TOKENS.has(s.toLowerCase())) return null;
  const isPct = s.endsWith("%");
  const isNegParen = s.startsWith("(") && s.endsWith(")");
  s = s.replace(NON_NUMERIC, "");
  if (!s || s === "-") return null;
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(/,/g, ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    const parts = s.split(",");
    s = parts.length === 2 && parts[1].length !== 3 ? s.replace(/,/g, ".") : s.replace(/,/g, "");
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, "");
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null; // what Python's float() accepts here
  let x = Number(s);
  if (isNegParen) x = -Math.abs(x);
  return isPct ? x / 100 : x;
}

/** Python's round(x) for a float: round half to even, returns an integer. */
export function pyRound(x: number): number {
  const r = Math.round(x);
  const out = Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  return out === 0 ? 0 : out; // no negative zero
}

/** Digits of |x| to 2 decimals, rounded like Python's "%.2f" (half to even on exact ties). */
function fixed2(ax: number): string {
  // A float sits exactly halfway at 2 decimals only when 8x is an odd integer.
  const e = ax * 8;
  if (Number.isInteger(e) && e % 2 !== 0) {
    let n = Math.floor(ax * 100);
    if (n % 2 !== 0) n += 1;
    return (n / 100).toFixed(2);
  }
  return ax.toFixed(2);
}

function group(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtInt(n: number, thousands: boolean): string {
  const neg = n < 0;
  const digits = BigInt(Math.abs(n)).toString(); // exact for large values too
  return (neg ? "-" : "") + (thousands ? group(digits) : digits);
}

function fmtFixed2(x: number, thousands: boolean): string {
  const neg = x < 0 || Object.is(x, -0);
  const [i, f] = fixed2(Math.abs(x)).split(".");
  return (neg ? "-" : "") + (thousands ? group(i) : i) + "." + f;
}

export type Kind = "money" | "int" | "num" | "pct";

export function fmtValue(value: number | null, kind: Kind, decSep = ".", thousands = false): string {
  if (value === null) return "";
  let s: string;
  if (kind === "int") {
    s = fmtInt(pyRound(value), thousands);
  } else if (kind === "pct") {
    s = fmtFixed2(value * 100, false) + "%";
  } else if (kind === "num") {
    s = Math.abs(value - pyRound(value)) < 1e-9 ? fmtInt(pyRound(value), thousands) : fmtFixed2(value, thousands);
  } else {
    s = fmtFixed2(value, thousands);
  }
  if (decSep !== ".") {
    s = s.replace(/,/g, "\0").replace(/\./g, decSep).replace(/\0/g, thousands ? "." : "");
  }
  if (kind === "money") s = s.startsWith("-") ? "-$" + s.slice(1) : "$" + s;
  return s;
}

export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

/** Python 3.12+ sum() of floats (Neumaier compensated summation). */
export function pySum(xs: number[]): number {
  let total = 0;
  let c = 0;
  for (const x of xs) {
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) c += total - t + x;
    else c += x - t + total;
    total = t;
  }
  if (c && Number.isFinite(c)) total += c;
  return total;
}
