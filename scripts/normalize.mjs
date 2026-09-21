#!/usr/bin/env node
// Builds the two generated files the site loads from the per-lab research files.
//
// Researchers write benchmark names exactly as the lab printed them. All the
// reconciling happens here, which is why twelve of them can work at once without
// ever writing to a shared file.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const labs = read(join(DATA, "labs.json"));
const aliases = read(join(DATA, "aliases.json"));
const excluded = read(join(DATA, "excluded.json"));
const labIds = new Set(labs.map((l) => l.id));

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
const key = (s) => {
  const flat = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  // A trailing four-digit year folds to its two-digit form, so AIME 2026 and
  // AIME26, HMMT Feb. 2025 and HMMT Feb 25, meet. Anchored to 20xx and to the
  // end of the name, so a benchmark numbered 1000 or 500 is untouched. This is
  // a rule rather than eight alias entries because the pattern recurs every
  // January, and an alias file would need a new line each time.
  return flat.replace(/20(\d\d)$/, "$1");
};

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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "")) problems.push(`${where}: bad date "${r.date}"`);
    if (!/^https?:\/\//.test(r.source_url ?? "")) problems.push(`${where}: missing source_url`);
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

    releases.push({ ...r, benchmarks: canonical });
  }
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
  .sort((a, b) => b.lab_count - a.lab_count || a.id.localeCompare(b.id));

writeFileSync(join(DATA, "benchmarks.json"), JSON.stringify(benchmarks, null, 2) + "\n");
const quarters = [];
if (releases.length) {
  const [lo, hi] = [quarterOf(releases[0].date), quarterOf(releases[releases.length - 1].date)];
  for (let y = Number(lo.slice(0, 4)), q = Number(lo.slice(6)); ; q === 4 ? ((q = 1), y++) : q++) {
    quarters.push(`${y}-Q${q}`);
    if (`${y}-Q${q}` === hi) break;
  }
}

writeFileSync(
  join(DATA, "timeline.json"),
  JSON.stringify({ generated_at: new Date().toISOString(), labs, releases, benchmarks, quarters }, null, 2) + "\n",
);

console.log(`releases ${releases.length} · benchmarks ${benchmarks.length} · labs with data ${new Set(releases.map((r) => r.lab)).size}/${labs.length} · excluded citations ${dropped}`);

if (unknown.size) {
  console.log(`\nBenchmark names with no alias entry (${unknown.size}). Add the real ones to data/aliases.json:`);
  for (const [k, n] of [...unknown].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}x  ${k}`);
}
if (problems.length) {
  console.error(`\n${problems.length} contract problem(s):`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  process.exit(1);
}
