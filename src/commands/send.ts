// publish send. Without --write, the dry run: checks the graph and the
// account, reads the account's own records, and prints what a send would
// create, update or leave unchanged, with the confirmation hash. Reads no
// secret and writes nothing. With --write and the matching hash, sends.
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Args } from "../args.ts";
import { graphDir, loadAll, mdFiles } from "../store.ts";
import { die, print } from "../util.ts";
import { buildPlan } from "../publish.ts";
import type { LeftOut } from "../publish.ts";
import {
  CAP, CARD, COLLECTION, COLLECTIONS, CONNECTION, checkAccount, configPath, confirmationHash, fetchTransport,
  listAll, matchPlan, readConfig,
} from "../send.ts";
import type { Planned, RemoteRecord, Transport } from "../send.ts";
import { SECRET_ENV, sendWrites, writeLogPath } from "../write.ts";
import { publishErrors } from "./check.ts";
import { emit } from "./types.ts";

/**
 * Flags that would carry an account or secret value, or ask for a delete.
 * They are declared (so a value after them is never echoed back as an
 * unrecognized argument) and then refused outright.
 */
export const REFUSED = ["--password", "--token", "--did", "--pds", "--delete"] as const;

let transport: Transport = fetchTransport;

/** Tests swap in a fake PDS here; nothing else calls this. */
export function setTransport(t: Transport): void {
  transport = t;
}

/** Whether the confirmation can be typed: stdin is a terminal. Tests stub it. */
let interactive = (): boolean => process.stdin.isTTY === true;

/** Tests swap this in to act as a terminal; nothing else calls it. */
export function setInteractive(f: () => boolean): void {
  interactive = f;
}

/**
 * Characters that can hide or reorder text on a terminal, shown as visible
 * \u{XXXX} escapes. G10 already keeps them out of every record; this is the
 * second line, so the dry run can never show different text from what is sent.
 */
function visible(t: string): string {
  return t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    (c) => `\\u{${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}}`);
}

function leftOutLine(l: LeftOut): string {
  if (l.kind === "note") return `  note ${l.note}: ${l.reason}`;
  if (l.kind === "log") return `  log ${l.log}: ${l.reason}`;
  return `  link ${l.from} ${l.type} ${l.to}: ${l.reason}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** One line naming the record, then (for creates and updates) the full text it carries. */
function recordLines(r: Planned): string[] {
  const v = r.value;
  const content = (v["content"] ?? {}) as Record<string, unknown>;
  let head: string;
  let text: string | null = null;
  if (r.collection === CARD && v["type"] === "URL") {
    const meta = (content["metadata"] ?? {}) as Record<string, unknown>;
    head = `card URL ${str(content["url"])}  "${str(meta["title"])}"`;
  } else if (r.collection === CARD) {
    head = `card NOTE on ${str(v["url"])}`;
    text = str(content["text"]);
  } else if (r.collection === CONNECTION) {
    head = `connection ${str(v["source"])} -> ${str(v["target"])}  ${str(v["connectionType"])}`;
    text = typeof v["note"] === "string" ? v["note"] : null;
  } else if (r.collection === COLLECTION) {
    head = `collection "${str(v["name"])}"  ${str(v["accessType"])}`;
    text = typeof v["description"] === "string" ? v["description"] : null;
  } else {
    head = `collection link "${str(r.identity["collectionName"])}" <- ${str(r.identity["cardUrl"])}`;
  }
  const why = r.cascade ? "  (a record it points to changes)" : "";
  const lines = [`  ${r.action.padEnd(9)}  ${visible(head)}${r.uri ? "  " + r.uri : ""}${why}`];
  if (r.drops.length > 0) {
    lines.push(`      drops fields the repo copy has: ${visible(r.drops.join(", ")).slice(0, 300)}`);
  }
  if (text !== null && r.action !== "unchanged") for (const t of text.split("\n")) lines.push(`      | ${visible(t)}`);
  return lines;
}

/** Read one line from stdin; "" at end of input. */
async function readLine(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of rl) return line;
    return "";
  } finally {
    rl.close();
  }
}

interface Computed {
  g: string;
  lines: string[];
  data: Record<string, unknown>;
  records: Planned[];
  writes: number;
  hash: string;
}

/** Everything the dry run shows, recomputed from the graph and the repo. */
async function compute(a: Args, max: number, write: boolean): Promise<Computed & { acct: ReturnType<typeof readConfig> }> {
  const g = path.resolve(graphDir(a.str("graph")));
  const notes = loadAll(g);
  const errors = publishErrors(notes);
  if (errors.length > 0) {
    die(2, `the graph has publishing errors; fix them first (\`anote check\`):\n` +
      errors.map(([s, m]) => `  ${s}: ${m}`).join("\n"));
  }
  const dailyDir = path.join(g, "daily");
  const logs = fs.existsSync(dailyDir) ? mdFiles(dailyDir).map((f) => f.slice(0, -3)) : [];
  const plan = buildPlan(notes, logs);

  const acct = readConfig(configPath());
  await checkAccount(transport, acct);
  const remote: RemoteRecord[] = [];
  for (const c of COLLECTIONS) remote.push(...(await listAll(transport, acct, c)));
  const { records, left_alone } = matchPlan(plan, remote, acct.did);

  const counts = { create: 0, update: 0, unchanged: 0 };
  for (const r of records) counts[r.action]++;
  const writes = counts.create + counts.update;
  if (writes > max) die(2, `${writes} writes planned, over the cap of ${max} per run; nothing ${write ? "was" : "would be"} sent`);
  const hash = confirmationHash(records, acct.did, g);

  const lines = [
    "dry run: nothing is sent and no secret is read",
    `graph:   ${g}`,
    `account: ${acct.handle} (${acct.did}) on ${acct.pds}`,
    "",
    `records (${records.length}: ${counts.create} create, ${counts.update} update, ${counts.unchanged} unchanged):`,
    ...records.flatMap(recordLines),
    "",
    `left alone (anote never deletes) (${left_alone.length}):`,
    ...left_alone.map((r) => `  ${r.uri}  ${r.what}`),
    "",
    `left out (${plan.left_out.length}):`,
    ...plan.left_out.map(leftOutLine),
  ];
  if (plan.notices.length > 0) lines.push("", "notes:", ...plan.notices.map((x) => "  " + x));
  lines.push(
    "",
    writes === 0 ? "nothing to send" : `${writes} writes (${counts.create} create, ${counts.update} update)`,
    `confirmation hash: ${hash}`,
    "Records written to the repo are public. Read every line above, including the full text, before confirming.",
  );
  const data = {
    graph: g, account: acct, records, left_alone, left_out: plan.left_out, notices: plan.notices,
    counts: { ...counts, writes }, hash,
  };
  return { g, acct, lines, data, records, writes, hash };
}

