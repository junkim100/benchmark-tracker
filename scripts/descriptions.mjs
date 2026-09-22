// What a benchmark description is, and what makes one valid.
//
// The registry answers who cited a benchmark and when. It does not answer what the benchmark is, and for most of it nobody can: 75 per cent of the 2,059 ids are cited by exactly one lab, and 52 per cent were first cited on or after June 2025. A model asked what "FrontierCode 1.1 Extended" measures will answer fluently from the name alone, and that answer is wrong in a way no reader of this site could detect. So a description is only written when a page was found and read, and the page is recorded beside it.
//
// Which makes refusal the load-bearing case rather than the error case. An entry with source "none" is a real result: it says somebody looked on this date and found nothing usable, so the next pass can skip it until the cutoff and spend its budget on ids nobody has tried. A pass that returns 2,059 confident descriptions has failed, and the refusal rate is printed on every build for that reason.
//
// The rules live here rather than in either caller because both need them. scripts/describe.mjs checks an answer before writing it, so one bad reply costs one entry instead of failing the build that publishes the other 2,175; scripts/normalize.mjs repeats the same check as a contract rule, so a hand edit or a future writer is covered too. This is the arrangement scripts/sources.mjs already uses for source_url, and for the same reason.

/** Longest description the contract allows.
 *
 *  A backstop, not a target: the prompt asks for one or two sentences and the observed shape is around 120 characters, which is where the 320 kB estimate for the whole file comes from. The cap exists so that one runaway reply cannot put a paragraph into a panel sized for two lines, and so the asset cannot silently grow past a megabyte. */
export const MAX_TEXT = 300;

/** Shortest description the contract allows. Below this it is not a description, it is the benchmark's name with "is a benchmark for" wrapped around it, which is what a model writes when it found nothing and would rather not say so. */
export const MIN_TEXT = 40;

/** How long a refusal stands before it is worth trying again.
 *
 *  Most refusals are benchmarks whose paper, repository or dataset card did not exist yet when the pass ran. Three months is long enough for one to have appeared and short enough that a quarterly re-run converges, and it bounds the cost of a re-run to the refusal rate rather than the whole registry. */
export const RETRY_DAYS = 90;

/** Where a description came from. "researched" means a page was opened and read; "none" means it was looked for and not found, and carries no text. */
export const SOURCES = new Set(["researched", "none"]);

