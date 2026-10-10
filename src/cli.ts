// Entry point: pick the command, parse its arguments, run it, map failures to exit codes.
//
// Exit codes: 0 ok, 1 runtime error or failed check, 2 usage error,
// 3 note not found or ambiguous.
import { HelpExit, UsageError, parseCommand } from "./args.ts";
import type { OptSpec, PosSpec, Spec } from "./args.ts";
import { HELP, MAIN_HELP, MAIN_USAGE } from "./helptext.ts";
import { MEDIA, NOTE_TYPES, SOURCES, STANCES } from "./schema.ts";
import { cmdInit, cmdTypes } from "./commands/admin.ts";
import { cmdCheck } from "./commands/check.ts";
import { cmdAdd, cmdLog, cmdPromote } from "./commands/create.ts";
import { cmdAppend, cmdConfirm, cmdSet, cmdStale, cmdSupersede } from "./commands/edit.ts";
import { cmdList, cmdSearch } from "./commands/find.ts";
import { cmdLink, cmdNeighbors, cmdUnlink } from "./commands/links.ts";
import { cmdShow } from "./commands/show.ts";
import type { CommandFn } from "./commands/types.ts";
import { Fail, printErr, print } from "./util.ts";

const pos = (name: string, more: Partial<PosSpec> = {}): PosSpec => ({ name, ...more });
const val = (flag: string, more: Partial<OptSpec> = {}): OptSpec => ({ flag, kind: "value", ...more });
const flag = (f: string): OptSpec => ({ flag: f, kind: "flag" });
const many = (f: string): OptSpec => ({ flag: f, kind: "append" });

// Options shared by `add` and `promote`, in the order the original declared them.
const noteArgs = (): Spec => [
  val("--type", { required: true, choices: Object.keys(NOTE_TYPES).sort() }),
  val("--media", { choices: MEDIA }),
  val("--form"),
  val("--stance", { choices: STANCES }),
  flag("--person-ok"),
];

interface Command {
  run: CommandFn;
  spec: Spec;
}

const COMMANDS: Record<string, Command> = {
  init: { run: cmdInit, spec: [] },
  types: { run: cmdTypes, spec: [] },
  add: {
    run: cmdAdd,
    spec: [
      pos("title"),
      ...noteArgs(),
      val("--source", { required: true, choices: SOURCES }),
      val("--body"), val("--version"), val("--review"), many("--tag"), many("--link"), val("--slug"),
    ],
  },
  log: {
    run: cmdLog,
    spec: [pos("text", { plus: true }), val("--source", { choices: SOURCES, default: "observed" })],
  },
  promote: {
    run: cmdPromote,
    spec: [
      pos("date"), pos("line", { int: true }), pos("title"),
      ...noteArgs(),
      val("--source", { choices: SOURCES }),
      val("--version"), val("--review"), many("--tag"), many("--link"), val("--slug"),
    ],
  },
  link: { run: cmdLink, spec: [pos("src"), pos("type"), pos("dst"), val("--note")] },
  unlink: { run: cmdUnlink, spec: [pos("src"), pos("dst"), val("--type")] },
  show: { run: cmdShow, spec: [pos("note")] },
  search: {
    run: cmdSearch,
    spec: [
      pos("query", { plus: true }),
      val("--limit", { int: true, default: 10 }),
      val("--budget", { int: true, default: 0 }),
      flag("--all"),
      val("--type"),
    ],
  },
  list: {
    run: cmdList,
    spec: [
      val("--tag"), val("--type"),
      val("--status", { choices: ["active", "superseded", "all"], default: "active" }),
      val("--limit", { int: true, default: 0 }),
    ],
  },
  neighbors: {
    run: cmdNeighbors,
    spec: [pos("note"), val("--depth", { int: true, default: 1 }), val("--type")],
  },
  stale: { run: cmdStale, spec: [val("--within", { default: "0d" })] },
  confirm: { run: cmdConfirm, spec: [pos("note"), val("--review"), val("--version")] },
  set: { run: cmdSet, spec: [pos("note"), pos("key"), pos("value")] },
  append: { run: cmdAppend, spec: [pos("note"), pos("text", { plus: true })] },
  supersede: { run: cmdSupersede, spec: [pos("old"), pos("new")] },
  check: { run: cmdCheck, spec: [] },
};

function mainUsageError(msg: string): number {
  printErr(MAIN_USAGE);
  printErr(`anote: error: ${msg}`);
  return 2;
}

export function main(argv: string[]): number {
  // Only the top-level options and the command word are handled here. Like
  // argparse, unknown options before the command are set aside and reported
  // at the end (as "unrecognized arguments") once the command has parsed.
  const pre: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const t = argv[i] as string;
    if (t === "-h" || t === "--help") {
      print(MAIN_HELP);
      return 0;
    }
    if (t.startsWith("-") && t !== "-" && t !== "--") pre.push(t);
    else break;
  }
  const first = argv[i];
  if (first === undefined) return mainUsageError("the following arguments are required: command");
  const names = Object.keys(COMMANDS);
  const cmd = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  if (!cmd) {
    return mainUsageError(`argument command: invalid choice: '${first}' (choose from ${names.map((n) => `'${n}'`).join(", ")})`);
  }
  try {
    const args = parseCommand(`anote ${first}`, HELP[first] as string, MAIN_USAGE, cmd.spec, argv.slice(i + 1), pre);
    args.command = first;
    return cmd.run(args) || 0;
  } catch (e) {
    if (e instanceof HelpExit) return 0;
    if (e instanceof UsageError) return 2;
    if (e instanceof Fail) {
      printErr("anote: " + e.message);
      return e.code;
    }
    if ((e as NodeJS.ErrnoException).code === "EPIPE") return 0;
    throw e;
  }
}
