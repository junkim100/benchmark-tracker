// Types and the few derived views the interface needs. Everything here reads
// the generated timeline.json and release-log.json; nothing recomputes what
// the build already did.
//
// These interfaces are the site's half of the contract in SCHEMA.md, and they
// deliberately name fewer fields than the research records carry. A field the
// interface never reads is a field the browser should never download, so the
// build stopped emitting the ones that were not here.

export interface Lab { id: string; name: string }

export type ReleaseKind = "model_release" | "technical_report" | "system_card" | "blog_post";

export interface Release {
  lab: string; model: string; date: string; kind: ReleaseKind; source_url: string;
  /** What kind of model this release shipped. Absent only if the backfill has
   *  not reached it; every record carries one today. A list, because one
   *  announcement is often several models. */
  modality?: string[];
  /** Positions in Timeline.benchmarks, not ids. The same few thousand id
   *  strings were repeated across every release and came to a third of the
   *  release log; the two files are generated and served together, so the
   *  positions cannot drift apart. */
  benchmarks: number[];
}

export interface Benchmark {
  id: string; name: string; lab_count: number;
  labs_by_quarter: Record<string, number>;
  categories: string[];          // one primary, optionally one secondary, never three
  suite: string | null;
  recent_share: number;          // % of recent releases citing it, mean over labs
}

export interface Group {
  id: string; name: string; members: number;
  lab_count: number;
  labs_by_quarter: Record<string, number>;
  recent_share: number;
}

/** data/timeline.json: everything the picker and the chart draw from. The
 *  release records live in data/release-log.json and arrive separately,
 *  because only the timeline below the fold needs them and they are the part
 *  of the dataset that grows without bound. */
export interface Timeline {
  generated_at: string; labs: Lab[]; benchmarks: Benchmark[];
  quarters: string[]; categories: Group[]; suites: Group[];
  /** The window recent_share is measured over. Emitted by the build because it
   *  moves every time the data is rebuilt, so copy cannot hard-code it. */
  recent_window: { quarters: string[]; months: number; from: string | null; to: string | null; releases: number };
  /** Enough about the log to size the timeline and date the copy before the
   *  log itself has arrived. */
  release_log: { count: number; first: string | null };
  /** How many benchmarks have a researched description and how many were looked
   *  for and not found. The descriptions themselves are their own asset,
   *  fetched only when a reader opens a detail panel; these two numbers ride in
   *  the registry so the interface can tell at first paint whether that fetch
   *  would find anything, without making it.
   *
   *  Optional because a registry built before the description pass existed does
   *  not carry it, and a page served that registry has to behave as though
   *  nothing had been described rather than throw. */
  descriptions?: { described: number; refused: number };
  /** The kinds of model present in this dataset, commonest first, with how many
   *  releases each covers. Only classes with something behind them. */
  modalities: { id: string; name: string; short: string; blurb: string; releases: number }[];
  /** Share of releases carrying a modality, so the scope control can be offered
   *  or withheld at first paint rather than after the log arrives. */
  modality_coverage: number;
}

/** One benchmark's description, as data/descriptions-site.json carries it.
 *
 *  Fetched on demand rather than with the registry: at 2,176 entries it is about as large as the registry itself and is read only when a detail panel opens, so the URL arrives on `window.btData.descriptions` and the file is requested on that click.
 *
 *  An id absent from the file has no description, which covers both a benchmark nobody has looked for yet and one that was looked for and not found. The two are distinguishable in `Timeline.descriptions` in aggregate but not per benchmark, deliberately: the panel says the same thing either way, and carrying a refusal per id would put the pass's bookkeeping in the browser. */
export interface BenchmarkDescription {
  /** One or two sentences on what the benchmark measures. Never a score: this project records citations and never results. */
  text: string;
  /** The page the description was taken from, https, offered to the reader as its provenance. */
  source_url: string;
}

/** data/descriptions-site.json, keyed by benchmark id. */
export type Descriptions = Record<string, BenchmarkDescription>;

