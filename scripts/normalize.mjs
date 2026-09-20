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
const labIds = new Set(labs.map((l) => l.id));

// Lookup key: lowercase, punctuation to spaces, collapse runs. "SWE-bench
// Verified" and "SWE bench verified" therefore need only one alias entry.
const key = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

const aliasByKey = new Map(
  Object.entries(aliases)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => [key(k), v]),
);

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

    const canonical = [...new Set(r.benchmarks_raw.map((raw) => {
      const k = key(raw);
      const hit = aliasByKey.get(k);
      if (hit) return hit;
      unknown.set(k, (unknown.get(k) ?? 0) + 1);
      return k.replace(/\s+/g, "-");   // provisional id until an alias is added
    }))];

    releases.push({ ...r, benchmarks: canonical });
  }
}

releases.sort((a, b) => a.date.localeCompare(b.date) || a.lab.localeCompare(b.lab));

// Benchmark registry: who cited it, when it first and last appeared, and the
// per-year lab count that drives the trend view.
const registry = new Map();
for (const r of releases) {
  const year = r.date.slice(0, 4);
  for (const id of r.benchmarks) {
    if (!registry.has(id)) {
      registry.set(id, { id, name: id, labs: new Set(), first_seen: r.date, last_seen: r.date, by_year: {} });
    }
    const e = registry.get(id);
    e.labs.add(r.lab);
    if (r.date < e.first_seen) e.first_seen = r.date;
    if (r.date > e.last_seen) e.last_seen = r.date;
    (e.by_year[year] ??= new Set()).add(r.lab);
  }
}

const benchmarks = [...registry.values()]
  .map((e) => ({
    id: e.id,
    name: e.name,
    lab_count: e.labs.size,
    labs: [...e.labs].sort(),
    first_seen: e.first_seen,
    last_seen: e.last_seen,
    labs_by_year: Object.fromEntries(
      Object.entries(e.by_year).sort().map(([y, s]) => [y, s.size]),
    ),
  }))
  .sort((a, b) => b.lab_count - a.lab_count || a.id.localeCompare(b.id));

writeFileSync(join(DATA, "benchmarks.json"), JSON.stringify(benchmarks, null, 2) + "\n");
writeFileSync(
  join(DATA, "timeline.json"),
  JSON.stringify({ generated_at: new Date().toISOString(), labs, releases, benchmarks }, null, 2) + "\n",
);

console.log(`releases ${releases.length} · benchmarks ${benchmarks.length} · labs with data ${new Set(releases.map((r) => r.lab)).size}/${labs.length}`);

if (unknown.size) {
  console.log(`\nBenchmark names with no alias entry (${unknown.size}). Add the real ones to data/aliases.json:`);
  for (const [k, n] of [...unknown].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}x  ${k}`);
}
if (problems.length) {
  console.error(`\n${problems.length} contract problem(s):`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  process.exit(1);
}
