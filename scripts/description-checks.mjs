// What a benchmark description has to survive before a reader should believe it.
//
// Descriptions are the first thing on this site written rather than cited. Every other value here came off a page the pipeline read: a citation, a date, a URL. A description is prose in the site's own voice, and the footer promises the reader that nothing came from news coverage or a third-party leaderboard and that no score is recorded anywhere. Prose is where that promise gets broken first, because a sentence can be wrong in a way a URL cannot.
//
// Two measurements set the difficulty. 52 per cent of the registry was first cited on or after June 2025, which is after most training data ends, so a model asked what those benchmarks are has nothing to recall and every incentive to sound fluent. And 76 per cent are cited by exactly one lab, which is the obscure tail where no good page exists at all. Both are recomputed here from release-log.json rather than trusted, because the cohort split is what every number in the audit is conditioned on and a wrong split would quietly invalidate all of them.
//
// This module holds everything the audit and the sampler share: how a benchmark's cohort is decided, how a refusal is recognised, and what counts as a finding. They are shared rather than written twice for the reason sources.mjs gives for sharing SHARED_HOSTS: a sampler stratifying on one definition of "hard" while the audit reports on another is two answers to the same question, and nobody would know which they were reading.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isOfficialSource } from "./sources.mjs";
import { SCORE } from "./descriptions.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = join(ROOT, "data");
export const DEFAULT_PATH = join(DATA, "descriptions.json");

// The month after which a benchmark is unlikely to be in a model's weights.
//
// Not a claim about any particular model's cutoff. It is the line the owner's own measurement is drawn at, 52 per cent of the registry on or after it, and moving it moves every cohort number in the audit, so it is named once here rather than repeated as a literal in two scripts.
export const RECENT_CUTOFF = "2025-06-01";

// Below this a benchmark is the long tail: one lab said it once and nobody else ever repeated it.
export const LONE_LAB = 1;
// At or above this a benchmark is the well-known head, where a description has no excuse.
export const HEAD_LABS = 3;

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Everything the registry already knows about each benchmark, keyed by id.
 *
 *  first_seen and the citing-lab set are derived from release-log.json rather than read out of benchmarks.json, because release-log is the evidence and benchmarks.json is a second rendering of it. Deriving them here also gives the audit something benchmarks.json does not carry: which labs cited a benchmark, which is what decides whether a lab-domain source URL has any business being attached to it.
 *
 *  The derived lab count is checked against the one timeline.json publishes. They agree on all 2,176 today. If they ever stop agreeing, every cohort split in the audit is being computed off a different dataset from the one the site draws, and that is worth a loud line rather than a silent divergence. */
export function loadRegistry() {
  const timeline = read(join(DATA, "timeline.json"));
  const log = read(join(DATA, "release-log.json"));
  const benchmarks = timeline.benchmarks ?? [];

  const facts = benchmarks.map((b) => ({
    id: b.id,
    name: b.name,
    categories: b.categories ?? [],
    suite: b.suite ?? null,
    lab_count: b.lab_count ?? 0,
    recent_share: b.recent_share ?? 0,
    labs: new Set(),
    first_seen: null,
    last_seen: null,
    release_urls: new Set(),
  }));

  for (const r of log) {
    for (const i of r.benchmarks ?? []) {
      const f = facts[i];
      if (!f) continue;
      f.labs.add(r.lab);
      if (!f.first_seen || r.date < f.first_seen) f.first_seen = r.date;
      if (!f.last_seen || r.date > f.last_seen) f.last_seen = r.date;
      if (r.source_url) f.release_urls.add(r.source_url);
    }
  }

  const drift = facts.filter((f) => f.labs.size !== f.lab_count).map((f) => f.id);
  const byId = new Map(facts.map((f) => [f.id, f]));
  return { facts, byId, drift, generated_at: timeline.generated_at ?? null };
}

/** Which cohort a benchmark sits in, which is what the whole audit conditions on.
 *
 *  `era` and `labBand` are the two measurements the owner already made. `difficulty` folds them into the pair that matters: "hard" is the recent long tail, where a description is either researched or invented and there is no third option, and "head" is the well-cited old middle, where getting it wrong means the pass is broken in a way no cohort analysis is needed to see. Everything between is "middle" and is neither evidence nor alarm on its own. */
