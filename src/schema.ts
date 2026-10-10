// The fixed vocabulary: link types, note types, sources, and the rules that
// check a note's type line. Object key order matters (it is the display order).
import { die, lookup, slugify } from "./util.ts";

export const LINK_TYPES: Record<string, string> = {
  "expands-on": "adds detail to, or builds out, the target",
  explains: "makes the target understandable",
  supports: "is evidence or argument for the target",
  opposes: "is evidence or argument against the target",
  relates: "is connected to the target in a way no other type names",
  addresses: "responds to a question, problem or request in the target",
  "helpful-background": "context worth reading before the target",
  "leads-to": "the target follows from this",
  supplemental: "optional extra material for the target",
  duplicates: "says the same thing as the target",
  references: "cites or points at the target",
};

export const TYPE_ALIASES: Record<string, string> = {
  expands: "expands-on",
  expand: "expands-on",
  explain: "explains",
  support: "supports",
  oppose: "opposes",
  relate: "relates",
  related: "relates",
  address: "addresses",
  background: "helpful-background",
  leads: "leads-to",
  supplement: "supplemental",
  duplicate: "duplicates",
  reference: "references",
  refs: "references",
};

export const SOURCES = ["told", "observed", "inferred"] as const;
export type Source = (typeof SOURCES)[number];

export const DEFAULT_REVIEW: Record<Source, string> = {
  observed: "+60d",
  inferred: "+30d",
  told: "+180d",
};

export const STANCES = ["held", "unheld"] as const;
export const SETTABLE = ["title", "type", "source", "stance", "version", "review", "tags"] as const;

/** Order keys are written to disk. Unknown keys follow, sorted. */
export const META_ORDER = [
  "title", "type", "created", "updated", "source", "stance", "version",
  "review", "confirmed", "status", "tags", "supersedes", "superseded_by",
];

export const NOTE_TYPES: Record<string, string> = {
  reference: "a record of a piece of material: something read, watched or listened to",
  hub: "a hand-kept collection of links to notes that share no other connection",
  artifact: "writing you composed; add a form (post, message, ...) once the form is clear",
  assertion: "a claim that can be challenged, as one idea; not anyone's position unless stance says so",
  concept: "an abstraction other notes refer to by name, with no claim attached",
  cycle: "one work cycle; what goes in it is defined elsewhere",
  fragment: "a piece lifted from a reference that is worth its own note; links back to it",
  person: "a person likely to be referenced more than a few times",
  project: "tasks directed at a goal with a defined output",
  protocol: "instructions written in advance for a scenario",
  question: "something still unanswered; assertions answer it",
};

export const MEDIA = ["audio", "text", "video"] as const; // already sorted
export const FORMS: Record<string, string> = { article: "text", book: "text", film: "video" };

export const LOG_LINE = /^- (\d{2}:\d{2}) \[(told|observed|inferred)\] (.*)$/;
export const WIKILINK = /\[\[([^\]|]+)\]\]/g;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const list = (xs: Iterable<string>) => [...xs].join(", ");

/** Normalise a link type (aliases, spaces, underscores) or exit 2. */
export function normType(raw: string): string {
  let t = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  t = lookup(TYPE_ALIASES, t) ?? t;
  if (!Object.hasOwn(LINK_TYPES, t)) {
    die(2, `unknown link type '${t}'. Types: ${list(Object.keys(LINK_TYPES))}`);
  }
  return t;
}

/** Validate a type line and return it normalised, e.g. 'reference text article'. */
export function checkType(raw: string): string {
  const w = raw
    .trim()
    .split(/[\s,]+/)
    .map((x) => x.replace(/^#+/, "").toLowerCase())
    .filter((x) => x !== "");
  const noteTypes = list(Object.keys(NOTE_TYPES));
  const head = w[0];
  if (head === undefined) die(2, `type is empty. Types: ${noteTypes}`);
  const rest = w.slice(1);
  if (!Object.hasOwn(NOTE_TYPES, head)) {
    die(2, `unknown note type '${head}'. Types: ${noteTypes}`);
  }
  const r0 = rest[0];
  if (head === "reference") {
    if (r0 !== undefined && !(MEDIA as readonly string[]).includes(r0)) {
      const form = lookup(FORMS, r0);
      if (form !== undefined) die(2, `form '${r0}' goes after its media tag: reference ${form} ${r0}`);
      die(2, `reference media must be one of: ${list(MEDIA)}`);
    }
    if (rest.length > 2) die(2, "a reference carries at most three tags: reference, media, form");
    if (rest.length === 2) {
      const r1 = rest[1] as string;
      const media = lookup(FORMS, r1);
      if (media === undefined) die(2, `unknown reference form '${r1}'. Forms: ${list(Object.keys(FORMS))}`);
      if (media !== r0) die(2, `form '${r1}' goes with media '${media}', not '${r0}'`);
    }
  } else if (head === "artifact") {
    if (rest.length > 1) die(2, "an artifact carries at most one form tag");
    if (r0 !== undefined && (!/^[a-z][a-z0-9-]*$/.test(r0) || Object.hasOwn(NOTE_TYPES, r0))) {
      die(2, `'${r0}' is not a usable artifact form (try post, message or outline)`);
    }
  } else if (rest.length > 0) {
    die(2, `a ${head} note carries a single type tag, got extra: ${rest.join(" ")}`);
  }
  return w.join(" ");
}

/** Slugify each comma-separated piece, drop empties, dedupe, sort. */
export function normTags(raws: string[]): string[] {
  const out = new Set<string>();
  for (const raw of raws) for (const t of raw.split(",")) if (slugify(t)) out.add(slugify(t));
  return [...out].sort();
}
