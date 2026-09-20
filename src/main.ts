// Application shell. The timeline and the tracking filter are built on top of
// this by the interface work; this file only owns loading and the empty state.

import "./styles/tokens.css";

export interface Lab { id: string; name: string; homepage: string; sources: string[] }
export interface Release {
  id: string; lab: string; model: string; date: string;
  kind: "model_release" | "technical_report" | "system_card" | "blog_post";
  title: string; source_url: string;
  benchmarks_raw: string[];
  benchmarks: string[];
}
export interface Benchmark {
  id: string; name: string; lab_count: number; labs: string[];
  first_seen: string; last_seen: string; labs_by_year: Record<string, number>;
}
export interface Timeline { generated_at: string; labs: Lab[]; releases: Release[]; benchmarks: Benchmark[] }

const app = document.querySelector<HTMLDivElement>("#app")!;

async function main(): Promise<void> {
  const data: Timeline = (await import("../data/timeline.json")).default as Timeline;

  if (data.releases.length === 0) {
    app.innerHTML = `
      <main class="empty">
        <h1>Benchmark Tracker</h1>
        <p>Which benchmarks frontier labs actually cite when they ship a model. No scores, only what each lab chose to report.</p>
        <p class="muted">Tracking ${data.labs.length} labs. Research in progress, no releases recorded yet.</p>
      </main>`;
    return;
  }

  app.innerHTML = `<main><h1>Benchmark Tracker</h1><p class="muted">${data.releases.length} releases across ${data.labs.length} labs.</p></main>`;
}

main().catch((err: unknown) => {
  app.innerHTML = `<main><h1>Benchmark Tracker</h1><p>Failed to load data.</p></main>`;
  console.error(err);
});
