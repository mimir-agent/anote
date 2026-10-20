// Entry point: pick the command, parse its arguments, run it, map failures to exit codes.
//
// Exit codes: 0 ok, 1 runtime error or failed check, 2 usage error,
// 3 note not found or ambiguous.
import { HelpExit, UsageError, parseCommand } from "./args.ts";
import type { OptSpec, PosSpec, Spec } from "./args.ts";
import { HELP, MAIN_HELP, MAIN_USAGE } from "./helptext.ts";
import { MEDIA, NOTE_TYPES, SOURCES, STANCES } from "./schema.ts";
import { cmdInit, cmdTypes } from "./commands/admin.ts";
import { cmdBrief } from "./commands/brief.ts";
import { cmdCheck } from "./commands/check.ts";
import { cmdAdd, cmdLog, cmdPromote } from "./commands/create.ts";
import { cmdAppend, cmdConfirm, cmdSet, cmdStale, cmdSupersede } from "./commands/edit.ts";
import { cmdList, cmdSearch } from "./commands/find.ts";
import { cmdLink, cmdNeighbors, cmdUnlink } from "./commands/links.ts";
import { cmdPublishMark, cmdPublishPreview, cmdPublishUnmark } from "./commands/publish.ts";
import { REFUSED, cmdPublishSend } from "./commands/send.ts";
import { CAP } from "./send.ts";
import { cmdShow } from "./commands/show.ts";
import { AGENTS, cmdSkillInstall, cmdSkillPath } from "./commands/skill.ts";
import type { CommandFn } from "./commands/types.ts";
import { graphDir, withGraphLock } from "./store.ts";
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

// Commands that change the graph. Each runs its whole load-modify-save under the graph lock.
const WRITERS = new Set([
  "add", "log", "promote", "link", "unlink", "confirm", "set", "append", "supersede", "publish mark", "publish unmark",
]);

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
      val("--url"),
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
  brief: { run: cmdBrief, spec: [val("--budget", { int: true, default: 2000 })] },
};

// Commands with subcommands. `skill install` and `skill path` never touch the
// graph. `publish mark` and `publish unmark` write one note; `publish preview`
// only reads; `publish send` reads the graph and makes GET requests only.
const GROUPS: Record<string, Record<string, Command>> = {
  skill: {
    install: { run: cmdSkillInstall, spec: [val("--agent", { choices: AGENTS }), val("--dir"), flag("--force")] },
    path: { run: cmdSkillPath, spec: [] },
  },
  publish: {
    mark: { run: cmdPublishMark, spec: [pos("note")] },
    unmark: { run: cmdPublishUnmark, spec: [pos("note")] },
    preview: { run: cmdPublishPreview, spec: [] },
    send: {
      run: cmdPublishSend,
      spec: [
        val("--max", { int: true, default: CAP }), flag("--write"),
        ...REFUSED.map((f) => (f === "--delete" ? flag(f) : val(f))),
      ],
    },
  },
};

function mainUsageError(msg: string): number {
  printErr(MAIN_USAGE);
  printErr(`anote: error: ${msg}`);
  return 2;
}

export async function main(argv: string[]): Promise<number> {
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
  const names = [...Object.keys(COMMANDS), ...Object.keys(GROUPS)];
  let name = first;
  let rest = argv.slice(i + 1);
  let cmd = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  const group = Object.hasOwn(GROUPS, first) ? GROUPS[first] : undefined;
  if (group) {
    const sub = rest[0];
    if (sub === undefined || sub === "-h" || sub === "--help") {
      print(HELP[first] as string);
      return 0;
    }
    cmd = Object.hasOwn(group, sub) ? group[sub] : undefined;
    if (!cmd) {
      printErr((HELP[first] as string).split("\n\n")[0] as string);
      printErr(`anote ${first}: error: invalid choice: '${sub}' (choose from ${Object.keys(group).map((n) => `'${n}'`).join(", ")})`);
      return 2;
    }
    name = `${first} ${sub}`;
    rest = rest.slice(1);
  }
  if (!cmd) {
    return mainUsageError(`argument command: invalid choice: '${first}' (choose from ${names.map((n) => `'${n}'`).join(", ")})`);
  }
  try {
    const args = parseCommand(`anote ${name}`, HELP[name] as string, MAIN_USAGE, cmd.spec, rest, pre);
    args.command = name;
    const run = cmd.run;
    const out = WRITERS.has(name) ? withGraphLock(graphDir(args.str("graph")), () => run(args)) : run(args);
    return (await out) || 0;
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
