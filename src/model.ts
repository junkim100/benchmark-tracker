// Types and the few derived views the interface needs. Everything here reads
// the generated timeline.json; nothing recomputes what the build already did.

export interface Lab { id: string; name: string; homepage: string; sources: string[] }

export type ReleaseKind = "model_release" | "technical_report" | "system_card" | "blog_post";

export interface Release {
  id: string; lab: string; model: string; date: string; kind: ReleaseKind;
  title: string; source_url: string; benchmarks_raw: string[]; benchmarks: string[];
}

export interface Benchmark {
  id: string; name: string; lab_count: number; labs: string[];
  first_seen: string; last_seen: string;
  labs_by_year: Record<string, number>;
  labs_by_quarter: Record<string, number>;
  categories: string[];          // one primary, optionally one secondary, never three
  suite: string | null;
  recent_share: number;          // % of recent releases citing it, mean over labs
}

export interface Group {
  id: string; name: string; blurb?: string; members: number;
  lab_count: number; labs: string[];
  labs_by_quarter: Record<string, number>;
  recent_share: number;
}

export interface Timeline {
  generated_at: string; labs: Lab[]; releases: Release[]; benchmarks: Benchmark[];
  quarters: string[]; categories: Group[]; suites: Group[];
  /** The window recent_share is measured over. Emitted by the build because it
   *  moves every time the data is rebuilt, so copy cannot hard-code it. */
  recent_window: { quarters: string[]; months: number; from: string | null; to: string | null; releases: number };
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
  for (const b of t.benchmarks) {
    m.set(b.id, { id: b.id, kind: "benchmark", name: b.name, lab_count: b.lab_count, recent_share: b.recent_share, labs_by_quarter: b.labs_by_quarter, categories: b.categories, suite: b.suite });
  }
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

/** Display names come from the build, which is the only place the raw-to-canonical pairing is exact. */
export const displayNames = (benchmarks: Benchmark[]): Map<string, string> =>
  new Map(benchmarks.map((b) => [b.id, b.name]));

export const yearsSpanned = (releases: Release[]): number[] => {
  const ys = releases.map((r) => Number(r.date.slice(0, 4)));
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
};

export const dayNumber = (iso: string): number => Date.parse(iso + "T00:00:00Z") / 864e5;

/** Releases for one lab, oldest first. */
export const byLab = (releases: Release[], labId: string): Release[] =>
  releases.filter((r) => r.lab === labId);

export const quarterOf = (iso: string): string =>
  `${iso.slice(0, 4)}-Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;

/** "2025-Q3" reads as "Q3 2025" to a person. */
export const quarterLabel = (q: string): string => `Q${q.slice(6)} ${q.slice(0, 4)}`;

/** Which labs cited a benchmark in a given quarter, and what they shipped. */
export interface PeriodDetail { labs: { lab: string; models: string[] }[] }

export function detailFor(releases: Release[], members: Set<string>): Map<string, PeriodDetail> {
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


/** The benchmark ids a trackable covers: itself for a benchmark, its versions
 *  for a suite, its members for a category. The timeline colours a release mark
 *  when it cites any of them, and the chart's hover detail reads the same set,
 *  so tracking a suite lights up every version of it. */
export function memberIds(t: Trackable, benchmarks: Benchmark[]): Set<string> {
  if (t.kind === "benchmark") return new Set([t.id]);
  if (t.kind === "suite") {
    const sid = t.id.slice("suite:".length);
    return new Set(benchmarks.filter((b) => b.suite === sid).map((b) => b.id));
  }
  const cid = t.id.slice("cat:".length);
  return new Set(benchmarks.filter((b) => b.categories.includes(cid)).map((b) => b.id));
}
