// A small command-line parser that behaves like the Python argparse the
// original used: same error messages, same exit code 2, same quirks
// (unique prefixes of long options work, --opt=value works, positionals can be
// mixed with options). Only the features anote uses are implemented.
import { printErr, print } from "./util.ts";

export interface OptSpec {
  /** Long flag, e.g. "--type". */
  flag: string;
  kind: "value" | "flag" | "append";
  choices?: readonly string[];
  int?: boolean;
  required?: boolean;
  default?: string | number | boolean;
}

export interface PosSpec {
  name: string;
  /** One or more values (argparse nargs="+"). Otherwise exactly one. */
  plus?: boolean;
  int?: boolean;
}

/** Positionals and options in the order they are declared (used for "required" errors). */
export type Spec = Array<OptSpec | PosSpec>;

type Value = string | number | boolean | string[] | undefined;

export class Args {
  values = new Map<string, Value>();
  command = "";
  private v(name: string): Value {
    return this.values.get(name);
  }
  /** Optional string (undefined when not given). */
  str(name: string): string | undefined {
    const x = this.v(name);
    return typeof x === "string" ? x : undefined;
  }
  /** Required string (positionals and options with defaults). */
  need(name: string): string {
    const x = this.str(name);
    if (x === undefined) throw new Error(`internal: missing ${name}`);
    return x;
  }
  num(name: string): number {
    const x = this.v(name);
    if (typeof x !== "number") throw new Error(`internal: missing ${name}`);
    return x;
  }
  flag(name: string): boolean {
    return this.v(name) === true;
  }
  list(name: string): string[] {
    const x = this.v(name);
    return Array.isArray(x) ? x : [];
  }
}

/** Thrown after a usage error was printed (exit 2). */
export class UsageError extends Error {}

/** Thrown after --help text was printed (exit 0). */
export class HelpExit extends Error {}

const isOpt = (s: OptSpec | PosSpec): s is OptSpec => "flag" in s;
const quote = (s: string) => `'${s}'`;
const NEG_NUMBER = /^-\d+$|^-\d*\.\d+$/;
const PY_INT = /^\s*[+-]?\d+(_\d+)*\s*$/;

/** Fixed options every command accepts. */
const COMMON: OptSpec[] = [
  { flag: "--graph", kind: "value" },
  { flag: "--json", kind: "flag" },
];

function dest(flag: string): string {
  return flag.slice(2).replace(/-/g, "_");
}

function label(s: OptSpec | PosSpec): string {
  return isOpt(s) ? s.flag : s.name;
}

/**
 * Parse `argv` (after the command word) against `spec`. `help` is the full
 * help text for this command; its usage is everything before the first blank
 * line. `fail` is called for usage errors.
 */
