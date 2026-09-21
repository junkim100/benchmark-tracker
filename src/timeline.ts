// The release timeline, running down the page.
//
// Time is the vertical axis and the newest release is at the top, so reading
// backwards through it is an ordinary page scroll. Labs are the columns.
//
// It used to be the other way round, a horizontal scroller with labs as rows,
// and the scroller was the single buggiest thing here: restoring the reader's
// place across a resize took a dozen attempts, because a horizontal scroll
// offset has to be saved, converted between scales and put back by hand, and
// the browser clamps it mid-reflow while you are not looking. A vertical
// timeline in page flow has no offset to restore. The browser keeps the
// reader's place because it is the page's place.
//
// Lab identity is carried by the sticky header, never by colour: twelve
// categories cannot be told apart by hue and the validated palette caps at
// eight, so those eight are spent on tracked benchmarks.

import { LOGOS } from "./logos";
import { KIND_LABEL, dayNumber, type Lab, type Release } from "./model";

const PAD_DAYS = 30;
// Vertical scale. The span is about 1,460 days, so this makes the timeline
// roughly 2,900px: three or four screens of scrolling to cross four years,
// which is enough to feel like travel without becoming a chore. Marks are 8px
// and the busiest lab publishes on 140 distinct days, a median 10 days apart,
// so at this scale its marks sit about 20px apart and stay separate.
const PX_PER_DAY = 2;
const GUTTER_WIDE = 58;
const GUTTER_NARROW = 38;
// A column narrower than this cannot hold the 22px mark tile with room to
// breathe, so below it the timeline stops shrinking and scrolls sideways
// instead. Twelve of these plus the narrow gutter come to 350px, which a
// 360px phone clears once the timeline is allowed the full viewport. Only a
// genuinely small screen, 320px and under, ends up scrolling.
const MIN_COL = 26;

