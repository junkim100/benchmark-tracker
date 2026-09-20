// The horizontal timeline: one row per lab, releases positioned by date.
//
// Lab identity is carried by the sticky left column, never by colour. Twelve
// categories cannot be told apart by hue, and the validated palette caps at
// eight, so the eight slots are spent on tracked benchmarks instead. A release
// that cites nothing tracked stays neutral; one that cites a tracked benchmark
// is drawn in that benchmark's fixed slot colour.

import { KIND_LABEL, dayNumber, type Lab, type Release } from "./model";

const ROW_H = 40;
const PAD_DAYS = 45;
// Density is set by the busiest lab, not by the viewport. Google publishes on
// 140 distinct days across this span; at six pixels per day its marks sit a
// median 36px apart and stay individually hoverable. Anything tighter collapses
// them into a smear, which is the one thing a timeline must not do.
const PX_PER_DAY = 6;

export interface TimelineArgs {
  labs: Lab[];
  releases: Release[];
  tracked: string[];               // benchmark ids, in slot order
  names: Map<string, string>;
  onHover: (rs: Release[] | null, x: number, y: number) => void;
}

export function renderTimeline(host: HTMLElement, a: TimelineArgs): void {
  const days = a.releases.map((r) => dayNumber(r.date));
  const lo = Math.min(...days) - PAD_DAYS;
  const hi = Math.max(...days) + PAD_DAYS;
  const width = Math.round((hi - lo) * PX_PER_DAY);
  const height = a.labs.length * ROW_H;
  const x = (iso: string) => (dayNumber(iso) - lo) * PX_PER_DAY;

  const slotOf = new Map(a.tracked.map((id, i) => [id, i + 1]));

  // Year gridlines, recessive by design: they orient without competing.
  const y0 = new Date(Date.UTC(new Date((lo + PAD_DAYS) * 864e5).getUTCFullYear(), 0, 1));
  const ticks: { label: string; px: number }[] = [];
  for (let y = y0.getUTCFullYear(); ; y++) {
    const d = Date.UTC(y, 0, 1) / 864e5;
    if (d > hi) break;
    if (d >= lo) ticks.push({ label: String(y), px: (d - lo) * PX_PER_DAY });
  }

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  // A lab often ships several things on one day. Drawing one circle per release
  // stacks them at identical coordinates, where the ones underneath can never be
  // hovered or clicked. One mark per day, carrying all of that day's releases,
  // is both honest and reachable.
  const marks = a.labs.map((lab, row) => {
    const cy = row * ROW_H + ROW_H / 2;
    const byDate = new Map<string, Release[]>();
    for (const r of a.releases) {
      if (r.lab !== lab.id) continue;
      byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    }
    const dots = [...byDate].map(([date, rs]) => {
      const hit = rs.flatMap((r) => r.benchmarks).find((b) => slotOf.has(b));
      const slot = hit ? slotOf.get(hit)! : 0;
      const many = rs.length > 1;
      const cls = `mark${slot ? ` mark--s${slot}` : ""}${many ? " mark--many" : ""}`;
      const r = slot ? 5.5 : 4;
      const label = many ? `${rs.length} releases · ${date}` : `${rs[0].model} · ${date}`;
      return `<circle class="${cls}" cx="${x(date).toFixed(1)}" cy="${cy}" r="${many ? r + 1.5 : r}" data-key="${esc(lab.id + "|" + date)}"><title>${esc(label)}</title></circle>`;
    }).join("");
    return `<g class="row" data-lab="${esc(lab.id)}"><line class="rowline" x1="0" y1="${cy}" x2="${width}" y2="${cy}"/>${dots}</g>`;
  }).join("");

  host.innerHTML = `
    <div class="tl">
      <div class="tl__labs" role="rowheader">
        ${a.labs.map((l) => `<div class="tl__lab" style="height:${ROW_H}px"><span class="tl__logo" aria-hidden="true">${esc(l.name.slice(0, 1))}</span><span class="tl__name">${esc(l.name)}</span></div>`).join("")}
      </div>
      <div class="tl__scroll" tabindex="0" role="group" aria-label="Release timeline, scroll sideways through time">
        <svg class="tl__svg" width="${width}" height="${height + 22}" role="img" aria-label="Releases per lab over time">
          <g class="ticks">${ticks.map((t) => `<line x1="${t.px}" y1="0" x2="${t.px}" y2="${height}"/><text x="${t.px + 4}" y="${height + 15}">${t.label}</text>`).join("")}</g>
          ${marks}
        </svg>
      </div>
    </div>`;

  const svg = host.querySelector<SVGSVGElement>(".tl__svg")!;
  const index = new Map<string, Release[]>();
  for (const r of a.releases) {
    const k = `${r.lab}|${r.date}`;
    index.set(k, [...(index.get(k) ?? []), r]);
  }
  svg.addEventListener("mousemove", (e) => {
    const k = (e.target as Element).getAttribute?.("data-key");
    a.onHover(k ? index.get(k) ?? null : null, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => a.onHover(null, 0, 0));
  svg.addEventListener("click", (e) => {
    const k = (e.target as Element).getAttribute?.("data-key");
    const rs = k ? index.get(k) : null;
    if (rs?.length === 1) window.open(rs[0].source_url, "_blank", "noopener");
  });
}

export function tooltipHTML(rs: Release[], names: Map<string, string>): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const one = (r: Release) => {
    const bs = r.benchmarks.length
      ? r.benchmarks.map((b) => `<li>${esc(names.get(b) ?? b)}</li>`).join("")
      : `<li class="muted">No benchmark cited</li>`;
    return `<div class="tt__h">${esc(r.model)}</div>
      <div class="tt__m">${r.date} · ${KIND_LABEL[r.kind]}</div>
      <ul class="tt__l">${bs}</ul>`;
  };
  const body = rs.map(one).join(`<hr class="tt__hr"/>`);
  const foot = rs.length === 1 ? "Click to open the source" : `${rs.length} releases that day`;
  return `${body}<div class="tt__f">${foot}</div>`;
}
