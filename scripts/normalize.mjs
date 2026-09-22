#!/usr/bin/env node
// Builds the two generated files the site loads from the per-lab research files.
//
// Researchers write benchmark names exactly as the lab printed them. All the
// reconciling happens here, which is why twelve of them can work at once without
// ever writing to a shared file.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { CATEGORIES, classify, flatKey, suiteOf } from "./classify.mjs";
import { isOfficialSource, describeAllowed } from "./sources.mjs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const labs = read(join(DATA, "labs.json"));
const aliases = read(join(DATA, "aliases.json"));
const suiteDefs = read(join(DATA, "suites.json")).suites;
const catOverrides = read(join(DATA, "categories.json")).overrides;
const excluded = read(join(DATA, "excluded.json"));
const labIds = new Set(labs.map((l) => l.id));
const labById = new Map(labs.map((l) => [l.id, l]));

// Lookup key: lowercase and drop every separator. Labs spell the same
// benchmark as IFEval, IF-Eval and IF Eval, so anything that merely collapses
// punctuation to a space still treats those as three benchmarks and splits the
// adoption count three ways. Removing separators entirely folds all 130 such
// groups in this dataset, and no two genuinely different benchmarks in it
// differ only by where the spaces fall.
//
// It does not fold semantic variants: AIME 2024 and AIME24 are distinct keys
// and need an entry in aliases.json to merge, which is the right place for a
// judgement call about whether they are the same thing.
// One key, shared with the suite matcher and the category overrides, so the
// four places that decide whether two spellings are the same benchmark cannot
// drift apart. It also folds a trailing four-digit year to its two-digit form,
// so AIME 2026 and AIME26, HMMT Feb. 2025 and HMMT Feb 25, meet; and it
// transliterates Greek and superscripts, so tau squared keeps the part of its
// name that distinguishes it. See classify.mjs for why both matter.
const key = flatKey;

// Third-party composite indices are dropped rather than tracked: a lab citing
// one is not reporting a benchmark, it is citing somebody else's ranking.
// Patterns are written readably with spaces in the data file, so they go
// through the same key function as the names they are matched against.
// Skipping that is what silently switched the exclusions off when the key
// stopped preserving word breaks.
const excludePatterns = excluded.patterns.map((p) => key(p.match));
const isExcluded = (k) => excludePatterns.some((pat) => k.includes(pat));

const aliasByKey = new Map(
  Object.entries(aliases)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => [key(k), v]),
);

let dropped = 0;
// Raw spelling counts per canonical id. Done here because this is the only
// place the pairing is exact: the canonical list is deduped and filtered, so
// zipping it against benchmarks_raw by index downstream is simply wrong.
const spellings = new Map();
const problems = [];
const TODAY = new Date().toISOString().slice(0, 10);
const seenIds = new Set();
const duplicateIds = [];
const unknown = new Map();
const releases = [];

const dir = join(DATA, "releases");
const files = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  : [];

