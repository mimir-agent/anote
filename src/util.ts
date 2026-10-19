// Small helpers shared by every module. Several of these exist only to match
// how the original Python version treated strings, dates and files.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------- failures

/** A user-facing failure. `code` is the process exit code (1, 2 or 3). */
export class Fail extends Error {
  code: number;
  constructor(code: number, msg: string) {
    super(msg);
    this.code = code;
  }
}

export function die(code: number, msg: string): never {
  throw new Fail(code, msg);
}

// ------------------------------------------------------------------ output

/** Print one line to stdout, like Python's print(). */
export function print(text: string): void {
  process.stdout.write(text + "\n");
}

export function printErr(text: string): void {
  process.stderr.write(text + "\n");
}

// ----------------------------------------------------------------- strings

// Python's str.split() / strip() treat these as whitespace (JS \s differs a little).
const WS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${WS}]+`, "u");
const WS_ENDS = new RegExp(`^[${WS}]+|[${WS}]+$`, "gu");

/** Python str.split() with no argument: split on whitespace runs, drop empties. */
export function words(s: string): string[] {
  return s.split(WS_RUN).filter((w) => w !== "");
}

/** Python str.strip() with no argument. */
export function strip(s: string): string {
  return s.replace(WS_ENDS, "");
}

/** Python s.strip("\n"). */
export function stripNewlines(s: string): string {
  return s.replace(/^\n+|\n+$/g, "");
}

/** Collapse all whitespace runs to single spaces and trim. */
export function clean(s: string): string {
  return words(s).join(" ");
}

export function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 70).replace(/^-+|-+$/g, "");
}

/** Length in code points (Python len), not UTF-16 units. */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Left-justify to `width` code points (Python "%-Ns"). */
export function padEnd(s: string, width: number): string {
  const n = cpLen(s);
  return n >= width ? s : s + " ".repeat(width - n);
}

/** Python str.splitlines(): splits on more characters than just \n. */
export function splitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Plain code point string compare, so sorting matches Python's sorted(). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Own-property lookup that is safe for keys like "constructor". */
export function lookup<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// ------------------------------------------------------------------- dates

const DAY_MS = 86_400_000;

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

/** Parse strict YYYY-MM-DD (what Python's date.fromisoformat accepts). */
export function parseDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.getTime();
}

export function isoDate(ms: number): string {
  const t = new Date(ms);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1, 2)}-${pad(t.getUTCDate(), 2)}`;
}

/** Today as epoch ms at UTC midnight. $ANOTE_TODAY overrides (used by tests). */
export function today(): number {
  const env = process.env["ANOTE_TODAY"];
  if (env) {
    const t = parseDate(env);
    if (t === null) throw new Error(`Invalid isoformat string: '${env}'`);
    return t;
  }
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}

export function addDays(ms: number, days: number): number {
  return ms + days * DAY_MS;
}

/** Whole days from `from` to `to`. */
export function daysBetween(to: number, from: number): number {
  return Math.round((to - from) / DAY_MS);
}

export function nowHHMM(): string {
  const n = new Date();
  return `${pad(n.getHours(), 2)}:${pad(n.getMinutes(), 2)}`;
}

// ------------------------------------------------------------------- files

/** Python Path.read_text(): utf-8, with \r\n and \r turned into \n. */
export function readText(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}

/** Write via a temp file in the same directory, then rename (atomic). */
export function writeText(file: string, text: string | Uint8Array): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw e;
  }
}

/** Read all of stdin ("" if there is none). */
export function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Expand a leading ~ and tidy slashes the way Python's Path(raw).expanduser() prints. */
export function expandPath(raw: string): string {
  let p = raw;
  if (p === "~" || p.startsWith("~/")) p = os.homedir() + p.slice(1);
  const abs = p.startsWith("/");
  const parts = p.split("/").filter((x) => x !== "" && x !== ".");
  const joined = parts.join("/");
  return abs ? "/" + joined : joined || ".";
}