const FIELDS = new Set(["text", "source_url", "source", "checked"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// This project records which benchmarks labs cite and never how well anyone did, so a number reading as a result is a contract breach wherever it appears. normalize.mjs line 150 enforces that on names, where a colon before any digit is enough because a name is a few words long. A description is prose, and prose says "The AI2 Reasoning Challenge: 7,787 questions" and "scored by F1" and "v1.1 corrected the reference answers", none of which is a result. So the rule here asks for the shape of a result claim instead: a percentage, a pass@k, a superlative, a decimal after a colon (a count is a whole number, a score rarely is), or a verb of achievement with a number as its object. "Judged by a GPT-4 grader" names the method and stays; "reaches 74 on the private split" does not.
export const SCORE = /\d\s*%|\bpass@\d|[:=]\s*\d+\.\d|\bSOTA\b|state[- ]of[- ]the[- ]art|\b(?:scores?|scored|achieves?|achieved|reaches?|reached|solves?|solved|beats?|outperforms?)\s+(?:about|around|roughly|nearly|only|just|a|an|the)?\s*\d/i;

/** Collapse the whitespace a model puts in a two-sentence answer, so the stored text is one line and two entries that differ only in wrapping are one entry. */
export const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** What is wrong with one entry, or null when nothing is.
 *
 *  Returned as a sentence rather than a boolean because both callers have to say what they rejected: describe.mjs prints it against the benchmark it came from, and normalize.mjs prints it as a named contract problem. A checker that only says "invalid" sends whoever reads the log back to the source to work out which of eight rules fired. */
export function checkEntry(entry, today) {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return "must be an object";
  for (const k of Object.keys(entry)) if (!FIELDS.has(k)) return `unknown field "${k}"`;

  if (!SOURCES.has(entry.source)) return `source must be one of ${[...SOURCES].join(", ")}, got ${JSON.stringify(entry.source)}`;
  if (!DATE.test(entry.checked ?? "")) return `checked must be YYYY-MM-DD, got ${JSON.stringify(entry.checked)}`;
  if (today && entry.checked > today) return `checked "${entry.checked}" is in the future`;

  if (entry.source === "none") {
    // A refusal carries no text and no URL. Left loose, the field would fill with "No description found", which reads to every consumer like a description and would be rendered as one.
    if ("text" in entry) return "source none carries no text";
    if ("source_url" in entry) return "source none carries no source_url";
    return null;
  }

  if (typeof entry.text !== "string") return "text must be a string";
  const text = tidy(entry.text);
  if (text.length < MIN_TEXT) return `text is ${text.length} characters, shorter than the ${MIN_TEXT} a description needs`;
  if (text.length > MAX_TEXT) return `text is ${text.length} characters, longer than the ${MAX_TEXT} allowed`;
  if (text !== entry.text) return "text must already be trimmed and single-spaced";
  if (SCORE.test(text)) return `text "${text.slice(0, 60)}..." contains what reads as a score`;

  // Required, and https, for the reason scripts/sources.mjs gives about release sources: this is a link the site invites a reader to click as the provenance of a claim it is making, and one a network can rewrite is not provenance. Not restricted to any host list, though. A benchmark's own page is as likely to be a university site, a GitHub repository or a dataset card as a lab's, and there is no equivalent of labs.json to check it against.
  if (typeof entry.source_url !== "string" || !/^https:\/\//.test(entry.source_url)) {
    return `source is researched, so source_url must be an https URL, got ${JSON.stringify(entry.source_url)}`;
  }
  try { new URL(entry.source_url); } catch { return `source_url "${entry.source_url}" is not a URL`; }
  return null;
}

/** Every contract problem in the file, as named records.
 *
 *  `ids` is the registry that was just built, because the one thing that can make a well-formed entry wrong is the id it is filed under. An id that no longer exists is usually not a typo: it is a benchmark that an alias merge retired, which research.mjs can now apply unattended, so the diagnostic resolves the id through the alias map and says which it is. Left undetected the entry would simply never be found by anything, and the pass would keep spending a request on it because it looks described. */
export function checkDescriptions(descriptions, { ids, aliasByKey, today }) {
  const problems = [];
  if (descriptions == null || typeof descriptions !== "object" || Array.isArray(descriptions)) {
    return ["descriptions.json: expected an object keyed by benchmark id"];
  }
  for (const [id, entry] of Object.entries(descriptions)) {
    const where = `descriptions.json ${id}`;
    if (!ids.has(id)) {
      const merged = aliasByKey?.get(id);
      problems.push(merged && ids.has(merged)
        ? `${where}: retired into "${merged}" by an alias merge. Run node scripts/describe.mjs --prune to follow the merge.`
        : `${where}: no benchmark has this id. Run node scripts/describe.mjs --prune to drop it.`);
      continue;
    }
    const bad = checkEntry(entry, today);
    if (bad) problems.push(`${where}: ${bad}`);
  }
  return problems;
}

/** True when a refusal is old enough to be worth another look. Only refusals go stale: a description that was read off a page stays true, and re-reading 2,059 of them to confirm that would cost the whole budget every run. */
export const isStale = (entry, today, days = RETRY_DAYS) =>
  entry?.source === "none" && entry.checked < new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);

/** The copy the browser gets: the descriptions that exist, and only the two fields a panel renders.
 *
 *  Same split as release-log.json. `source` and `checked` are the pass's own bookkeeping and mean nothing to a reader, and a refusal has nothing to show, so both are dropped: an id absent from this file is an id with no description, which is exactly what the panel needs to know. At an expected refusal rate the result is roughly half the size of the file it comes from, and none of it is on the path to first paint. */
export function siteDescriptions(descriptions) {
  const out = {};
  for (const id of Object.keys(descriptions).sort()) {
    const e = descriptions[id];
    if (e?.source === "researched") out[id] = { text: e.text, source_url: e.source_url };
  }
  return out;
}