export function parseCommand(
  prog: string,
  help: string,
  mainUsage: string,
  spec: Spec,
  argv: string[],
): Args {
  const usage = help.split("\n\n")[0] as string;
  const err = (msg: string): never => {
    printErr(usage);
    printErr(`${prog}: error: ${msg}`);
    throw new UsageError(msg);
  };
  const all: Array<OptSpec | PosSpec> = [...COMMON, ...spec];
  const opts = all.filter(isOpt);
  const positionals = all.filter((s): s is PosSpec => !isOpt(s));
  const flags = ["-h", "--help", ...opts.map((o) => o.flag)];
  const out = new Args();
  for (const s of all) {
    if (isOpt(s)) {
      if (s.kind === "flag") out.values.set(dest(s.flag), s.default ?? false);
      else if (s.default !== undefined) out.values.set(dest(s.flag), s.default);
    }
  }

  // Classify each argument as an option (O) or a plain value (A).
  type Tok = { text: string; opt?: OptSpec | "help"; explicit?: string; unknown?: boolean; isOpt: boolean };
  const toks: Tok[] = [];
  let dashes = false;
  for (const text of argv) {
    if (dashes) {
      toks.push({ text, isOpt: false });
      continue;
    }
    if (text === "--") {
      dashes = true;
      continue;
    }
    toks.push(classify(text));
  }

  function classify(text: string): Tok {
    const plain: Tok = { text, isOpt: false };
    if (text === "" || !text.startsWith("-") || text === "-") return plain;
    const lookup = (f: string): OptSpec | "help" | undefined =>
      f === "-h" || f === "--help" ? "help" : opts.find((o) => o.flag === f);
    const exact = lookup(text);
    if (exact) return { text, opt: exact, isOpt: true };
    let name = text;
    let explicit: string | undefined;
    if (text.includes("=")) {
      const i = text.indexOf("=");
      name = text.slice(0, i);
      explicit = text.slice(i + 1);
      const hit = lookup(name);
      if (hit) return { text, opt: hit, explicit, isOpt: true };
    }
    if (text.startsWith("--")) {
      const matches = flags.filter((f) => f.startsWith(name));
      if (matches.length > 1) err(`ambiguous option: ${text} could match ${matches.join(", ")}`);
      if (matches.length === 1) {
        const hit = lookup(matches[0] as string);
        if (hit) return { text, opt: hit, explicit, isOpt: true };
      }
    }
    if (NEG_NUMBER.test(text) || text.includes(" ")) return plain;
    return { text, unknown: true, isOpt: true };
  }

  const convert = (s: OptSpec | PosSpec, raw: string): string | number => {
    if (isOpt(s) && s.choices && !s.choices.includes(raw)) {
      err(`argument ${s.flag}: invalid choice: ${quote(raw)} (choose from ${s.choices.map(quote).join(", ")})`);
    }
    if (s.int) {
      if (!PY_INT.test(raw)) err(`argument ${label(s)}: invalid int value: ${quote(raw)}`);
      return parseInt(raw.replace(/_/g, ""), 10);
    }
    return raw;
  };

  const seen = new Set<string>();
  const extras: string[] = [];
  let pi = 0; // next positional to fill
  let i = 0;
  while (i < toks.length) {
    const t = toks[i] as Tok;
    if (!t.isOpt) {
      // A run of plain values: hand them to as many positionals as fit.
      let end = i;
      while (end < toks.length && !(toks[end] as Tok).isOpt) end++;
      const run = toks.slice(i, end).map((x) => x.text);
      let took = 0;
      for (let k = positionals.length - pi; k >= 1 && took === 0; k--) {
        const group = positionals.slice(pi, pi + k);
        const need = group.length; // each takes at least one
        if (need > run.length) continue;
        let at = 0;
        for (const p of group) {
          const n = p.plus ? run.length - at - (group.length - group.indexOf(p) - 1) : 1;
          const vals = run.slice(at, at + n).map((r) => convert(p, r));
          at += n;
          seen.add(p.name);
          out.values.set(p.name, p.plus ? vals.map(String) : vals[0]);
        }
        took = at;
        pi += k;
      }
      extras.push(...run.slice(took));
      i = end;
      continue;
    }
    i++;
    if (t.unknown) {
      extras.push(t.text);
      continue;
    }
    if (t.opt === "help") {
      print(help);
      throw new HelpExit("help");
    }
    const o = t.opt as OptSpec;
    const key = dest(o.flag);
    seen.add(o.flag);
    if (o.kind === "flag") {
      if (t.explicit !== undefined) err(`argument ${o.flag}: ignored explicit argument ${quote(t.explicit)}`);
      out.values.set(key, true);
      continue;
    }
    let raw = t.explicit;
    if (raw === undefined) {
      const next = toks[i];
      if (!next || next.isOpt) err(`argument ${o.flag}: expected one argument`);
      raw = (next as Tok).text;
      i++;
    }
    const val = convert(o, raw);
    if (o.kind === "append") out.values.set(key, [...out.list(key), String(val)]);
    else out.values.set(key, val);
  }

  // argparse reports missing positionals first, then missing required options.
  const missing = [
    ...positionals.filter((p) => !seen.has(p.name)),
    ...opts.filter((o) => o.required && !seen.has(o.flag)),
  ].map(label);
  if (missing.length > 0) err(`the following arguments are required: ${missing.join(", ")}`);
  if (extras.length > 0) {
    printErr(mainUsage);
    printErr(`anote: error: unrecognized arguments: ${extras.join(" ")}`);
    throw new UsageError("unrecognized");
  }
  return out;
}
