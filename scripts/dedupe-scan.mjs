// Duplicate candidates found from the descriptions, for scripts/alias-gate.py to rule on.
//
// The registry deduplicates on names, because until now a name was all it had. flatKey folds punctuation, spacing, casing and version notation, and aliases.json handles the rest by hand. That catches "Terminal-Bench (v2.1)" against "Terminal-Bench 2.1" and misses everything whose two spellings share no letters, which is most of the interesting cases: OCRB against OCRBench, WinoG against WinoGrande, MathV against MathVista.
//
// Every described benchmark now carries the page it was read from, and that is a second, independent signal. Two rows citing the same page are either one benchmark written twice or two parts of one thing, and those are exactly the two outcomes alias-gate.py separates. The descriptions themselves then supply the evidence it rules on, which matters more than it sounds: asked about ARC-Challenge against ARC on the names alone, the gate answered "same name" at 0.99 and would have merged the hard partition into its own parent. Given both descriptions, one saying "partitioned into an Easy set and a Challenge set" and the other "the Challenge split", the same question comes back "version" at 0.77 and routes to the suite file instead.
//
// Emits gate input on stdout. Applies nothing: a merge rewrites lab_count, first_seen and labs for two benchmarks and normalize.mjs cannot detect a wrong one, so writing stays a separate, reviewed step.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const descriptions = read("data/descriptions.json");
const registry = read("data/benchmarks.json");
const rows = Array.isArray(registry) ? registry : registry.benchmarks ?? Object.values(registry);
const info = new Map(rows.map((r) => [r.id, r]));

/** Letters and digits only, for asking whether one name sits inside the other. */
const bare = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Two descriptions that say the same thing, measured on content words so that wording differences do not hide a repeat. */
const shingles = (t) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);
const overlap = (a, b) => {
  const [x, y] = [shingles(a), shingles(b)];
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const w of x) if (y.has(w)) hit++;
  return hit / Math.min(x.size, y.size);
};

// A page that introduces a whole family is not evidence that its members are each other. SAM's paper is cited by 23 of its own datasets, and pairing those is 253 questions with one answer. The cap keeps a source that genuinely defines one benchmark, or a handful of its splits, and drops the survey papers.
const MAX_PER_SOURCE = 14;
// Enough shared content words that two descriptions are saying one thing.
const MIN_OVERLAP = 0.75;

const bySource = new Map();
for (const [id, e] of Object.entries(descriptions)) {
  if (!e.source_url || !info.has(id)) continue;
  if (!bySource.has(e.source_url)) bySource.set(e.source_url, []);
  bySource.get(e.source_url).push(id);
}

/** Candidate pairs, each as [smaller, larger] so the merge direction folds the lesser-cited name into the better-known one. */
const pairs = new Map();
const add = (a, b, why) => {
  const [lo, hi] = (info.get(a).labs?.length ?? 0) <= (info.get(b).labs?.length ?? 0) ? [a, b] : [b, a];
  const k = `${lo}\u0000${hi}`;
  if (!pairs.has(k)) pairs.set(k, { lo, hi, why: new Set() });
  pairs.get(k).why.add(why);
};

for (const [, ids] of bySource) {
  if (ids.length < 2 || ids.length > MAX_PER_SOURCE) continue;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i], ids[j]];
      const [na, nb] = [bare(info.get(a).name), bare(info.get(b).name)];
      // One name inside the other, or two descriptions saying the same thing. Either is reason enough to ask; neither is reason enough to merge.
      if (na.includes(nb) || nb.includes(na)) add(a, b, "same source, one name contains the other");
      else if (overlap(descriptions[a].text ?? "", descriptions[b].text ?? "") >= MIN_OVERLAP) add(a, b, "same source, near-identical descriptions");
    }
  }
}

// Repeated wording across different sources catches the case where two agents found two pages for one benchmark.
const described = Object.entries(descriptions).filter(([id, e]) => e.text && info.has(id));
for (let i = 0; i < described.length; i++) {
  for (let j = i + 1; j < described.length; j++) {
    const [a, ea] = described[i], [b, eb] = described[j];
    if (ea.source_url === eb.source_url) continue;
    const [na, nb] = [bare(info.get(a).name), bare(info.get(b).name)];
    if (!na.includes(nb) && !nb.includes(na)) continue;
    if (overlap(ea.text, eb.text) >= MIN_OVERLAP) add(a, b, "different sources, near-identical descriptions");
  }
}

const say = (id) => {
  const e = descriptions[id];
  return e?.text ? `"${info.get(id).name}" is described as: ${e.text}` : `"${info.get(id).name}" has no description.`;
};

const out = [...pairs.values()].map(({ lo, hi, why }) => {
  const shared = descriptions[lo]?.source_url === descriptions[hi]?.source_url ? `Both cite the same source page, ${descriptions[lo].source_url}. ` : "";
  return {
    raw: info.get(lo).name,
    tracked: info.get(hi).name,
    // The descriptions are the evidence, and passing them is the whole reason this scan works. A reason that only says the names look alike gets an answer about names.
    reason: `${shared}${say(lo)} ${say(hi)} Found by scanning descriptions: ${[...why].join("; ")}.`,
    lab: info.get(lo).labs?.[0] ?? "unknown",
    _ids: [lo, hi],
  };
});

process.stderr.write(`${out.length} candidate pairs from ${rows.length} benchmarks\n`);
process.stdout.write(JSON.stringify(out, null, 2));