export function cohortOf(fact) {
  const era = !fact.first_seen ? "unknown" : fact.first_seen >= RECENT_CUTOFF ? "recent" : "established";
  const labBand = fact.lab_count <= LONE_LAB ? "one" : fact.lab_count >= HEAD_LABS ? "many" : "two";
  const difficulty =
    era === "recent" && labBand === "one" ? "hard" : era === "established" && labBand === "many" ? "head" : "middle";
  return { era, labBand, difficulty, year: fact.first_seen?.slice(0, 4) ?? "unknown", category: fact.categories[0] ?? "none" };
}

// ---------------------------------------------------------------------------
// Loading a file whose exact shape is not settled

const TEXT_KEYS = ["text", "description", "summary", "blurb", "body", "content"];
const URL_KEYS = ["source_url", "url", "source", "link", "citation"];
// "source" is last because it is ambiguous: scripts/describe.mjs uses it for the provenance verdict ("researched" or "none") while another writer might use it for the URL, so it is only read as a status once a more specific field has claimed the URL.
const STATUS_KEYS = ["status", "decision", "outcome", "result", "verdict", "source"];
const REFUSAL_FLAGS = ["refused", "refusal", "abstained", "unknown", "not_found", "no_source", "none"];

const firstString = (obj, keys) => {
  for (const k of keys) if (typeof obj[k] === "string" && obj[k].trim()) return obj[k].trim();
  return null;
};

/** Read descriptions.json without insisting on a shape.
 *
 *  This file is written by a different pass than the one auditing it, and the audit has to be usable the first time that pass produces output rather than after a schema negotiation. So four plausible shapes are accepted, an array, `{descriptions: [...]}`, `{descriptions: {id: entry}}` and a bare id-keyed object, and the field carrying the prose is found by probing the obvious names.
 *
 *  What it never does is guess silently. The shape it settled on and the field names it used come back in `shape`, and the audit prints them, because a quality report that quietly read the wrong field would be a confident report about nothing. If the prose field cannot be found at all, every entry lands with a null text and the audit says so on its first line rather than reporting a zero refusal rate on an empty read. */
export function loadDescriptions(path = DEFAULT_PATH) {
  if (!existsSync(path)) return { entries: [], shape: { container: "missing", path }, raw: null };
  const raw = read(path);

  let container = "array";
  let rows = null;
  if (Array.isArray(raw)) rows = raw.map((v) => [null, v]);
  else if (Array.isArray(raw?.descriptions)) { container = "object.descriptions[]"; rows = raw.descriptions.map((v) => [null, v]); }
  else if (raw?.descriptions && typeof raw.descriptions === "object") { container = "object.descriptions{}"; rows = Object.entries(raw.descriptions); }
  else if (raw && typeof raw === "object") { container = "id-keyed object"; rows = Object.entries(raw).filter(([k]) => !k.startsWith("_") && k !== "generated_at"); }
  else return { entries: [], shape: { container: "unrecognised", path }, raw };

  // A value may be the prose itself rather than a record, as in {"mmlu": "MMLU is ..."}.
  const normalised = rows.map(([k, v]) => (typeof v === "string" ? [k, { text: v }] : [k, v ?? {}]));

  const textKey = TEXT_KEYS.find((k) => normalised.some(([, v]) => typeof v[k] === "string" && v[k].trim())) ?? null;
  const urlKey = URL_KEYS.find((k) => normalised.some(([, v]) => typeof v[k] === "string" && v[k].trim())) ?? null;
  const statusKey = STATUS_KEYS.find((k) => k !== urlKey && normalised.some(([, v]) => typeof v[k] === "string" && v[k].trim())) ?? null;

  const entries = normalised.map(([k, v], i) => {
    const id = k ?? v.id ?? v.benchmark_id ?? v.benchmark ?? null;
    const text = textKey ? (typeof v[textKey] === "string" ? v[textKey].trim() : "") : "";
    const source_url = urlKey && typeof v[urlKey] === "string" ? v[urlKey].trim() : null;
    const status = statusKey && typeof v[statusKey] === "string" ? v[statusKey].trim().toLowerCase() : null;
    // A boolean `refused: true` is as likely a shape as a status string, and it has to be honoured or every such entry reads as a confident description.
    const booleanRefusal = REFUSAL_FLAGS.some((f) => v[f] === true);
    return { id, index: i, text, source_url, status, booleanRefusal, record: v };
  });

  return { entries, shape: { container, textKey, urlKey, statusKey, path, count: entries.length }, raw };
}

