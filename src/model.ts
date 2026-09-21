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
  first_seen: string; last_seen: string; labs_by_year: Record<string, number>;
}

export interface Timeline { generated_at: string; labs: Lab[]; releases: Release[]; benchmarks: Benchmark[] }

/** Colour is the scarce resource: eight validated slots, so tracking caps at eight. */
export const MAX_TRACKED = 8;

export const KIND_LABEL: Record<ReleaseKind, string> = {
  model_release: "Model release",
  technical_report: "Technical report",
  system_card: "System card",
  blog_post: "Blog post",
};

/** A raw name is nicer to read than a slug, so show the most common spelling. */
export function displayNames(releases: Release[]): Map<string, string> {
  const tally = new Map<string, Map<string, number>>();
  for (const r of releases) {
    r.benchmarks.forEach((id, i) => {
      const raw = r.benchmarks_raw[i] ?? id;
      const inner = tally.get(id) ?? new Map<string, number>();
      inner.set(raw, (inner.get(raw) ?? 0) + 1);
      tally.set(id, inner);
    });
  }
  const out = new Map<string, string>();
  for (const [id, inner] of tally) {
    out.set(id, [...inner].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  }
  return out;
}

export const yearsSpanned = (releases: Release[]): number[] => {
  const ys = releases.map((r) => Number(r.date.slice(0, 4)));
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
};

export const dayNumber = (iso: string): number => Date.parse(iso + "T00:00:00Z") / 864e5;

/** Releases for one lab, oldest first. */
export const byLab = (releases: Release[], labId: string): Release[] =>
  releases.filter((r) => r.lab === labId);

/** Which labs cited a benchmark in a given year, and what they shipped. */
export interface YearDetail { year: number; labs: { lab: string; models: string[] }[] }

export function detailFor(releases: Release[], benchmarkId: string, years: number[]): Map<number, YearDetail> {
  const out = new Map<number, YearDetail>();
  for (const y of years) out.set(y, { year: y, labs: [] });
  const acc = new Map<number, Map<string, Set<string>>>();
  for (const r of releases) {
    if (!r.benchmarks.includes(benchmarkId)) continue;
    const y = Number(r.date.slice(0, 4));
    const byLab = acc.get(y) ?? new Map<string, Set<string>>();
    byLab.set(r.lab, (byLab.get(r.lab) ?? new Set()).add(r.model));
    acc.set(y, byLab);
  }
  for (const [y, byLab] of acc) {
    out.set(y, {
      year: y,
      labs: [...byLab].map(([lab, models]) => ({ lab, models: [...models].sort() })).sort((a, b) => a.lab.localeCompare(b.lab)),
    });
  }
  return out;
}