/** Recount every figure on the page over a subset of the releases.
 *
 *  The build computes lab_count, recent_share and labs_by_quarter across all
 *  777 releases, which is right until a reader narrows the page to one kind of
 *  model. Then the timeline would show language releases while every card went
 *  on reporting how many labs cited a benchmark anywhere, including in the
 *  video releases just hidden. A filter whose numbers do not move is worse than
 *  no filter, because it looks like it worked.
 *
 *  Cheap enough to do on every change: one pass over the log, which is already
 *  in memory because the timeline needs it.
 *
 *  `quarters` and `recentQuarters` come from the build so the axis and the
 *  disclosed window stay fixed while the scope moves. A share measured against
 *  a window that also changed would be comparing two different things. */
export interface Recount {
  labCount: number[];              // by benchmark position
  recentShare: number[];
  labsByQuarter: Record<string, number>[];
  releases: number;                // the denominator the shares were taken over
}

export function recount(
  log: Release[],
  benchmarkCount: number,
  quarters: string[],
  recentQuarters: string[],
): Recount {
  const recent = new Set(recentQuarters);
  const labs: Set<string>[] = Array.from({ length: benchmarkCount }, () => new Set());
  const perQuarter: Map<string, Set<string>>[] = Array.from({ length: benchmarkCount }, () => new Map());
  // Per lab, how many releases it shipped in the window and how many of those
  // cited each benchmark. recent_share is a mean of per-lab shares rather than
  // a global ratio, so a lab that ships forty times a quarter cannot drown one
  // that ships twice.
  const shipped = new Map<string, number>();
  const cited: Map<string, number>[] = Array.from({ length: benchmarkCount }, () => new Map());

  for (const r of log) {
    const q = quarterOf(r.date);
    const inWindow = recent.has(q);
    if (inWindow) shipped.set(r.lab, (shipped.get(r.lab) ?? 0) + 1);
    for (const b of r.benchmarks) {
      if (b == null || b >= benchmarkCount) continue;
      labs[b].add(r.lab);
      const m = perQuarter[b];
      if (!m.has(q)) m.set(q, new Set());
      m.get(q)!.add(r.lab);
      if (inWindow) cited[b].set(r.lab, (cited[b].get(r.lab) ?? 0) + 1);
    }
  }

  const labCount = labs.map((s) => s.size);
  const labsByQuarter = perQuarter.map((m) => {
    const out: Record<string, number> = {};
    for (const q of quarters) if (m.has(q)) out[q] = m.get(q)!.size;
    return out;
  });
  const recentShare = cited.map((m) => {
    const shares = [...shipped].map(([lab, n]) => (n ? (m.get(lab) ?? 0) / n : 0));
    return shares.length ? Math.round((shares.reduce((a, b) => a + b, 0) / shares.length) * 100) : 0;
  });
  return { labCount, recentShare, labsByQuarter, releases: [...shipped.values()].reduce((a, b) => a + b, 0) };
}

/** What a series on the chart can be. Benchmarks, the suites that gather their
 *  versions, and the categories that gather their subject. All three are counted
 *  the same way, as distinct labs per quarter, so they share one axis. */
export type TrackKind = "benchmark" | "suite" | "category";

export interface Trackable {
  id: string;                    // "gpqa", "suite:terminal-bench", "cat:coding"
  kind: TrackKind;
  name: string;
  lab_count: number;
  /** How many of the twelve have ever cited it answers breadth. This answers
   *  whether it is still current: the share of recent releases that name it. */
  recent_share: number;
  labs_by_quarter: Record<string, number>;
  members?: number;              // versions in a suite, benchmarks in a category
  categories?: string[];
  suite?: string | null;
  /** Where this benchmark sits in Timeline.benchmarks, which is how the
   *  release log names it. Absent on suites and categories, which cover many
   *  positions and resolve them through memberIds. */
  at?: number;
}

export const trackId = (kind: TrackKind, id: string): string =>
  kind === "benchmark" ? id : `${kind === "suite" ? "suite" : "cat"}:${id}`;

/** One lookup over all three kinds, so the rest of the interface never has to
 *  ask which sort of thing it is holding. */
