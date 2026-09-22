#!/usr/bin/env node
// Builds the two generated files the site loads from the per-lab research files.
//
// Researchers write benchmark names exactly as the lab printed them. All the
// reconciling happens here, which is why twelve of them can work at once without
// ever writing to a shared file.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { CATEGORIES, classify, flatKey, suiteOf } from "./classify.mjs";
import { MODALITIES, isValidModality, describeModality } from "./modality.mjs";
import { isOfficialSource, describeAllowed } from "./sources.mjs";
import { checkDescriptions, siteDescriptions } from "./descriptions.mjs";
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
// The four kinds the interface knows how to label. The TypeScript union is a
// compile-time claim about data the build never checked, and kind is written
// by the research agent and rendered into the page, so an unrecognised value
// reached the DOM on the strength of a type that does not exist at runtime.
const KINDS = new Set(["model_release", "technical_report", "system_card", "blog_post"]);
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
    // Absent is fine and means nobody has classified this release yet. Present
    // and malformed is not, because the filter built on it would quietly show
    // the wrong set rather than fail.
    if (!isValidModality(r.modality)) {
      problems.push(`${where}: modality must be absent, or {classes: [${describeModality()}], source: "reported"|"inferred"}`);
    }
    if (!KINDS.has(r.kind)) {
      problems.push(`${where}: kind "${r.kind}" is not one of ${[...KINDS].join(", ")}`);
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

// Benchmark descriptions, checked against the registry that was just built rather than against the raw records, because the one thing that can make a well-formed entry wrong is the id it is filed under. Absent is fine and means scripts/describe.mjs has not run. See scripts/descriptions.mjs for the rules and for why a refusal is a first-class result rather than an error.
//
// A contract rather than a hint, on the same footing as source_url. The panel prints the text as a statement of what a benchmark measures and offers source_url as the page it came from, so a researched entry with no URL is an unsourced claim wearing this project's word for it, and an entry filed under an id nothing resolves is a description the site can never show and the pass will keep paying to rewrite.
const descPath = join(DATA, "descriptions.json");
const descriptions = existsSync(descPath) ? read(descPath) : {};
problems.push(...checkDescriptions(descriptions, {
  ids: new Set(benchmarks.map((b) => b.id)),
  aliasByKey,
  today: TODAY,
}));

// The quarter walk above is the last thing that can fail, and until now its
// diagnostic was pushed onto a list nobody read again: the guard sits two
// hundred lines up, so an unreachable end quarter was recorded and then
// published. Checked once more here, where every producer has run and nothing
// has yet been written.
if (problems.length) {
  console.error(`\n${problems.length} contract problem(s), nothing written:`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  process.exit(1);
}

// benchmarks.json is the full registry and stays readable: it is the file a
// person or another project reads, and nothing on the site loads it.
writeFileSync(join(DATA, "benchmarks.json"), JSON.stringify(benchmarks, null, 2) + "\n");

// The three files the site loads are built for the browser rather than for a reader, so they carry only the fields the interface actually renders and are written without indentation. Pretty-printing timeline.json cost 658 kB of whitespace, which the browser downloaded and parsed to no effect.
//
// They are split by what each screen needs. The chart and the picker draw from the registry alone, so timeline.json is the only one on the path to first paint. The release log grows forever and is read two screens down. The descriptions are read only when somebody opens a detail panel, and at 2,176 entries they are most of a registry's worth of bytes for a panel most visits never open, so they are fetched on that click and not before.
const site = (value) => JSON.stringify(value) + "\n";

// Benchmark ids inside the log are positions in the registry array, not
// strings. The same few thousand ids were repeated across every release and
// came to a third of the log on their own. The two files are generated
// together and served together, so the positions cannot drift apart.
const indexOfBenchmark = new Map(benchmarks.map((b, i) => [b.id, i]));

writeFileSync(
  join(DATA, "release-log.json"),
  site(releases.map((r) => ({
    lab: r.lab,
    model: r.model,
    date: r.date,
    kind: r.kind,
    source_url: r.source_url,
    benchmarks: r.benchmarks.map((id) => indexOfBenchmark.get(id)),
    // Flattened to the classes alone, and omitted entirely when unknown. The
    // log is the largest thing the page fetches, so an unclassified release
    // should cost nothing rather than carry a null. Provenance stays in
    // data/releases, where a maintainer can see it; the interface only needs
    // to know how many are classified, which it counts from what arrives.
    ...(r.modality ? { modality: r.modality.classes } : {}),
  }))),
);

// Its own asset, deliberately not a field in timeline.json. The registry is already 41 kB gzipped on the critical path and the descriptions are about the same again, for a panel that opens on a click and on many visits never opens at all.
//
// Keyed by benchmark id, so the interface looks one up without an index, and carrying only text and source_url: a refusal has nothing to render and the pass's own bookkeeping means nothing to a reader, so an id absent from this file is simply an id with no description. See siteDescriptions in scripts/descriptions.mjs.
const described = siteDescriptions(descriptions);
writeFileSync(join(DATA, "descriptions-site.json"), site(described));

writeFileSync(
  join(DATA, "timeline.json"),
  site({
    generated_at: new Date().toISOString(),
    // The classes actually present, with how many releases each covers, so the
    // interface offers a scope only where there is something behind it and can
    // say how much before a reader spends a click finding out. Emitted rather
    // than imported from modality.mjs, because the question the control has to
    // answer is what is in this dataset, not what the taxonomy allows.
    // What share of releases carry a modality. Emitted so the interface can
    // decide whether to offer the scope control without waiting for the log:
    // deciding it later meant the control appeared after first paint and
    // pushed the page down, which was a 0.052 layout shift for a row of chips
    // that could have been there from the start.
    modality_coverage: releases.length ? releases.filter((r) => r.modality).length / releases.length : 0,
    modalities: MODALITIES
      .map((m) => ({ ...m, releases: releases.filter((r) => r.modality?.classes.includes(m.id)).length }))
      .filter((m) => m.releases > 0)
      .sort((a, b) => b.releases - a.releases),
    labs: labs.map((l) => ({ id: l.id, name: l.name })),
    benchmarks: benchmarks.map((b) => ({
      id: b.id, name: b.name, lab_count: b.lab_count,
      labs_by_quarter: b.labs_by_quarter, categories: b.categories,
      suite: b.suite, recent_share: b.recent_share,
    })),
    quarters,
    categories: categories.map((c) => ({
      id: c.id, name: c.name, members: c.members,
      lab_count: c.lab_count, labs_by_quarter: c.labs_by_quarter, recent_share: c.recent_share,
    })),
    suites: suites.map((s) => ({
      id: s.id, name: s.name, members: s.members,
      lab_count: s.lab_count, labs_by_quarter: s.labs_by_quarter, recent_share: s.recent_share,
    })),
    recent_window,
    // Enough about the log for the site to size the timeline and date its copy
    // without waiting for the log itself to arrive.
    release_log: { count: releases.length, first: releases.length ? releases[0].date : null },
    // Two numbers, not the descriptions themselves: how many benchmarks have one, and how many were looked for and not found. The same job modality_coverage does for the scope control. It lets the interface decide at first paint whether a detail panel is worth offering, without fetching a file most visits will not need, and it lets the page say "no description found" rather than "loading" for an id it already knows was searched for.
    descriptions: { described: Object.keys(described).length, refused: Object.values(descriptions).filter((d) => d.source === "none").length },
  }),
);

console.log(`releases ${releases.length} · benchmarks ${benchmarks.length} · labs with data ${new Set(releases.map((r) => r.lab)).size}/${labs.length} · excluded citations ${dropped}`);
// Coverage, on every run, because a filter over a partly classified set is a
// filter that quietly hides releases nobody decided to hide. The interface
// keeps the control out of sight until this is worth offering.
const classified = releases.filter((r) => r.modality).length;
console.log(`modality: ${classified}/${releases.length} releases classified (${Math.round((classified / releases.length) * 100)}%)`);
// Coverage and the refusal rate together, because neither means anything alone. A pass that describes everything it touches has stopped refusing rather than found the long tail easy, and three quarters of this registry is cited by exactly one lab, so a low refusal rate is the number to be suspicious of. Printed on every build for the same reason modality coverage is: a panel filled from a partly described registry is a panel that quietly shows nothing for ids nobody decided to leave out.
const refusedCount = Object.values(descriptions).filter((d) => d.source === "none").length;
const attempted = Object.keys(described).length + refusedCount;
const share = (n, d) => (d ? Math.round((n / d) * 100) : 0);
console.log(
  `descriptions: ${Object.keys(described).length}/${benchmarks.length} benchmarks described (${share(Object.keys(described).length, benchmarks.length)}%) · ` +
  `${refusedCount} refused of ${attempted} attempted (${share(refusedCount, attempted)}% refusal rate) · ` +
  `${benchmarks.length - attempted} never tried`);

if (unknown.size) {
  console.log(`\nBenchmark names with no alias entry (${unknown.size}). Add the real ones to data/aliases.json:`);
  for (const [k, n] of [...unknown].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}x  ${k}`);
}
if (duplicateIds.length) {
  console.log(`\nSkipped ${duplicateIds.length} mirrored record(s) sharing an id with one already read:`);
  for (const d of duplicateIds.slice(0, 10)) console.log(`  ${d}`);
}
