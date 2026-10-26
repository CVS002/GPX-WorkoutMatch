/**
 * Python-compatible numerics and formatting.
 *
 * The engine was written in Python and its outputs (rounded scores, km labels,
 * syntax lines) must come out identical here. JavaScript differs in exactly the
 * places that matter: Python's round() is round-half-even on the exact binary
 * value, `%` takes the divisor's sign, `//` floors, and str(float)/format() print
 * "12.0", "1e-05" and "{:g}" differently. Everything numeric that the Python
 * rounded or formatted goes through these helpers.
 */

const DV = new DataView(new ArrayBuffer(8));

/** |x| = mant * 2^exp exactly. */
function decompose(x: number): { mant: bigint; exp: number } {
  DV.setFloat64(0, x);
  const hi = DV.getUint32(0);
  const lo = DV.getUint32(4);
  const eb = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (eb === 0) {
    exp = -1074;
  } else {
    mant |= 1n << 52n;
    exp = eb - 1075;
  }
  return { mant, exp };
}

/** round_half_even(|x| * 10^d), computed exactly (d may be negative). */
function scaledHalfEven(x: number, d: number): bigint {
  const { mant, exp } = decompose(x);
  let num = mant;
  let den = 1n;
  if (exp >= 0) num <<= BigInt(exp);
  else den <<= BigInt(-exp);
  if (d >= 0) num *= 10n ** BigInt(d);
  else den *= 10n ** BigInt(-d);
  const q = num / den;
  const twice = 2n * (num % den);
  if (twice > den || (twice === den && (q & 1n) === 1n)) return q + 1n;
  return q;
}

/** Python round(x, nd): half-even on the exact value. round(x) (nd=0) → int. */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const p = 10 ** nd;
  const y = x * p;
  if (Math.abs(y) < 1e9) {
    const fl = Math.floor(y);
    const frac = y - fl;
    // y carries < 1e-7 of float error here, so away from .5 the nearest
    // integer is unambiguous; only near-ties need the exact computation.
    if (Math.abs(frac - 0.5) > 1e-6) {
      const q = frac < 0.5 ? fl : fl + 1;
      return nd === 0 ? q + 0 : q / p;
    }
  }
  const q = Number(scaledHalfEven(x, nd));
  const v = nd === 0 ? q : q / p;
  return x < 0 ? -v : v;
}

/** Python format(x, ".{d}f"). */
export function pyFixed(x: number, d: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const q = (x === 0 ? 0n : scaledHalfEven(x, d)).toString().padStart(d + 1, "0");
  const s = d > 0 ? `${q.slice(0, q.length - d)}.${q.slice(q.length - d)}` : q;
  return (neg ? "-" : "") + s;
}

/** Python format(x, ".0f") with an explicit sign (f"{x:+.0f}"). */
export function pyFixedSigned(x: number, d: number): string {
  const s = pyFixed(x, d);
  return s.startsWith("-") ? s : `+${s}`;
}

