// add, log and promote: the commands that bring new content in.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { Note, newMeta } from "../frontmatter.ts";
import type { Link, Meta } from "../frontmatter.ts";
import { when } from "../dates.ts";
import { DATE_RE, DEFAULT_REVIEW, LOG_LINE, checkType, normTags, normType } from "../schema.ts";
import type { Source } from "../schema.ts";
import { dailyBullets, graphDir, loadAll, resolve, save } from "../store.ts";
import type { Notes } from "../store.ts";
import {
  clean, die, isoDate, nowHHMM, print, readStdin, readText, slugify, stripNewlines, today, writeText,
} from "../util.ts";

function typeFromArgs(a: Args): string {
  const parts = [a.need("type")];
  const media = a.str("media");
  const form = a.str("form");
  if (media) parts.push(media);
  if (form) parts.push(form);
  return checkType(parts.join(" "));
}

/** Validate everything, then write the note file. Returns the slug. */
function createNote(g: string, notes: Notes, a: Args, titleRaw: string, body: string, source: Source): string {
  const title = clean(titleRaw);
  if (!title) die(2, "title is empty");
  const typeLine = typeFromArgs(a);
  const head = typeLine.split(" ")[0];
  if (head === "person" && !a.flag("person_ok")) {
    die(2, "person notes need --person-ok. Only for someone likely to be referenced " +
      "more than a few times, and only with facts they would be fine with being " +
      "recorded. Otherwise write the name as plain text in the log.");
  }
  const stance = a.str("stance");
  if (stance && head !== "assertion") die(2, "--stance only applies to assertions");
  const slugFlag = a.str("slug");
  const slug = slugFlag ? slugify(slugFlag) : slugify(title);
  if (!slug) die(2, "could not make a slug from the title; pass --slug");
  if (notes.has(slug)) die(2, `'${slug}' already exists. Use \`anote append ${slug} ...\` or pass --slug.`);
  const links: Link[] = [];
  for (const spec of a.list("link")) {
    const i = spec.indexOf(":");
    if (i < 0) die(2, `--link wants TYPE:NOTE, got '${spec}'`);
    links.push({ type: normType(spec.slice(0, i)), to: resolve(notes, spec.slice(i + 1)), note: "" });
  }
  const reviewFlag = a.str("review");
  const review = reviewFlag !== undefined ? when(reviewFlag) : when(DEFAULT_REVIEW[source]);
  const d = isoDate(today());
  const meta: Meta = newMeta();
  Object.assign(meta, { title, type: typeLine, created: d, updated: d, source, status: "active" });
  if (stance) meta["stance"] = stance;
  const version = a.str("version");
  if (version) meta["version"] = clean(version);
  if (review) meta["review"] = review;
  const tags = normTags(a.list("tag"));
  if (tags.length > 0) meta["tags"] = tags.join(", ");
  save(g, new Note(slug, meta, stripNewlines(body), links));
  return slug;
}

export function cmdAdd(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const bodyFlag = a.str("body");
  const body = bodyFlag === "-" ? readStdin() : (bodyFlag ?? "");
  const slug = createNote(g, notes, a, a.need("title"), body, a.need("source") as Source);
  print(`created ${slug}`);
}

/** Add a bullet to today's daily log. Returns the day (YYYY-MM-DD). */
function appendLog(g: string, text: string, source: string): string {
  const day = isoDate(today());
  const p = path.join(g, "daily", day + ".md");
  let existing = fs.existsSync(p) ? readText(p) : `# ${day}\n\n`;
  if (!existing.endsWith("\n")) existing += "\n";
  writeText(p, existing + `- ${nowHHMM()} [${source}] ${text}\n`);
  return day;
}

export function cmdLog(a: Args): void {
  const g = graphDir(a.str("graph"));
  const text = clean(a.list("text").join(" "));
  if (!text) die(2, "nothing to log");
  const day = appendLog(g, text, a.need("source"));
  print(`logged to daily/${day}`);
}

export function cmdPromote(a: Args): void {
  const g = graphDir(a.str("graph"));
  const date = a.need("date");
  const line = a.num("line");
  if (!DATE_RE.test(date)) die(2, "date must be YYYY-MM-DD");
  const p = path.join(g, "daily", date + ".md");
  if (!fs.existsSync(p)) die(3, `no daily note for ${date}`);
  const bullets = dailyBullets(p);
  if (!(line >= 1 && line <= bullets.length)) {
    die(3, `line ${line} is out of range (1 to ${bullets.length})`);
  }
  const raw = bullets[line - 1] as string;
  const m = LOG_LINE.exec(raw);
  const text = m ? (m[3] as string) : raw.slice(2);
  const source = a.str("source") || (m ? (m[2] as string) : undefined);
  if (!source) die(2, "that line has no source tag; pass --source");
  const slug = createNote(g, loadAll(g), a, a.need("title"), text, source as Source);
  appendLog(g, `promoted line ${line} of ${date} to [[${slug}]]`, "observed");
  print(`promoted to ${slug}`);
}