export async function cmdPublishSend(a: Args): Promise<number> {
  for (const f of REFUSED) {
    if (f !== "--delete" && a.values.get(f.slice(2)) !== undefined) {
      die(2, `${f} is refused: account details go in the publish config and secrets never go on the command line`);
    }
  }
  if (a.flag("delete")) die(2, "--delete is refused: anote never deletes records");
  const write = a.flag("write");
  const confirm = a.str("confirm");
  if (confirm !== undefined && !write) die(2, "--confirm is only used with --write");
  if (write && confirm === undefined && !interactive()) {
    die(2, "--write without a terminal needs --confirm HASH; run `anote publish send` first, read it, and pass its hash");
  }
  const max = a.num("max");
  if (max > CAP) die(2, `--max can only lower the cap of ${CAP} writes per run`);
  if (max < 1) die(2, "--max must be at least 1");

  const c = await compute(a, max, write);
  if (!write) {
    emit(a, c.data, c.lines.join("\n"));
    return 0;
  }
  if (c.writes === 0) {
    emit(a, { ...c.data, sent: [] }, "nothing to send");
    return 0;
  }
  const changed = "plan changed since the dry run; run it again and read it";
  if (confirm !== undefined) {
    if (confirm.trim() !== c.hash) die(2, changed);
  } else {
    print(c.lines.join("\n"));
    process.stdout.write(`\ntype the confirmation hash to send these ${c.writes} writes (anything else aborts): `);
    const typed = (await readLine()).trim();
    if (typed !== c.hash) die(2, "aborted: the typed text is not the confirmation hash; nothing was sent");
  }

  // The last check reads the graph again, as it is now, not as it was at the dry run.
  const sent = await sendWrites({
    transport, acct: c.acct, notes: loadAll(c.g), records: c.records,
    readSecret: () => process.env[SECRET_ENV], logFile: writeLogPath(),
  });
  const lines = [
    `sent ${sent.length} writes to ${c.acct.did}:`,
    ...sent.map((x) => `  ${x.action.padEnd(7)}  ${x.uri}`),
    `write log: ${writeLogPath()}`,
  ];
  emit(a, { graph: c.g, account: c.acct, hash: c.hash, sent }, lines.join("\n"));
  return 0;
}
