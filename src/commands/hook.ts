// hook claude: print, or add to a Claude Code settings file, a SessionStart
// hook that runs `anote brief`. Only checks that the graph exists; never reads,
// creates or locks it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { MIN_BUDGET } from "./brief.ts";
import { graphDir } from "../store.ts";
import { die, expandPath, printErr } from "../util.ts";
import { emit } from "./types.ts";

// Claude Code adds at most this many characters of hook output to the context.
const MAX_BUDGET = 10_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObj = (x: Json | undefined): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** Single-quote for a POSIX shell: ' becomes '\''. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// This file is src/commands/hook.ts from source and dist/commands/hook.js when installed; the package
// root is two levels up in both. From source the repo's launcher runs anote; installed, the package bin.
// The hook names it by path because Claude Code's hook shell may not have anote on its PATH.
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ANOTE = path.join(ROOT, import.meta.filename.endsWith(".ts") ? "anote" : path.join("bin", "anote.js"));

/**
 * A handler that runs anote brief, whatever its flags: through a quoted path to anote, or the bare
 * word anote that hooks written before the path was fixed in use.
 */
function isBrief(h: Json): h is Obj & { command: string } {
  return isObj(h) && typeof h["command"] === "string" && /^(anote|'(?:[^']|'\\'')*\/anote(\.js)?') brief(\s|$)/.test(h["command"]);
}

/** Errors from the filesystem (ENOTDIR, EACCES, ...) are runtime failures, exit 1. */
function fsFail(e: unknown): never {
  const err = e as NodeJS.ErrnoException;
  if (typeof err.code === "string" && typeof err.syscall === "string") die(1, err.message);
  throw e;
}

/** Read the file, or undefined when it does not exist. */
function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fsFail(e);
  }
}

/**
 * Write through a temp file and rename. A symlinked file is written at its target, keeping its mode.
 * The temp file is created exclusively, so anything already at its path (a link included) fails with EEXIST
 * and is left alone.
 */
function writeAtomic(file: string, text: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    try {
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function cmdHookClaude(a: Args): number {
  const budget = a.num("budget");
  if (budget < MIN_BUDGET || budget > MAX_BUDGET) {
    die(2, `--budget must be between ${MIN_BUDGET} and ${MAX_BUDGET} characters, got ${budget}`);
  }
  const graph = path.resolve(graphDir(a.str("graph")));
  const command = `${shellQuote(ANOTE)} brief --budget ${budget} --graph ${shellQuote(graph)}`;
  if (!fs.statSync(graph, { throwIfNoEntry: false })?.isDirectory()) {
    printErr(`warning: no graph at ${graph} yet; the hook will report an error until you run anote init`);
  }
  const raw = a.str("settings");
  const settings = raw === undefined ? path.join(os.homedir(), ".claude", "settings.json") : path.resolve(expandPath(raw));
  const backup = settings + ".anote-backup";
  const handler: Obj = { type: "command", command };
  const block: Obj = { hooks: { SessionStart: [{ hooks: [handler] }] } };
  const report = (action: string, text: string, withBackup = false): void =>
    emit(a, { action, settings, command, ...(withBackup ? { backup } : {}) }, text);
  const refuse = (msg: string): number => {
    if (a.flag("json")) report("refused", "");
    printErr(`anote: ${msg}`);
    return 1;
  };

  if (!a.flag("write")) {
    report("printed", `${JSON.stringify(block, null, 2)}\nThis goes in ${settings}; run \`anote hook claude --write\` to add it there.`);
    return 0;
  }

  try {
    const text = readIfExists(settings);
    if (text === undefined) {
      writeAtomic(settings, JSON.stringify(block, null, 2) + "\n", 0o644);
      report("created", `created ${settings}`);
      return 0;
    }
    const untouched = `Nothing written to ${settings}.`;
    let data: Json;
    try {
      data = JSON.parse(text) as Json;
    } catch (e) {
      return refuse(
        `${settings} is not valid JSON (${(e as Error).message}). A file with comments or trailing commas (JSONC) counts as not valid here; add the hook by hand (see \`anote hook claude\`). ${untouched}`,
      );
    }
    if (!isObj(data)) return refuse(`${settings} is not a JSON object. ${untouched}`);
    const hooks = data["hooks"] ?? {};
    if (!isObj(hooks)) return refuse(`"hooks" is not an object in ${settings}. ${untouched}`);
    const start = hooks["SessionStart"] ?? [];
    if (!Array.isArray(start)) return refuse(`"hooks.SessionStart" is not an array in ${settings}. ${untouched}`);
    const found: Array<Obj & { command: string }> = [];
    for (const [i, entry] of start.entries()) {
      if (!isObj(entry) || !Array.isArray(entry["hooks"])) {
        return refuse(`"hooks.SessionStart[${i}]" is not an object with a "hooks" array in ${settings}. ${untouched}`);
      }
      found.push(...entry["hooks"].filter(isBrief));
    }
    if (found.length > 1) {
      return refuse(
        `${settings} has ${found.length} anote brief hooks under SessionStart; remove all but one by hand, then run this again. ${untouched}`,
      );
    }
    const existing = found[0];
    if (existing?.command === command) {
      report("unchanged", `unchanged: ${settings} already has this hook`);
      return 0;
    }
    if (existing && !a.flag("force")) {
      return refuse(
        `${settings} already has a different anote brief hook.\n  installed: ${existing.command}\n  this run:  ${command}\nUse --force to replace it. ${untouched}`,
      );
    }
    if (existing) existing["command"] = command;
    else {
      start.push({ hooks: [handler] });
      hooks["SessionStart"] = start;
      data["hooks"] = hooks;
    }
    // The backup path may sit in a cloned repo, so never write through whatever is there: refuse
    // anything but a regular file, remove an old backup, and create the new one exclusively.
    const old = fs.lstatSync(backup, { throwIfNoEntry: false });
    if (old && !old.isFile()) {
      return refuse(`${backup} is not a regular file (a symlink or folder, for example); remove it and run this again. ${untouched}`);
    }
    const target = fs.realpathSync(settings);
    if (old) fs.unlinkSync(backup);
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    writeAtomic(target, JSON.stringify(data, null, 2) + "\n", fs.statSync(target).mode & 0o7777);
    const action = existing ? "replaced" : "added";
    report(action, `${existing ? "replaced the anote brief hook in" : "added the hook to"} ${settings}\nbackup: ${backup}`, true);
    return 0;
  } catch (e) {
    return fsFail(e);
  }
}