for (const file of files) {
  const path = join(dir, file);
  let records;
  try {
    records = read(path);
  } catch (err) {
    problems.push(`${file}: not valid JSON (${err.message})`);
    continue;
  }
  if (!Array.isArray(records)) {
    problems.push(`${file}: expected an array of release records`);
    continue;
  }

  for (const r of records) {
    const where = `${file} ${r.id ?? "<no id>"}`;
    if (!labIds.has(r.lab)) problems.push(`${where}: unknown lab "${r.lab}"`);
    // A malformed date is fatal to this record, not just noted. It used to be
    // recorded and carried on: "2026-9-5" is schema-valid output, sorts after
    // "2026-09-20" under localeCompare, became the upper bound of the quarters
    // loop, and that loop has no termination but reaching it. Five million
    // iterations in 106ms, and the diagnostic naming the bad date sat twenty
    // lines past the loop that never ended.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "")) {
      problems.push(`${where}: bad date "${r.date}"`);
      continue;
    }
    // Nor may a record be dated ahead of the run. A future date sorts last,
    // enters the recent window, pushes a real quarter out of it, and stretches
    // the quarter axis the chart draws.
    if (r.date > TODAY) {
      problems.push(`${where}: date "${r.date}" is in the future`);
      continue;
    }
    // Provenance is a contract term, not a hint. The site opens source_url in a
    // new tab when a mark is clicked and the footer promises it is the lab's own
    // page, so a URL pointing anywhere else is a claim this project cannot make.
    // The research agent reads attacker-publishable pages (arxiv.org is open to
    // everyone and reachable for every lab), and the search allowlist constrains
    // what it may read rather than what it may write down, so this is the only
    // place the written value is actually checked. See scripts/sources.mjs.
    const lab = labById.get(r.lab);
    if (!/^https:\/\//.test(r.source_url ?? "")) {
      problems.push(`${where}: source_url must be an https URL, got "${r.source_url}"`);
    } else if (lab && !isOfficialSource(lab, r.source_url)) {
      problems.push(`${where}: source_url "${r.source_url}" is not published by ${lab.name}. Allowed: ${describeAllowed(lab)}`);
    }
    if (!Array.isArray(r.benchmarks_raw)) {
      problems.push(`${where}: benchmarks_raw must be an array`);
      continue;
    }
    // Scores are out of scope by design, so a stray number is a contract breach.
    for (const b of r.benchmarks_raw) {
      if (typeof b !== "string") problems.push(`${where}: benchmark entries must be strings`);
      // Only a percentage or an explicit "name: 88.7" reads as a score. An
      // earlier version also rejected any trailing decimal, which flagged every
      // versioned benchmark ("Terminal-Bench 2.0") and pushed a researcher into
      // rewriting real names to get past it. Versions never carry % or a colon.
      else if (/\d\s*%|[:=]\s*\d/.test(b)) problems.push(`${where}: "${b}" looks like a score`);
    }

    const canonical = [...new Set(r.benchmarks_raw
      .filter((raw) => {
        if (!isExcluded(key(raw))) return true;
        dropped += 1;
        return false;
      })
      .map((raw) => {
        const k = key(raw);
        const id = aliasByKey.get(k) ?? k;   // provisional id until an alias is added
        if (!aliasByKey.has(k)) unknown.set(k, (unknown.get(k) ?? 0) + 1);
        const tally = spellings.get(id) ?? new Map();
        tally.set(raw, (tally.get(raw) ?? 0) + 1);
        spellings.set(id, tally);
        return id;
      }))];

    // Ids are minted from lab, model and date, so one launch mirrored across a
    // blog, a repo and a model card yields three records with one id. They were
    // deduplicated on source_url alone, which treats mirrors as separate
    // releases and inflates the denominator of every recent-share figure.
    if (seenIds.has(r.id)) {
      duplicateIds.push(`${where}: duplicate id, mirrored at ${r.source_url}`);
      continue;
    }
    seenIds.add(r.id);
    releases.push({ ...r, benchmarks: canonical });
  }
}

