// anote skill install / skill path. Every run gets a temp HOME and HERMES_HOME,
// and ANOTE_GRAPH points at a directory that must never be created.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assert } from "./helpers.ts";
import type { Run } from "./helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(ROOT, "src", "main.ts");
const BUNDLED = path.join(ROOT, "skills", "anote", "SKILL.md");
const VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;

let tmp = "";
let home = "";
let graph = "";

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "anote-skill-")));
  home = path.join(tmp, "home");
  graph = path.join(tmp, "graph");
  fs.mkdirSync(home);
});

afterEach(() => {
  assert.equal(fs.existsSync(graph), false, "skill commands must not create the graph");
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args: string[], opts: { hermesHome?: string; cwd?: string } = {}): Run {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, ANOTE_GRAPH: graph };
  delete env["HERMES_HOME"];
  if (opts.hermesHome !== undefined) env["HERMES_HOME"] = opts.hermesHome;
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, ...args], {
    env, cwd: opts.cwd ?? tmp, encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const bundled = (): Buffer => fs.readFileSync(BUNDLED);

function assertInstalled(file: string): void {
  assert.ok(fs.readFileSync(file).equals(bundled()), `${file} should match the bundled skill`);
}

describe("skill install: targets", () => {
  it("--agent hermes on an empty HOME creates ~/.hermes/skills/anote/SKILL.md", () => {
    const r = run(["skill", "install", "--agent", "hermes"]);
    const target = path.join(home, ".hermes", "skills", "anote", "SKILL.md");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, target + "\n");
    assertInstalled(target);
  });

  it("--agent hermes writes under HERMES_HOME when it is set", () => {
    const hermesHome = path.join(tmp, "hh");
    const r = run(["skill", "install", "--agent", "hermes"], { hermesHome });
    const target = path.join(hermesHome, "skills", "anote", "SKILL.md");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, target + "\n");
    assertInstalled(target);
    assert.equal(fs.existsSync(path.join(home, ".hermes")), false);
  });

  it("--agent claude on an empty HOME creates ~/.claude/skills/anote/SKILL.md", () => {
    const r = run(["skill", "install", "--agent", "claude"]);
    const target = path.join(home, ".claude", "skills", "anote", "SKILL.md");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, target + "\n");
    assertInstalled(target);
  });

  it("--dir with a relative path resolves against the current directory", () => {
    const cwd = path.join(tmp, "work");
    fs.mkdirSync(cwd);
    const r = run(["skill", "install", "--dir", "./x"], { cwd });
    const target = path.join(cwd, "x", "anote", "SKILL.md");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, target + "\n");
    assertInstalled(target);
  });

  it("--json reports created with path and version", () => {
    const r = run(["skill", "install", "--dir", "s", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), {
      action: "created", path: path.join(tmp, "s", "anote", "SKILL.md"), version: VERSION,
    });
  });
});

