// hook claude and hook codex: print, or add to an agent's settings or hooks
// file, a SessionStart hook that runs `anote brief`. Only checks that the graph
// exists; never reads, creates or locks it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { MIN_BUDGET } from "./brief.ts";
import { graphDir } from "../store.ts";
import { die, expandPath, printErr } from "../util.ts";
import { emit } from "./types.ts";

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

/** What differs between the agents a hook is written for. */
interface Agent {
  /** The subcommand: `anote hook NAME`. */
  name: string;
  /** The largest --budget whose brief the agent shows whole. */
  maxBudget: number;
  /** The file used when --settings is not given. */
  defaultFile: () => string;
  /** A last line after the hook is printed or written (stderr with --json); not after "unchanged". */
  notice?: string;
  /**
   * Refuse a settings path that is a symlink, before reading it. A cloned repo's hooks file could
   * link to a credential file, which --write would rewrite and copy into the repo as the backup.
   */
  refuseSymlink?: boolean;
}

// Claude Code adds at most 10,000 characters of hook output to the context.
const CLAUDE: Agent = {
  name: "claude",
  maxBudget: 10_000,
  defaultFile: () => path.join(os.homedir(), ".claude", "settings.json"),
};

// Codex spills hook output over about 2,500 tokens to a file and shows the model only a preview;
// 8,000 characters keeps brief whole at about 4 characters per token. Codex keeps the user's hooks
// file in CODEX_HOME when that is set.
const CODEX: Agent = {
  name: "codex",
  maxBudget: 8_000,
  defaultFile: () => {
    const home = process.env["CODEX_HOME"];
    return path.join(home ? path.resolve(expandPath(home)) : path.join(os.homedir(), ".codex"), "hooks.json");
  },
  notice:
    "Codex runs this hook only after you trust it: open /hooks in Codex and approve it. Project hooks also need the project's .codex folder to be trusted.",
  refuseSymlink: true,
};

export const cmdHookClaude = (a: Args): number => hook(a, CLAUDE);
export const cmdHookCodex = (a: Args): number => hook(a, CODEX);

function hook(a: Args, agent: Agent): number {
  const budget = a.num("budget");
  if (budget < MIN_BUDGET || budget > agent.maxBudget) {
    die(2, `--budget must be between ${MIN_BUDGET} and ${agent.maxBudget} characters, got ${budget}`);
  }
  const graph = path.resolve(graphDir(a.str("graph")));
  const command = `${shellQuote(ANOTE)} brief --budget ${budget} --graph ${shellQuote(graph)}`;
  if (!fs.statSync(graph, { throwIfNoEntry: false })?.isDirectory()) {
    printErr(`warning: no graph at ${graph} yet; the hook will report an error until you run anote init`);
  }
  const raw = a.str("settings");
  const settings = raw === undefined ? agent.defaultFile() : path.resolve(expandPath(raw));
  const backup = settings + ".anote-backup";
  const handler: Obj = { type: "command", command };
  const block: Obj = { hooks: { SessionStart: [{ hooks: [handler] }] } };
  const report = (action: string, text: string, withBackup = false): void => {
    const notice = action === "unchanged" || action === "refused" ? undefined : agent.notice;
    emit(a, { action, settings, command, ...(withBackup ? { backup } : {}) }, notice === undefined ? text : `${text}\n${notice}`);
    if (notice !== undefined && a.flag("json")) printErr(notice);
  };
  const refuse = (msg: string): number => {
    if (a.flag("json")) report("refused", "");
    printErr(`anote: ${msg}`);
    return 1;
  };

  if (!a.flag("write")) {
    report("printed", `${JSON.stringify(block, null, 2)}\nThis goes in ${settings}; run \`anote hook ${agent.name} --write\` to add it there.`);
    return 0;
  }

  try {
    if (agent.refuseSymlink && fs.lstatSync(settings, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return refuse(`${settings} is a symlink; pass the file it points to with --settings. Nothing written to ${settings}.`);
    }
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
        `${settings} is not valid JSON (${(e as Error).message}). A file with comments or trailing commas (JSONC) counts as not valid here; add the hook by hand (see \`anote hook ${agent.name}\`). ${untouched}`,
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