/** Python format(x, "g") (precision 6 by default). */
export function pyFmtG(x: number, p = 6): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const neg = x < 0;
  const ax = Math.abs(x);
  const lim = 10n ** BigInt(p);
  let e = Math.floor(Math.log10(ax));
  let q = scaledHalfEven(ax, p - 1 - e);
  if (q >= lim) {
    e += 1;
    q = scaledHalfEven(ax, p - 1 - e);
  } else if (q < lim / 10n) {
    e -= 1;
    q = scaledHalfEven(ax, p - 1 - e);
    if (q >= lim) {
      e += 1;
      q = scaledHalfEven(ax, p - 1 - e);
    }
  }
  const digits = q.toString();
  let s: string;
  if (e < -4 || e >= p) {
    let m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    if (m.includes(".")) m = m.replace(/0+$/, "").replace(/\.$/, "");
    s = `${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  } else {
    const dec = p - 1 - e;
    const ds = digits.padStart(dec + 1, "0");
    s = dec > 0 ? `${ds.slice(0, ds.length - dec)}.${ds.slice(ds.length - dec)}` : ds;
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return (neg ? "-" : "") + s;
}

/** Python repr(float) / str(float): shortest round-trip, "12.0", "1e-05". */
export function pyRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const ax = Math.abs(x);
  if (ax >= 1e16 || ax < 1e-4) {
    return x.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  }
  const s = String(x);
  return Number.isInteger(x) ? `${s}.0` : s;
}

/** str() of a number that came through JSON: integral values were ints. */
export function pyStrJson(x: number): string {
  return Number.isInteger(x) ? String(x) : pyRepr(x);
}

/** str(v) for a value of unknown type (JSON-sourced). */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") return pyStrJson(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/** repr() of a list of plain strings: ['a', 'b']. */
export function pyListRepr(xs: string[]): string {
  return `[${xs.map((s) => `'${s}'`).join(", ")}]`;
}

/** Python a % b (result takes the divisor's sign). */
export function pyMod(a: number, b: number): number {
  const m = a % b;
  return m !== 0 && (m < 0) !== (b < 0) ? m + b : m;
}

/** Python float a // b (CPython float_floor_div). */
export function pyFloorDiv(a: number, b: number): number {
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0 && (b < 0) !== (mod < 0)) {
    mod += b;
    div -= 1.0;
  }
  if (div !== 0) {
    let f = Math.floor(div);
    if (div - f > 0.5) f += 1.0;
    return f;
  }
  return 0;
}

/** Python float(s) for an attribute/text value; null where Python raises. */
export function pyFloat(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  const t = s.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (m) {
    if (m[2].toLowerCase() === "nan") return NaN;
    return m[1] === "-" ? -Infinity : Infinity;
  }
  return null;
}

/** str.title() for ASCII identifiers. */
export function pyTitle(s: string): string {
  return s.toLowerCase().replace(/(^|[^a-zA-Z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/** Lexicographic compare of tuples of numbers/strings (Python tuple order). */
export function cmpTuple(a: (number | string)[], b: (number | string)[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

/** Stable sort by a key (ascending), like list.sort(key=...). */
export function sortBy<T>(xs: T[], key: (x: T) => (number | string)[] | number | string): T[] {
  const k = (x: T) => {
    const v = key(x);
    return Array.isArray(v) ? v : [v];
  };
  return xs.sort((a, b) => cmpTuple(k(a), k(b)));
}

/** Stable descending sort by key, like list.sort(key=..., reverse=True). */
export function sortByDesc<T>(xs: T[], key: (x: T) => (number | string)[] | number | string): T[] {
  const k = (x: T) => {
    const v = key(x);
    return Array.isArray(v) ? v : [v];
  };
  return xs.sort((a, b) => cmpTuple(k(b), k(a)));
}

/**
 * Python's built-in sum() (CPython ≥ 3.12): ints before the first float add
 * exactly, floats then use Neumaier compensated summation, later ints add
 * plainly. isInt says which items were Python ints (default: none — floats).
 * For lists of whole numbers the result equals plain addition.
 */
export function pySum(xs: ArrayLike<number>, isInt?: (i: number) => boolean): number {
  const n = xs.length;
  let i = 0;
  let ires = 0;
  for (; i < n && isInt?.(i); i++) ires += xs[i];
  if (i === n) return ires;
  let f = ires + xs[i++];
  let c = 0.0;
  for (; i < n; i++) {
    const x = xs[i];
    if (isInt?.(i)) {
      f += x;
      continue;
    }
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += f - t + x;
    else c += x - t + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

export const sum = (xs: ArrayLike<number>): number => pySum(xs);

/** Python max(seq, key=f): first maximal element. */
export function maxBy<T>(xs: Iterable<T>, f: (x: T) => number): T {
  let best: T | undefined;
  let bv = -Infinity;
  let first = true;
  for (const x of xs) {
    const v = f(x);
    if (first || v > bv) {
      best = x;
      bv = v;
      first = false;
    }
  }
  if (first) throw new Error("max() arg is an empty sequence");
  return best as T;
}