// ---------------------------------------------------------------------------
// Reading the prose

// Phrases a refusal is written in. The pass is told that refusing is a correct outcome, so the point of this list is not to catch a rule violation but to count honestly: a refusal written as prose in the text field is still a refusal, and an audit that only counted a status field would report a pass as confident when half of it had actually declined.
const REFUSAL_PATTERNS = [
  /\b(could|can)\s?not\s+(find|verify|confirm|locate|identify|determine|establish)\b/i,
  /\bunable to\s+(find|verify|confirm|locate|identify|determine|describe)\b/i,
  /\bno (authoritative |reliable |primary |official |public )?(source|page|documentation|information|record)\b/i,
  /\bnot enough (information|evidence)\b/i,
  /\binsufficient (information|evidence|detail)\b/i,
  /\bnothing (authoritative|reliable|public)\b/i,
  /\b(i|we) (do|did) not know\b/i,
  /\bunknown benchmark\b/i,
  /\bdeclin(e|ed|ing) to describe\b/i,
  /^\s*(n\/a|none|unknown|unavailable)\s*$/i,
];

// Hedges are the failure this audit exists for. The pass is told refusal is expected, so the tempting middle path is a sentence that describes the benchmark while disclaiming that it is describing it. That lands on the site as content, reads as authority to anyone who does not parse the qualifier, and is not a refusal by any count.
const HEDGE_PATTERNS = [
  /\b(appears|seems|is believed|is thought|is understood|is reported) to be\b/i,
  /\b(likely|presumably|apparently|reportedly|ostensibly|purportedly|evidently)\b/i,
  /\bis (probably|possibly|perhaps)\b/i,
  /\b(may|might|could) (be|refer to|represent|denote|involve|relate to|test|measure)\b/i,
  /\bbased on (its|the) name\b/i,
  /\bjudging (from|by) (its|the) name\b/i,
  /\bthe name suggests\b/i,
  /\bpresumed\b/i,
  /\bno (further|public) details\b/i,
];

// A score is the one thing SCHEMA.md forbids outright and the footer repeats to the reader. A count that describes the benchmark is fine and common: MMLU covers 57 subjects, GPQA Diamond has 198 questions. What is not fine is a result.
//
// The first entry is the build's own rule, imported rather than restated. The audit used to keep a second, looser copy, and the two disagreeing is worse than either being wrong: the build accepted "scored by F1" and "128k context, scored by a judge" as the method descriptions they are, then the audit flagged all eleven of them as scores on every run, so the finding could never go to zero and stopped carrying information. The rest are formats the build's rule does not cover and that cannot be anything but a result.
const SCORE_PATTERNS = [
  SCORE,
  /\b(elo|mmr)\s+(rating|score)\s+(of\s+)?\d/i,
  /\b(accuracy|win rate|success rate|solve rate|f1|auc|bleu|rouge)\s+(of\s+)?\d/i,
];

// Scaffolding that carries no information about a particular benchmark. Stripping it is how a restatement of the name is told from a description: "SWE-bench Verified is a benchmark called SWE-bench Verified" is all name and all scaffolding, and what remains once both are gone is the part a reader learns something from.
const SCAFFOLD = new Set(
  ("a an the is are was were it its this that these those of for to in on by with and or as at from be been being " +
    "benchmark benchmarks benchmarking eval evals evaluation evaluations dataset datasets suite suites test tests testing " +
    "task tasks model models llm llms ai system systems measure measures measuring assess assesses assessing evaluate " +
    "evaluates evaluating designed intended used use uses usage ability abilities capability capabilities performance " +
    "quality which used consists consisting comprises comprising contains containing includes including " +
    "used known also called named referred set collection series family version versions " +
    "language large general various different several multiple many other others range wide broad " +
    "how well their they them there where when what whether while than then " +
    "one two three more most such some any each both not no nor but if so").split(/\s+/),
);