export function buildTrackables(t: Timeline): Map<string, Trackable> {
  const m = new Map<string, Trackable>();
  for (const c of t.categories) {
    m.set(trackId("category", c.id), { id: trackId("category", c.id), kind: "category", name: c.name, lab_count: c.lab_count, recent_share: c.recent_share, labs_by_quarter: c.labs_by_quarter, members: c.members });
  }
  // A suite's subject, read off the versions inside it. Versions of one
  // evaluation share a subject by construction, so the modal primary category
  // of the members is the suite's own. Derived here rather than in the build
  // because it is a display concern: it exists so a suite can be browsed
  // alongside the benchmarks it competes with, instead of being exiled to a
  // list of its own where nobody looking for a coding eval would find it.
  const suiteCats = new Map<string, string[]>();
  for (const b of t.benchmarks) {
    if (!b.suite || !b.categories.length) continue;
    const seen = suiteCats.get(b.suite) ?? [];
    seen.push(b.categories[0]);
    suiteCats.set(b.suite, seen);
  }
  const modal = (xs: string[] | undefined): string[] => {
    if (!xs?.length) return [];
    const n = new Map<string, number>();
    for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
    return [[...n].sort((a, b) => b[1] - a[1])[0][0]];
  };
  for (const s of t.suites) {
    // A suite and its headline version often share a name, so the suite says
    // so. Without this the browser showed "GPQA" twice and a chip for each was
    // indistinguishable from the other.
    m.set(trackId("suite", s.id), { id: trackId("suite", s.id), kind: "suite", name: `${s.name}, all versions`, lab_count: s.lab_count, recent_share: s.recent_share, labs_by_quarter: s.labs_by_quarter, members: s.members, categories: modal(suiteCats.get(s.id)) });
  }
  t.benchmarks.forEach((b, at) => {
    m.set(b.id, { id: b.id, kind: "benchmark", name: b.name, lab_count: b.lab_count, recent_share: b.recent_share, labs_by_quarter: b.labs_by_quarter, categories: b.categories, suite: b.suite, at });
  });
  return m;
}

/** Colour is the scarce resource: eight validated slots, so tracking caps at eight. */
export const MAX_TRACKED = 8;

export const KIND_LABEL: Record<ReleaseKind, string> = {
  model_release: "Model release",
  technical_report: "Technical report",
  system_card: "System card",
  blog_post: "Blog post",
};

/** Display names come from the build, which is the only place the raw-to-canonical
 *  pairing is exact. Indexed by position, because that is how a release names
 *  the benchmarks it cites. */
export const displayNames = (benchmarks: Benchmark[]): string[] =>
  benchmarks.map((b) => b.name);

export const dayNumber = (iso: string): number => Date.parse(iso + "T00:00:00Z") / 864e5;

export const quarterOf = (iso: string): string =>
  `${iso.slice(0, 4)}-Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;

/** "2025-Q3" reads as "Q3 2025" to a person. */
export const quarterLabel = (q: string): string => `Q${q.slice(6)} ${q.slice(0, 4)}`;

/** Which labs cited a benchmark in a given quarter, and what they shipped. */
export interface PeriodDetail { labs: { lab: string; models: string[] }[] }

export function detailFor(releases: Release[], members: Set<number>): Map<string, PeriodDetail> {
  const acc = new Map<string, Map<string, Set<string>>>();
  for (const r of releases) {
    if (!r.benchmarks.some((b) => members.has(b))) continue;
    const q = quarterOf(r.date);
    const byLab = acc.get(q) ?? new Map<string, Set<string>>();
    byLab.set(r.lab, (byLab.get(r.lab) ?? new Set()).add(r.model));
    acc.set(q, byLab);
  }
  const out = new Map<string, PeriodDetail>();
  for (const [q, byLab] of acc) {
    out.set(q, { labs: [...byLab].map(([lab, models]) => ({ lab, models: [...models].sort() })).sort((a, b) => a.lab.localeCompare(b.lab)) });
  }
  return out;
}


/** The benchmarks a trackable covers: itself for a benchmark, its versions for
 *  a suite, its members for a category. The timeline colours a release mark
 *  when it cites any of them, and the chart's hover detail reads the same set,
 *  so tracking a suite lights up every version of it.
 *
 *  Positions rather than ids, to match what a release record carries. */
export function memberIds(t: Trackable, benchmarks: Benchmark[]): Set<number> {
  if (t.kind === "benchmark") return new Set(t.at === undefined ? [] : [t.at]);
  const out = new Set<number>();
  if (t.kind === "suite") {
    const sid = t.id.slice("suite:".length);
    benchmarks.forEach((b, at) => { if (b.suite === sid) out.add(at); });
    return out;
  }
  const cid = t.id.slice("cat:".length);
  benchmarks.forEach((b, at) => { if (b.categories.includes(cid)) out.add(at); });
  return out;
}
