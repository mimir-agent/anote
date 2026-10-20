// publish send: the dry run. Checks the graph and the account, reads the
// account's own records, and prints what a send would create, update or leave
// unchanged, with the confirmation hash. Reads no secret and writes nothing.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { graphDir, loadAll, mdFiles } from "../store.ts";
import { die } from "../util.ts";
import { buildPlan } from "../publish.ts";
import type { LeftOut } from "../publish.ts";
import {
  CAP, CARD, COLLECTION, COLLECTIONS, CONNECTION, checkAccount, configPath, confirmationHash, fetchTransport,
  listAll, matchPlan, readConfig,
} from "../send.ts";
import type { Planned, RemoteRecord, Transport } from "../send.ts";
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
  const lines = [`  ${r.action.padEnd(9)}  ${head}${r.uri ? "  " + r.uri : ""}${why}`];
  if (text !== null && r.action !== "unchanged") for (const t of text.split("\n")) lines.push(`      | ${t}`);
  return lines;
}

export async function cmdPublishSend(a: Args): Promise<number> {
  for (const f of REFUSED) {
    if (f !== "--delete" && a.values.get(f.slice(2)) !== undefined) {
      die(2, `${f} is refused: account details go in the publish config and secrets never go on the command line`);
    }
  }
  if (a.flag("delete")) die(2, "--delete is refused: anote never deletes records");
  if (a.flag("write")) die(2, "--write is not available yet; run `anote publish send` without it for the dry run");
  const max = a.num("max");
  if (max > CAP) die(2, `--max can only lower the cap of ${CAP} writes per run`);
  if (max < 1) die(2, "--max must be at least 1");

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
  if (writes > max) die(2, `${writes} writes planned, over the cap of ${max} per run; nothing would be sent`);
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
  emit(a, {
    graph: g, account: acct, records, left_alone, left_out: plan.left_out, notices: plan.notices,
    counts: { ...counts, writes }, hash,
  }, lines.join("\n"));
  return 0;
}
