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
}

export interface Timeline { generated_at: string; labs: Lab[]; releases: Release[]; benchmarks: Benchmark[]; quarters: string[] }

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

export function detailFor(releases: Release[], benchmarkId: string): Map<string, PeriodDetail> {
  const acc = new Map<string, Map<string, Set<string>>>();
  for (const r of releases) {
    if (!r.benchmarks.includes(benchmarkId)) continue;
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
