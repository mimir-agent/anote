// skill install and skill path: copy the bundled agent skill into a skills
// directory. These never touch the graph.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { HELP } from "../helptext.ts";
import { die, expandPath, print, printErr, writeText } from "../util.ts";
import { emit } from "./types.ts";

// This file is src/commands/skill.ts from source and dist/commands/skill.js
// when installed; the package root is two levels up in both cases.
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BUNDLED = path.join(ROOT, "skills", "anote", "SKILL.md");

export const AGENTS = ["hermes", "claude"] as const;
type Agent = (typeof AGENTS)[number];

function version(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

/** The skills directory an agent reads. */
function agentSkillsDir(agent: Agent): string {
  if (agent === "claude") return path.join(os.homedir(), ".claude", "skills");
  const home = process.env["HERMES_HOME"];
  return path.join(home ? path.resolve(expandPath(home)) : path.join(os.homedir(), ".hermes"), "skills");
}

/** The frontmatter `name:` of a skill file, or undefined when it has none. */
function skillName(file: string): string | undefined {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  for (const line of lines.slice(1)) {
    if (line === "---") return undefined;
    const m = /^name:\s*(.*?)\s*$/.exec(line);
    if (m) return (m[1] as string).replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

/**
 * Another SKILL.md named anote in the agent's skills dir, other than the target.
 * Hermes loads skills from any depth, so its whole tree is searched; Claude Code
 * reads only <skills>/<name>/SKILL.md.
 */
function findDuplicate(agent: Agent, skillsDir: string, target: string): string | undefined {
  if (!fs.existsSync(skillsDir)) return undefined;
  const candidates =
    agent === "hermes"
      ? (fs.readdirSync(skillsDir, { recursive: true }) as string[])
          .filter((rel) => path.basename(rel) === "SKILL.md")
          .map((rel) => path.join(skillsDir, rel))
      : fs.readdirSync(skillsDir).map((d) => path.join(skillsDir, d, "SKILL.md"));
  return candidates
    .sort()
    .find((f) => f !== target && fs.existsSync(f) && fs.statSync(f).isFile() && skillName(f) === "anote");
}

function usageError(msg: string): number {
  printErr((HELP["skill install"] as string).split("\n\n")[0] as string);
  printErr(`anote skill install: error: ${msg}`);
  return 2;
}

function targetsHelp(): string {
  return AGENTS.map((a) => `  --agent ${a.padEnd(6)}  ${path.join(agentSkillsDir(a), "anote", "SKILL.md")}`).join("\n");
}

/** Errors from the filesystem (ENOTDIR, EACCES, ...) are runtime failures, exit 1. */
function fsFail(e: unknown): never {
  const err = e as NodeJS.ErrnoException;
  if (typeof err.code === "string" && typeof err.syscall === "string") die(1, err.message);
  throw e;
}

export function cmdSkillPath(a: Args): void {
  emit(a, { path: BUNDLED, version: version() }, BUNDLED);
}

export function cmdSkillInstall(a: Args): number {
  const agent = a.str("agent") as Agent | undefined;
  const dir = a.str("dir");
  if ((agent === undefined) === (dir === undefined)) {
    return usageError(`give exactly one of --agent or --dir. Agent targets:\n${targetsHelp()}`);
  }
  const skillsDir = agent ? agentSkillsDir(agent) : path.resolve(expandPath(dir as string));
  const target = path.join(skillsDir, "anote", "SKILL.md");
  const ver = version();
  const bundled = fs.readFileSync(BUNDLED);
  const report = (action: string, text: string, extra: Record<string, string> = {}): void =>
    emit(a, { action, path: target, version: ver, ...extra }, text);
  const refuse = (msg: string, extra: Record<string, string> = {}): number => {
    if (a.flag("json")) report("refused", "", extra);
    printErr("anote: " + msg);
    return 1;
  };

  try {
    const dup = agent ? findDuplicate(agent, skillsDir, target) : undefined;
    if (dup) {
      return refuse(
        `another skill named anote is already installed at ${dup}; remove or rename it, or use --dir. Nothing written to ${target}.`,
        { duplicate: dup },
      );
    }
    const exists = fs.existsSync(target);
    if (exists) {
      if (fs.readFileSync(target).equals(bundled)) {
        report("unchanged", `already up to date: ${target}`);
        return 0;
      }
      if (!a.flag("force")) {
        return refuse(`${target} exists and differs from the bundled skill (version ${ver}). Use --force to overwrite.`);
      }
    }
    writeText(target, bundled);
    report(exists ? "overwrote" : "created", exists ? `overwrote ${target}` : target);
    return 0;
  } catch (e) {
    return fsFail(e);
  }
}
