// init and types: no notes involved.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { FORMS, LINK_TYPES, MEDIA, NOTE_TYPES } from "../schema.ts";
import { graphDir } from "../store.ts";
import { padEnd, print } from "../util.ts";
import { emit } from "./types.ts";

export function cmdInit(a: Args): void {
  const g = graphDir(a.str("graph"));
  fs.mkdirSync(path.join(g, "notes"), { recursive: true });
  fs.mkdirSync(path.join(g, "daily"), { recursive: true });
  print(`graph ready at ${g}`);
}

export function cmdTypes(a: Args): void {
  const forms = Object.entries(FORMS).map(([f, m]) => `${f}=${m}`).join(", ");
  const rows = ["note types (one per note, --type):"];
  for (const [k, v] of Object.entries(NOTE_TYPES)) rows.push(`  ${padEnd(k, 10)} ${v}`);
  rows.push("", `a reference adds media (${MEDIA.join(", ")}), then a form (${forms})`, "", "link types:");
  for (const [k, v] of Object.entries(LINK_TYPES)) rows.push(`  ${padEnd(k, 20)} ${v}`);
  emit(a, { note_types: NOTE_TYPES, link_types: LINK_TYPES }, rows.join("\n"));
}