describe("skill install: never clobbers silently", () => {
  it("an identical file is left alone: unchanged, exit 0, mtime unchanged", () => {
    const target = path.join(tmp, "s", "anote", "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(BUNDLED, target);
    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(target, past, past);
    const r = run(["skill", "install", "--dir", "s"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `already up to date: ${target}\n`);
    assert.equal(fs.statSync(target).mtimeMs, past.getTime());
    const j = run(["skill", "install", "--dir", "s", "--json"]);
    assert.equal(JSON.parse(j.out).action, "unchanged");
  });

  it("a differing file is refused; --force overwrites only SKILL.md", () => {
    const folder = path.join(tmp, "s", "anote");
    const target = path.join(folder, "SKILL.md");
    const sibling = path.join(folder, "notes.txt");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(target, "my edited copy\n");
    fs.writeFileSync(sibling, "keep me\n");

    const r = run(["skill", "install", "--dir", "s"]);
    assert.equal(r.code, 1);
    assert.equal(r.out, "");
    assert.equal(
      r.err,
      `anote: ${target} exists and differs from the bundled skill (version ${VERSION}). Use --force to overwrite.\n`,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "my edited copy\n");

    const j = run(["skill", "install", "--dir", "s", "--json"]);
    assert.equal(j.code, 1);
    assert.equal(JSON.parse(j.out).action, "refused");

    const f = run(["skill", "install", "--dir", "s", "--force"]);
    assert.equal(f.code, 0, f.err);
    assert.equal(f.out, `overwrote ${target}\n`);
    assertInstalled(target);
    assert.equal(fs.readFileSync(sibling, "utf8"), "keep me\n");
    assert.deepEqual(fs.readdirSync(folder).sort(), ["SKILL.md", "notes.txt"]);
  });

  it("--force with --json reports overwrote", () => {
    const target = path.join(tmp, "s", "anote", "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "old\n");
    const r = run(["skill", "install", "--dir", "s", "--force", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { action: "overwrote", path: target, version: VERSION });
  });

  it("Hermes: another skill named anote anywhere under skills/ is refused, even with --force", () => {
    const hermesHome = path.join(tmp, "hh");
    const other = path.join(hermesHome, "skills", "note-taking", "anote", "SKILL.md");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "---\nname: anote\ndescription: a customised copy\n---\n\nmine\n");
    for (const extra of [[], ["--force"]]) {
      const r = run(["skill", "install", "--agent", "hermes", ...extra], { hermesHome });
      assert.equal(r.code, 1);
      assert.equal(r.out, "");
      assert.match(r.err, /another skill named anote is already installed at /);
      assert.ok(r.err.includes(other), r.err);
      assert.equal(fs.existsSync(path.join(hermesHome, "skills", "anote")), false);
    }
    assert.equal(fs.readFileSync(other, "utf8"), "---\nname: anote\ndescription: a customised copy\n---\n\nmine\n");
  });

  it("Hermes: a skill with another name in a folder called anote is not a duplicate", () => {
    const hermesHome = path.join(tmp, "hh");
    const other = path.join(hermesHome, "skills", "misc", "anote", "SKILL.md");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "---\nname: not-anote\n---\n");
    const r = run(["skill", "install", "--agent", "hermes"], { hermesHome });
    assert.equal(r.code, 0, r.err);
    assertInstalled(path.join(hermesHome, "skills", "anote", "SKILL.md"));
  });

  it("Claude: another top-level skill named anote is refused, even with --force", () => {
    const other = path.join(home, ".claude", "skills", "notes", "SKILL.md");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "---\nname: anote\n---\n");
    const r = run(["skill", "install", "--agent", "claude", "--force"]);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(other), r.err);
    assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "anote")), false);
  });

  it("Claude: a nested skill named anote is not checked (Claude reads the top level only)", () => {
    const nested = path.join(home, ".claude", "skills", "group", "anote", "SKILL.md");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "---\nname: anote\n---\n");
    const r = run(["skill", "install", "--agent", "claude"]);
    assert.equal(r.code, 0, r.err);
    assertInstalled(path.join(home, ".claude", "skills", "anote", "SKILL.md"));
  });

  it("a file where a directory is expected: exit 1 with the OS error, nothing left behind", () => {
    fs.writeFileSync(path.join(tmp, "blocker"), "");
    const r = run(["skill", "install", "--dir", "blocker"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /^anote: ENOTDIR: /);
    assert.equal(fs.readFileSync(path.join(tmp, "blocker"), "utf8"), "");
  });

  it("an unwritable target directory: exit 1 with the OS error, no temp file left", { skip: process.getuid?.() === 0 }, () => {
    const folder = path.join(tmp, "s", "anote");
    fs.mkdirSync(folder, { recursive: true });
    fs.chmodSync(folder, 0o555);
    try {
      const r = run(["skill", "install", "--dir", "s"]);
      assert.equal(r.code, 1);
      assert.match(r.err, /^anote: EACCES: /);
      assert.deepEqual(fs.readdirSync(folder), []);
    } finally {
      fs.chmodSync(folder, 0o755);
    }
  });
});

describe("skill install: usage", () => {
  it("--agent and --dir together is a usage error listing both agent targets", () => {
    const r = run(["skill", "install", "--agent", "hermes", "--dir", "s"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes(path.join(home, ".hermes", "skills", "anote", "SKILL.md")), r.err);
    assert.ok(r.err.includes(path.join(home, ".claude", "skills", "anote", "SKILL.md")), r.err);
    assert.equal(fs.existsSync(path.join(tmp, "s")), false);
  });

  it("neither --agent nor --dir is a usage error", () => {
    const r = run(["skill", "install"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /give exactly one of --agent or --dir/);
    assert.match(r.err, /--agent hermes/);
    assert.match(r.err, /--agent claude/);
  });

  it("an unknown --agent is a usage error", () => {
    const r = run(["skill", "install", "--agent", "cursor"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /invalid choice: 'cursor'/);
  });

  it("`anote skill` alone prints the skill help", () => {
    const r = run(["skill"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /^usage: anote skill /);
    assert.match(r.out, /install/);
    assert.match(r.out, /path/);
  });

  it("an unknown subcommand is a usage error", () => {
    const r = run(["skill", "remove"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /invalid choice: 'remove'/);
  });

  it("anote --help lists skill", () => {
    assert.match(run(["--help"]).out, /\n {4}skill {5}/);
  });

  it("--graph is ignored and never created", () => {
    const other = path.join(tmp, "other-graph");
    const r = run(["skill", "install", "--dir", "s", "--graph", other]);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(other), false);
  });
});

describe("skill path", () => {
  it("prints an existing path whose content equals the repo file", () => {
    const r = run(["skill", "path"]);
    assert.equal(r.code, 0, r.err);
    const printed = r.out.trimEnd();
    assert.ok(path.isAbsolute(printed));
    assert.ok(fs.readFileSync(printed).equals(bundled()));
  });

  it("--json gives path and version", () => {
    const r = run(["skill", "path", "--json"]);
    assert.deepEqual(JSON.parse(r.out), { path: BUNDLED, version: VERSION });
  });
});