export interface TimelineArgs {
  labs: Lab[];
  quarters: string[];
  releases: Release[];
  trackedMembers: Set<string>[];   // one set of benchmark ids per slot, in slot order
  names: Map<string, string>;
  onHover: (rs: Release[] | null, x: number, y: number) => void;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function labMark(l: Lab, esc: (s: string) => string): string {
  const m = LOGOS[l.id];
  return m
    ? `<span class="tl__logo" style="--lg:${m.cl};--lgd:${m.cd}" aria-hidden="true"><svg viewBox="${m.vb}">${m.d}</svg></span>`
    : `<span class="tl__logo" aria-hidden="true">${esc(l.name.slice(0, 1))}</span>`;
}

export function renderTimeline(host: HTMLElement, a: TimelineArgs): void {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  const box = Math.round(host.getBoundingClientRect().width) || 900;
  const narrow = box < 640;
  // Narrow runs full width of the page, outside the body gutters, because
  // twelve columns need every pixel there is on a phone.
  const avail = narrow ? (document.documentElement.clientWidth || box) : box;
  const GUT = narrow ? GUTTER_NARROW : GUTTER_WIDE;
  const floor = GUT + a.labs.length * MIN_COL;
  const W = Math.max(floor, avail);
  const colW = (W - GUT) / a.labs.length;
  const scale = narrow ? 0.62 : 1;

  const days = a.releases.map((r) => dayNumber(r.date));
  const lo = Math.min(...days) - PAD_DAYS;
  const hi = Math.max(...days) + PAD_DAYS;
  const H = Math.round((hi - lo) * PX_PER_DAY);
  // Newest at the top, so y counts down from the most recent day.
  const y = (iso: string) => (hi - dayNumber(iso)) * PX_PER_DAY;
  const cx = (i: number) => GUT + colW * i + colW / 2;

  // Slot by membership, not by identity. A tracked suite covers many benchmark
  // ids, so the lookup is the other way round: given what a release cites, find
  // the first slot that claims any of it.
  // Narrowest match wins. Scanning in slot order meant that tracking a suite
  // and one of its versions coloured every mark with whichever was picked
  // first, so the version's own colour could never appear on a release that
  // only it covers. Preferring the smaller set gives the more specific answer.
  const order = a.trackedMembers
    .map((set, i) => ({ set, slot: i + 1 }))
    .sort((x, y) => x.set.size - y.set.size);
  const slotOfRelease = (ids: string[]): number | undefined => {
    for (const { set, slot } of order) {
      if (ids.some((id) => set.has(id))) return slot;
    }
    return undefined;
  };

  // Month rules across the plot, labelled in the gutter. January takes the ink
  // and carries the year; the rest stay quiet.
  const ticks: { y: number; label: string; year: string; first: boolean }[] = [];
  {
    const d0 = new Date(hi * 864e5);
    let yr = d0.getUTCFullYear();
    let mo = d0.getUTCMonth();
    for (;;) {
      const ty = (hi - dayNumber(`${yr}-${String(mo + 1).padStart(2, "0")}-01`)) * PX_PER_DAY;
      if (ty > H) break;
      if (ty >= 0) ticks.push({ y: ty, label: MONTH[mo], year: String(yr), first: mo === 0 });
      if (--mo < 0) { mo = 11; yr--; }
    }
  }

  const marks = a.labs.map((lab, li) => {
    const byDate = new Map<string, Release[]>();
    for (const r of a.releases) if (r.lab === lab.id) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    const dots = [...byDate.entries()].map(([date, rs]) => {
      const slot = slotOfRelease(rs.flatMap((r) => r.benchmarks));
      const many = rs.length > 1;
      const cls = `mark${slot ? ` mark--s${slot}` : ""}${many ? " mark--many" : ""}`;
      const r0 = (slot ? 5.5 : 4) * scale;
      const label = `${lab.name}, ${date}, ${rs.length} release${rs.length > 1 ? "s" : ""}: ${rs.map((r) => `${r.model} (${KIND_LABEL[r.kind] ?? r.kind})`).join("; ")}`;
      return `<circle class="${cls}" cx="${cx(li).toFixed(1)}" cy="${y(date).toFixed(1)}" r="${(many ? r0 + 1.5 * scale : r0).toFixed(2)}" data-key="${esc(lab.id + "|" + date)}" aria-label="${esc(label)}"></circle>`;
    }).join("");
    return `<g class="tlv__col" data-lab="${esc(lab.id)}">${dots}</g>`;
  }).join("");

  host.innerHTML = `
    <div class="tlvwrap${narrow ? " tlvwrap--bleed" : ""}"><div class="tlv" style="min-width:${floor}px">
      <div class="tlv__head" style="--gut:${GUT}px;--cols:${a.labs.length}">
        <div class="tlv__gutcell" aria-hidden="true"></div>
        ${a.labs.map((l) => `<div class="tlv__lab" title="${esc(l.name)}">${labMark(l, esc)}${narrow ? "" : `<span class="tlv__name">${esc(l.name)}</span>`}</div>`).join("")}
      </div>
      <svg class="tlv__svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Releases per lab over time, newest first">
        <g class="ticks">${ticks.map((t) =>
          `<line class="${t.first ? "tick tick--year" : "tick"}" x1="${GUT}" y1="${t.y.toFixed(1)}" x2="${W}" y2="${t.y.toFixed(1)}"/>`
        ).join("")}</g>
        <g class="cols">${a.labs.map((_, i) =>
          `<line class="collline" x1="${(GUT + colW * i).toFixed(1)}" y1="0" x2="${(GUT + colW * i).toFixed(1)}" y2="${H}"/>`
        ).join("")}</g>
        <g class="axis">${ticks.map((t) =>
          `<text class="axis__m${t.first ? " axis__m--first" : ""}" x="${GUT - 8}" y="${(t.y + 4).toFixed(1)}">${t.label}</text>` +
          (t.first ? `<text class="axis__y" x="${GUT - 8}" y="${(t.y + 18).toFixed(1)}">${t.year}</text>` : "")
        ).join("")}</g>
        ${marks}
      </svg>
    </div></div>`;

  const svg = host.querySelector<SVGSVGElement>(".tlv__svg")!;
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
    // Every mark opens something. Previously only single-release days did, so a
    // fifth of the marks offered a pointer cursor and did nothing.
    if (rs?.length) window.open(rs[0].source_url, "_blank", "noopener");
  });
}

export function tooltipHTML(rs: Release[], names: Map<string, string>, shown = 8, blocks = 3): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  // `shown` is a row cap, not a pixel budget. The caller renders, measures and
  // reduces it until the box fits, which is the only approach that survives
  // content that wraps unpredictably.
  const SHOWN = shown;
  const releases = Math.max(1, Math.min(blocks, rs.length));

  const one = (r: Release) => {
    const rest = r.benchmarks.length - SHOWN;
    const bs = r.benchmarks.length
      ? r.benchmarks.slice(0, SHOWN).map((b) => `<li>${esc(names.get(b) ?? b)}</li>`).join("")
        + (rest > 0 ? `<li class="tt__rest">and ${rest} more</li>` : "")
      : `<li class="muted">No benchmark cited</li>`;
    return `<div class="tt__h">${esc(r.model)}</div>
      <div class="tt__m">${KIND_LABEL[r.kind]}, ${r.date}</div>
      <div class="tt__src">${esc(new URL(r.source_url).hostname.replace(/^www\./, ""))}</div>
      <ul class="tt__l">${bs}</ul>`;
  };
  const MAX_RELEASES = releases;
  const body = rs.slice(0, MAX_RELEASES).map(one).join(`<hr class="tt__hr"/>`);
  const foot = rs.length === 1
    ? "Click to open the source"
    : `${rs.length} releases that day${rs.length > MAX_RELEASES ? `, showing ${MAX_RELEASES}` : ""}. Click to open the first.`;
  return `${body}<div class="tt__f">${foot}</div>`;
}