// Everything is read and checked before anything is written. The generated
// files used to be written first and validated after, so a failing run left
// benchmarks.json and timeline.json on disk built from data that had just been
// rejected. CI discards its workspace so it never noticed; a local run kept
// them.
if (problems.length) {
  console.error(`\n${problems.length} contract problem(s), nothing written:`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  process.exit(1);
}

releases.sort((a, b) => a.date.localeCompare(b.date) || a.lab.localeCompare(b.lab));

const quarterOf = (iso) => `${iso.slice(0, 4)}-Q${Math.floor(Number(iso.slice(5, 7) - 1) / 3) + 1}`;

// Benchmark registry: who cited it, when it first and last appeared, and the
// per-quarter lab count that drives the trend view. Quarters rather than years
// because four points is not an arc; fifteen shows the rise and the drop-off.
const registry = new Map();
for (const r of releases) {
  const year = r.date.slice(0, 4);
  for (const id of r.benchmarks) {
    if (!registry.has(id)) {
      registry.set(id, { id, name: id, labs: new Set(), first_seen: r.date, last_seen: r.date, by_year: {}, by_quarter: {} });
    }
    const e = registry.get(id);
    e.labs.add(r.lab);
    if (r.date < e.first_seen) e.first_seen = r.date;
    if (r.date > e.last_seen) e.last_seen = r.date;
    (e.by_year[year] ??= new Set()).add(r.lab);
    (e.by_quarter[quarterOf(r.date)] ??= new Set()).add(r.lab);
  }
}

// How central a benchmark is to a recent release, as opposed to how many labs
// have ever mentioned it.
//
// The lab count answers breadth and nothing else: AIME 2024 has all twelve, yet
// it appears in 8 per cent of their releases because everyone named it once
// when it was new. MATH has eleven labs and 18 per cent, because labs cite it
// out of habit. Those are different facts and the first number cannot carry the
// second.
//
// It is a share and not a count, deliberately. Releases per quarter grew 4.5x
// across this dataset, so a raw model count would show a benchmark with
// perfectly flat adoption rising ninefold, and every line on the page would
// trend upward for no reason but the industry shipping more. A share is immune
// to that, and to one lab publishing ten times as often as another: it is the
// mean over labs that shipped, of the fraction of that lab's releases citing
// the benchmark, so a prolific lab cannot outvote a quiet one.
//
// The window is the last four COMPLETE quarters. The current one is still
// filling and would read low for everything.
const RECENT_Q = 4;
const nowQuarter = quarterOf(new Date().toISOString().slice(0, 10));
const completeQuarters = [...new Set(releases.map((r) => quarterOf(r.date)))]
  .filter((q) => q !== nowQuarter).sort();
const recentWindow = new Set(completeQuarters.slice(-RECENT_Q));
const shipped = new Map();   // lab -> releases in the window
const cited = new Map();     // benchmark id -> Map(lab -> releases citing it)
for (const r of releases) {
  if (!recentWindow.has(quarterOf(r.date))) continue;
  shipped.set(r.lab, (shipped.get(r.lab) ?? 0) + 1);
  for (const b of new Set(r.benchmarks)) {
    const m = cited.get(b) ?? new Map();
    m.set(r.lab, (m.get(r.lab) ?? 0) + 1);
    cited.set(b, m);
  }
}
/** Mean over labs that shipped in the window of the share of their releases
 *  citing any of `ids`. A lab that shipped and never cited it contributes zero,
 *  which is the point: silence is data. */
// Published with the numbers it produces. A share of "recent" releases means
// nothing without the window, and the window moves every time this runs, so it
// is emitted rather than written into the copy by hand.
const recentQuarters = [...recentWindow].sort();
const inWindow = releases.filter((r) => recentWindow.has(quarterOf(r.date)));
const recent_window = {
  quarters: recentQuarters,
  months: recentQuarters.length * 3,
  from: inWindow.length ? inWindow.reduce((a, r) => (r.date < a ? r.date : a), inWindow[0].date) : null,
  to: inWindow.length ? inWindow.reduce((a, r) => (r.date > a ? r.date : a), inWindow[0].date) : null,
  releases: inWindow.length,
};

const recentShare = (ids) => {
  if (!shipped.size) return 0;
  let total = 0;
  for (const [lab, n] of shipped) {
    let hits = 0;
    for (const id of ids) hits += cited.get(id)?.get(lab) ?? 0;
    total += Math.min(1, hits / n);
  }
  return Math.round((total / shipped.size) * 100);
};

const benchmarks = [...registry.values()]
  .map((e) => ({
    id: e.id,
    // The spelling labs used most often, which reads better than a slug.
    name: [...(spellings.get(e.id) ?? new Map([[e.id, 1]]))]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
    lab_count: e.labs.size,
    labs: [...e.labs].sort(),
    first_seen: e.first_seen,
    last_seen: e.last_seen,
    labs_by_year: Object.fromEntries(
      Object.entries(e.by_year).sort().map(([y, s]) => [y, s.size]),
    ),
    labs_by_quarter: Object.fromEntries(
      Object.entries(e.by_quarter).sort().map(([q, s]) => [q, s.size]),
    ),
  }))
  // The display name is whichever spelling labs used most, so merging an
  // abbreviation into a benchmark can change it: aliasing SWE-agentless onto
  // SWE-Bench (AgentLess) made the shorter form win the tie, and the merged
  // entry fell out of the SWE-bench suite because the winning name no longer
  // contains "swebench". A suite's lab count moved because of a tie-break.
  //
  // So a suite is resolved against every spelling, longest first. Suite
  // patterns are curated stems, so a spurious match is unlikely and a missed
  // one costs a whole family its grouping.
  //
  // Categories are not treated the same way, because there the failure runs the
  // other direction: a mangled spelling can win a confident wrong label. The
  // display name decides, and only if it yields Other does a fuller spelling
  // get a say. "OpenAIMod" appears once in the data and matched a math rule
  // inside its own letters, which was enough to file a content moderation
  // dataset under Math when any spelling could win.
  .map((b) => {
    const forms = [...new Set([b.name, ...(spellings.get(b.id) ?? new Map()).keys()])]
      .sort((x, y) => y.length - x.length);
    const suite = forms.map((n) => suiteOf(n, suiteDefs)).find(Boolean) ?? null;
    const own = classify(b.name, catOverrides);
    const cats = own[0] !== "other" ? own
      : forms.filter((n) => n.length > b.name.length)
          .map((n) => classify(n, catOverrides)).find((c) => c[0] !== "other") ?? own;
    return { ...b, categories: cats, suite, recent_share: recentShare([b.id]) };
  })
  .sort((a, b) => b.lab_count - a.lab_count || a.id.localeCompare(b.id));

writeFileSync(join(DATA, "benchmarks.json"), JSON.stringify(benchmarks, null, 2) + "\n");

// A suite is only worth showing if more than one benchmark joined it: a suite
// of one is the benchmark, and a row for it would double the same line.
const suites = suiteDefs
  .map((s) => {
    const members = benchmarks.filter((b) => b.suite === s.id);
    const labs = new Set(members.flatMap((m) => m.labs));
    // Union the lab sets, do not combine the counts. A suite's quarter is the
    // number of DISTINCT labs that cited any of its members, so two labs on two
    // different versions is two. Taking the maximum across members would have
    // called that one, which is the number nobody wanted.
    const sets = {};
    for (const m of members) {
      const e = registry.get(m.id);
      for (const [q, labSet] of Object.entries(e.by_quarter)) {
        sets[q] ??= new Set();
        for (const l of labSet) sets[q].add(l);
      }
    }
    const by_quarter = Object.fromEntries(Object.entries(sets).sort().map(([q, v]) => [q, v.size]));
    return { id: s.id, name: s.name, members: members.length, lab_count: labs.size, labs: [...labs].sort(), labs_by_quarter: by_quarter, recent_share: recentShare(members.map((m) => m.id)) };
  })
  .filter((s) => s.members > 1)
  .sort((a, b) => b.lab_count - a.lab_count);

// Category aggregates, on the same distinct-lab footing. A benchmark may carry
// two categories and a lab is counted once in each, which is why these do not
// sum to the citation total and were never meant to.
const categories = CATEGORIES.map((c) => {
  const members = benchmarks.filter((b) => b.categories.includes(c.id));
  const labs = new Set(members.flatMap((m) => m.labs));
  const sets = {};
  for (const m of members) {
    for (const [q, labSet] of Object.entries(registry.get(m.id).by_quarter)) {
      sets[q] ??= new Set();
      for (const l of labSet) sets[q].add(l);
    }
  }
  return {
    id: c.id, name: c.name, blurb: c.blurb, members: members.length,
    lab_count: labs.size, labs: [...labs].sort(),
    labs_by_quarter: Object.fromEntries(Object.entries(sets).sort().map(([q, v]) => [q, v.size])),
    recent_share: recentShare(members.map((m) => m.id)),
  };
}).filter((c) => c.members > 0);
const quarters = [];
if (releases.length) {
  const [lo, hi] = [quarterOf(releases[0].date), quarterOf(releases[releases.length - 1].date)];
  // Bounded. Reaching `hi` is the intended exit, but it is not the only one:
  // the loop must terminate even if `hi` is unreachable, because a loop whose
  // only stop condition is a value derived from data is a hang waiting for bad
  // data. Two hundred quarters is fifty years.
  const MAX_QUARTERS = 200;
  for (let y = Number(lo.slice(0, 4)), q = Number(lo.slice(6)); quarters.length < MAX_QUARTERS; q === 4 ? ((q = 1), y++) : q++) {
    quarters.push(`${y}-Q${q}`);
    if (`${y}-Q${q}` === hi) break;
  }
  if (quarters[quarters.length - 1] !== hi) problems.push(`quarters: ran from ${lo} without reaching ${hi}`);
}

writeFileSync(
  join(DATA, "timeline.json"),
  JSON.stringify({ generated_at: new Date().toISOString(), labs, releases, benchmarks, quarters, categories, suites, recent_window }, null, 2) + "\n",
);

console.log(`releases ${releases.length} · benchmarks ${benchmarks.length} · labs with data ${new Set(releases.map((r) => r.lab)).size}/${labs.length} · excluded citations ${dropped}`);

if (unknown.size) {
  console.log(`\nBenchmark names with no alias entry (${unknown.size}). Add the real ones to data/aliases.json:`);
  for (const [k, n] of [...unknown].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}x  ${k}`);
}
if (duplicateIds.length) {
  console.log(`\nSkipped ${duplicateIds.length} mirrored record(s) sharing an id with one already read:`);
  for (const d of duplicateIds.slice(0, 10)) console.log(`  ${d}`);
}