const WORDS = (s) => (s.toLowerCase().match(/[a-z0-9+#.-]{2,}/g) ?? []);

/** Tokens that make a benchmark's name distinctive, with the generic parts dropped.
 *
 *  "SWE-bench Verified" reduces to swe, verified. The word "bench" is scaffolding and matching on it would make every benchmark look like every other. */
export function nameTokens(name) {
  return [...new Set(WORDS(name).filter((w) => !SCAFFOLD.has(w) && w.length >= 2))];
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The description with the benchmark's own name taken out of it.
 *
 *  Every check that looks for a word has to run on this rather than on the raw text, and the reason is that benchmark names contain the words the checks look for. Eleven entries in the registry are called something Leaderboard and one is called CodeGolf v2.2 pass@1, so a score check reading the raw text reports a scoring violation for the crime of writing the benchmark's name down. The same trap catches the category check: a benchmark named AudioCode is not asserting anything about code by being named. */
export function stripName(text, name) {
  if (!name) return text;
  let out = text.replace(new RegExp(escape(name), "gi"), " ");
  for (const t of nameTokens(name)) out = out.replace(new RegExp(`\\b${escape(t)}\\b`, "gi"), " ");
  return out;
}

/** Everything the text checks need from one description, computed once.
 *
 *  `refused` is the union of the declared status, a boolean flag and the prose itself, because a pass that is told refusal is correct will express it in whichever of the three its schema makes easiest, and all three mean the same thing to a reader. */
export function readText(entry, fact) {
  const text = entry.text ?? "";
  const stripped = fact ? stripName(text, fact.name) : text;
  const declared =
    entry.booleanRefusal ||
    (entry.status != null && REFUSAL_FLAGS.some((f) => entry.status.includes(f.replace("_", ""))|| entry.status.includes(f)));
  const prose = text.length > 0 && REFUSAL_PATTERNS.some((re) => re.test(text));
  const empty = text.trim().length === 0;

  const words = WORDS(text);
  const nameSet = new Set(fact ? nameTokens(fact.name) : []);
  const content = words.filter((w) => !SCAFFOLD.has(w) && !nameSet.has(w) && !/^\d+$/.test(w));

  return {
    text,
    stripped,
    words: words.length,
    chars: text.length,
    refused: declared || prose || empty,
    refusalSource: declared ? "declared" : prose ? "prose" : empty ? "empty" : null,
    declared,
    prose,
    empty,
    contentWords: new Set(content).size,
    hedges: HEDGE_PATTERNS.filter((re) => re.test(stripped)).length,
    scores: SCORE_PATTERNS.filter((re) => re.test(stripped)).map((re) => stripped.match(re)?.[0]?.trim()).filter(Boolean),
    namePresent: !fact ? false : nameSet.size === 0 || [...nameSet].every((t) => text.toLowerCase().includes(t)),
    years: [...new Set((stripped.match(/\b(19|20)\d{2}\b/g) ?? []).map(Number))],
  };
}

// ---------------------------------------------------------------------------
// Reading the source URL

// Hosts the footer disclaims by name. Seeing one of these under a description is not a judgement call about quality: it is the sentence at the bottom of the page becoming false.
export const NEWS_HOSTS = new Set([
  "techcrunch.com", "theverge.com", "venturebeat.com", "wired.com", "arstechnica.com", "reuters.com", "bloomberg.com",
  "cnbc.com", "nytimes.com", "ft.com", "forbes.com", "businessinsider.com", "zdnet.com", "engadget.com", "theregister.com",
  "medium.com", "substack.com", "towardsdatascience.com", "analyticsvidhya.com", "kdnuggets.com", "marktechpost.com",
  "infoq.com", "hackernoon.com", "reddit.com", "twitter.com", "x.com", "linkedin.com", "youtube.com", "quora.com",
  "geeksforgeeks.org", "36kr.com", "jiqizhixin.com", "syncedreview.com",
]);

export const LEADERBOARD_HOSTS = new Set([
  "paperswithcode.com", "lmarena.ai", "chat.lmsys.org", "artificialanalysis.ai", "llm-stats.com", "vellum.ai",
  "klu.ai", "scale.com", "epoch.ai", "livebench.ai", "aider.chat", "evalplus.github.io", "crfm.stanford.edu",
]);

// Third-party summaries. Not news and not a leaderboard, so not a broken promise, but also not the benchmark's own page, and a description taken from one is a description of somebody else's description.
export const TERTIARY_HOSTS = new Set(["wikipedia.org", "en.wikipedia.org", "dbpedia.org", "scholar.google.com", "semanticscholar.org", "researchgate.net"]);

const host = (u) => u.hostname.toLowerCase().replace(/^www\./, "");
const inSet = (h, set) => set.has(h) || [...set].some((s) => h.endsWith(`.${s}`));

/** What kind of page a source URL points at, and whether it can be checked against anything.
 *
 *  The tiers matter more than they look. `arxiv` and `code` are pages that exist independently of this project and can be opened by a reviewer in one click, so a wrong description attached to one is catchable in seconds. `lab` is a release page, which names the benchmark in a results table and very often does not define it, so it is the tier where a description is most likely to have been composed rather than read. `bare` is a host with no path, which cannot support a specific claim about anything. */
export function readSource(url, fact, labs) {
  if (!url) return { kind: "none" };
  let u;
  try { u = new URL(url); } catch { return { kind: "malformed", url }; }
  const h = host(u);
  const path = u.pathname.replace(/\/+$/, "");
  const out = { kind: "other", url, host: h, path, https: u.protocol === "https:" };

  if (inSet(h, NEWS_HOSTS)) out.kind = "news";
  else if (inSet(h, LEADERBOARD_HOSTS)) out.kind = "leaderboard";
  else if (inSet(h, TERTIARY_HOSTS)) out.kind = "tertiary";
  else if (h === "arxiv.org") out.kind = "arxiv";
  else if (h === "github.com" || h === "huggingface.co") out.kind = "code";
  else if (!path || path === "/") out.kind = "bare";

  if (out.kind === "arxiv") Object.assign(out, readArxiv(u));

  // Which labs could publish here, decided by the rule this project already uses rather than a second one invented for descriptions. arxiv.org is allowed for every lab by that rule, so it never lands a lab claim and never triggers a mismatch, which is correct: a benchmark's own paper is a primary source no matter who cites it.
  if (labs && h !== "arxiv.org") {
    const claiming = labs.filter((l) => isOfficialSource(l, url)).map((l) => l.id);
    if (claiming.length) {
      out.labClaims = claiming;
      if (out.kind === "other" || out.kind === "code" || out.kind === "bare") out.kind = "lab";
      if (fact) out.labMismatch = !claiming.some((id) => fact.labs.has(id));
    }
  }
  if (fact && fact.release_urls.has(url)) out.isReleasePage = true;
  return out;
}

// arXiv identifiers are the most checkable thing a description can carry and the easiest to invent, because the format is short, regular and looks the same whether or not the paper exists. Three things can be said about one without a network: whether it is well formed, whether its month is real, and whether that month is before the benchmark was first cited. The third is the one that catches invention, because a lab cannot cite a paper that has not been written.
const ARXIV_NEW = /(?:abs|pdf|html)\/(\d{2})(\d{2})\.(\d{4,5})(v\d+)?/;
const ARXIV_OLD = /(?:abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?)\/(\d{2})(\d{2})(\d{3})/;

function readArxiv(u) {
  const m = ARXIV_NEW.exec(u.pathname);
  if (m) {
    const [, yy, mm] = m;
    return { arxiv: { id: `${yy}${mm}.${m[3]}`, yymm: `${yy}${mm}`, month: `20${yy}-${mm}`, wellFormed: Number(mm) >= 1 && Number(mm) <= 12 } };
  }
  const o = ARXIV_OLD.exec(u.pathname);
  if (o) return { arxiv: { id: `${o[1]}/${o[2]}${o[3]}${o[4]}`, yymm: `${o[2]}${o[3]}`, month: `${Number(o[2]) > 50 ? 19 : 20}${o[2]}-${o[3]}`, wellFormed: Number(o[3]) >= 1 && Number(o[3]) <= 12, legacy: true } };
  return { arxiv: { id: null, wellFormed: false } };
}

/** Whether the URL says anything about this particular benchmark.
 *
 *  A weak signal on purpose. An arXiv abstract URL contains no words at all and is a perfectly good source, so the absence of a lexical tie is never an error by itself. It earns its place in combination: a description with no lexical tie, no arXiv identifier and no lab claim is attached to a page that nothing in the data connects to the thing it is supposed to describe. */
export function urlMentionsName(src, fact) {
  if (!src || !src.url || !fact) return false;
  const hay = `${src.host ?? ""}${src.path ?? ""}${src.url.includes("?") ? src.url.slice(src.url.indexOf("?")) : ""}`
    .toLowerCase().replace(/[^a-z0-9]+/g, "");
  // The whole name flattened as well as its distinctive tokens, because the tokens alone miss the commonest case there is. "SWE-bench" reduces to the single token "swe", which is below the length bar that keeps two-letter fragments from matching everything, so swebench.com would read as a host with no connection to SWE-bench.
  const flat = fact.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (flat.length >= 5 && hay.includes(flat)) return true;
  return nameTokens(fact.name).some((t) => t.length >= 4 && hay.includes(t));
}

// ---------------------------------------------------------------------------
// Near-duplicate text

const shingles = (words, n = 4) => {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
};

/** Pairs of descriptions that are substantially the same text.
 *
 *  Mass invention does not produce 2,176 different lies. It produces one sentence with the name swapped, because the model has nothing benchmark-specific to say and the prompt still asks for a sentence. So the name is removed before comparing: leaving it in makes every pair look different for the one reason that never mattered.
 *
 *  Compared through an inverted index on shingles rather than all 2.4 million pairs, and shingles shared by more than `common` entries are skipped when collecting candidates, since a phrase that generic tells nothing apart. Both entries of a pair keep their full shingle set for the actual score, so the shortcut changes which pairs are looked at and not what any of them scores. */
export function nearDuplicates(items, { threshold = 0.6, common = 40 } = {}) {
  const sets = items.map((it) => shingles(WORDS(it.stripped)));
  const index = new Map();
  sets.forEach((s, i) => {
    for (const sh of s) {
      if (!index.has(sh)) index.set(sh, []);
      index.get(sh).push(i);
    }
  });

  const pairs = [];
  const seen = new Set();
  sets.forEach((s, i) => {
    if (s.size < 3) return;
    const candidates = new Set();
    for (const sh of s) {
      const bucket = index.get(sh);
      if (bucket.length > common) continue;
      for (const j of bucket) if (j > i) candidates.add(j);
    }
    for (const j of candidates) {
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const other = sets[j];
      let shared = 0;
      for (const sh of s) if (other.has(sh)) shared++;
      const jaccard = shared / (s.size + other.size - shared);
      if (jaccard >= threshold) pairs.push({ a: i, b: j, jaccard });
    }
  });
  return pairs.sort((x, y) => y.jaccard - x.jaccard);
}

/** Connected components over the near-duplicate pairs, largest first. A cluster of forty entries sharing one sentence is one finding for a reviewer to settle, not forty. */
export function duplicateClusters(pairs, size) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const p of pairs) parent[find(p.a)] = find(p.b);
  const groups = new Map();
  for (let i = 0; i < size; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Claims the registry can contradict

// What a description would have to say to be claiming a subject. Deliberately narrow: the words have to be doing the work of stating what the benchmark is about, because a mention in passing is not a claim. "A coding benchmark translated into Japanese" mentions two subjects and asserts one.
const CLAIM_CUES = [
  "benchmark for", "benchmark that", "benchmark measuring", "benchmark testing", "benchmark of", "suite for",
  "evaluates", "evaluating", "measures", "measuring", "tests", "testing", "assesses", "assessing", "focused on",
  "designed to test", "designed to measure", "dataset of", "dataset for", "tasks in", "questions about", "problems in",
];

// One unambiguous vocabulary per category. Words that belong to two categories are left out entirely, because a contradiction reported on an ambiguous word is a contradiction nobody will trust the second time.
const CATEGORY_WORDS = {
  coding: ["code", "coding", "programming", "software engineering", "pull request", "repository", "compiler", "unit test", "sql query", "debugging"],
  math: ["mathematic", "mathematical", "arithmetic", "algebra", "geometry", "theorem", "olympiad", "competition math"],
  speech: ["speech", "audio", "spoken", "transcription", "speech recognition", "text-to-speech", "voice"],
  vision: ["image", "images", "visual", "chart", "diagram", "ocr", "video frame", "screenshot", "photograph"],
  science: ["physics", "chemistry", "biology", "medical", "clinical", "molecular", "genomic"],
  safety: ["jailbreak", "refusal", "toxicity", "bias", "harmful", "red-team", "red team", "malware", "cyberattack"],
  multilingual: ["multilingual", "cross-lingual", "translation", "natural languages", "language pairs"],
  longctx: ["long context", "long-context", "needle in a haystack", "context window"],
  agentic: ["tool use", "tool-use", "web browsing", "gui", "computer use", "multi-step task", "function calling"],
  knowledge: ["factual recall", "trivia", "general knowledge", "hallucination"],
  reasoning: ["commonsense", "logical reasoning", "puzzle", "deductive"],
};

// Matched on word boundaries rather than as a substring. A raw indexOf found "gui" inside "psycholinguistic" and filed a text-generation bias set under agentic, and would equally find "ocr" inside "mediocre" and "bias" inside "unbiased". Built once, because this runs per word per category per description.
const WORD = new Map(
  Object.values(CATEGORY_WORDS).flat().map((w) => [w, new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)]),
);

/** Subjects the text asserts that the registry's own categories exclude.
 *
 *  Reported as a disagreement rather than a verdict, for the reason alias-gate.py gives for taking a second opinion: two independent judgements that differ is information, and neither one of them is the truth. classify.mjs is regex rules over a name and it puts 1,005 of 2,176 benchmarks in "other", which is not a claim about anything, so "other" can never contradict and roughly half the registry has no opinion to offer here. Where it does have one, a speech benchmark whose description is about code is either a wrong description or a wrong category, and both are worth a look. */
export function categoryContradictions(text, fact) {
  if (!text || !fact || !fact.categories.length) return [];
  const lower = text.toLowerCase();
  const known = new Set(fact.categories);
  if (known.has("other")) return [];
  const asserted = [];
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    if (known.has(cat)) continue;
    for (const w of words) {
      const at = lower.search(WORD.get(w));
      if (at < 0) continue;
      const before = lower.slice(Math.max(0, at - 60), at);
      if (CLAIM_CUES.some((cue) => before.includes(cue))) { asserted.push({ category: cat, word: w }); break; }
    }
  }
  return asserted;
}

// ---------------------------------------------------------------------------
// Small shared statistics

/** Wilson score interval, which is what makes a rate from eight observations readable.
 *
 *  The normal approximation gives 0 per cent plus or minus 0 when nothing in a small stratum fails, which is the one answer that is certainly wrong. Wilson never does that, and every rate in both scripts is computed from a cohort small enough for the difference to matter. */
export function wilson(successes, n, z = 1.96) {
  if (!n) return { p: 0, lo: 0, hi: 1, n: 0 };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n };
}

/** Deterministic PRNG, so the same seed pulls the same sample twice.
 *
 *  A sample a second reviewer cannot reproduce is a sample whose disagreements cannot be told from a different draw. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const pct = (x) => `${(100 * x).toFixed(1)}%`;

export function loadLabs() {
  return read(join(DATA, "labs.json"));
}
