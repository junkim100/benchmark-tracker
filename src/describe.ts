// What one benchmark is, what it belongs to, and who has cited it.
//
// The browse panel answers "how widely is this used" on the face of every card, and nothing else. This is the other half: a reader who does not recognise a name has no way to find out what it is without leaving the page, and 52% of the registry postdates most training data, so guessing from the name is not a strategy either.
//
// Three of the four things the panel says are already in the dataset: the suite, the other versions of the same evaluation, and every release that cited it. The fourth, a sentence saying what the benchmark actually is, cannot be derived from anything here and arrives as a separate file that is researched rather than computed. Most benchmarks will never have one: three quarters of the registry is cited by a single lab, often once, and nobody has written a page about most of them. So the panel is built to read as finished without it, and the sentence is an addition when there is one rather than a hole when there is not.

import { memberIds, type Benchmark, type Group, type Lab, type Release, type Trackable } from "./model";
import type { SheetRequest } from "./sheet";

/** One researched sentence about one benchmark, and the page it was read from.
 *
 *  These two fields are the whole of what descriptions-site.json carries. The file the researcher writes also records the attempts that found nothing, but the build drops those on the way out, so an id missing from this file and an id somebody looked for and could not describe are the same thing here. Both mean the panel says nothing about what the benchmark is, and both are the ordinary case rather than a failure. */
export interface Description {
  text: string;
  source_url: string;
}

export type Descriptions = Record<string, Description>;

let pending: Promise<Descriptions> | null = null;

/** The descriptions, or an empty set. Fetched once and shared, so a reader who opens six panels makes one request.
 *
 *  The URL comes from the boot script in index.html on window.btData.descriptions, and it is a string rather than a started fetch, unlike the registry and the log beside it. That is the point of the file existing separately: it is about as large as the registry, for a panel most visits never open, so nothing asks for it until somebody does. There is no import of it anywhere for the same reason, since an import is a promise to download.
 *
 *  Every failure resolves to an empty set rather than rejecting. No URL at all, a deploy having rotated the hashed name out from under a cached page, a body that is not an object: all of them mean the same thing, which is that there is no sentence to show and the panel has to read well anyway. None is worth a line in the console, because none is a fault the reader can act on.
 *
 *  Deliberately no call to btRecoverStale on a 404, which is what the registry and the log do. Reloading the page would throw away what the reader is tracking and the panel they are reading to recover one sentence that most benchmarks do not have. */
export function loadDescriptions(): Promise<Descriptions> {
  pending ??= (async () => {
    const url = window.btData?.descriptions;
    if (!url) return {};
    try {
      const res = await fetch(url);
      if (!res.ok) return {};
      const body: unknown = await res.json();
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Descriptions) : {};
    } catch {
      return {};
    }
  })();
  return pending;
}

/** The suite's own id, without the prefix a trackable carries so that suites, categories and benchmarks can share one map. */
const suiteIdOf = (t: Trackable): string => t.id.slice("suite:".length);

/** Which key in the descriptions file describes this card.
 *
 *  Benchmarks are keyed by their own id, which is what the file is keyed by. A suite is keyed by the suite's id, which for 47 of the 52 suites is also the id of the base version inside it: the "swe-bench" suite gathers sixteen versions of SWE-bench and the benchmark "swe-bench" is SWE-bench itself, so a sentence written about the benchmark is a sentence about the suite. The other five simply find nothing, which is the same as the common case. */
export const descKey = (t: Trackable): string =>
  t.kind === "suite" ? suiteIdOf(t) : t.id;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** The scheme check at the one place data becomes a navigation, mirroring the one in timeline.ts.
 *
 *  Copied rather than shared, because timeline.ts is imported dynamically so that the heaviest view on the page is not in the bundle that draws the first screen, and importing one helper out of it would pull the whole module back into first paint.
 *
 *  It is here because source_url in the descriptions file comes from a model reading external pages, which is further from a maintainer's hands than anything else the site renders. esc() makes a URL safe to sit inside an attribute; it does nothing about the scheme, and a javascript: href runs in this origin the moment it is followed. */
const isHttpUrl = (u: string): boolean => {
  try {
    // No base. Resolving against the page would let a bare "evil" pass as a same-origin path.
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

const host = (u: string): string => new URL(u).hostname.replace(/^www\./, "");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2024-08-13" as "13 August 2024". The panel says these inside sentences, where an ISO date reads as a serial number rather than as a day. */
const fmtDay = (iso: string): string =>
  `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** "Anthropic, OpenAI and xAI". Twelve is the most this can ever be, so it is never trimmed. */
const sentenceList = (xs: string[]): string =>
  xs.length < 2 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** The researched sentence and its source, or nothing at all.
 *
 *  Exported because the file is fetched on the first press and can land after the panel is already open, so this same function fills the block a second time rather than a near-copy of it drifting away from this one. */
export function aboutHTML(d: Description | null | undefined): string {
  const text = d?.text?.trim();
  if (!text) return "";
  const url = d?.source_url;
  const link = url && isHttpUrl(url)
    ? `<a class="sheet__go" href="${esc(url)}" target="_blank" rel="noopener">Open the source on ${esc(host(url))}</a>`
    : "";
  return `<p class="sheet__h">What it is</p><p class="sheet__p">${esc(text)}</p>${link}`;
}

export interface InfoArgs {
  /** The card that was pressed. A benchmark or a suite; a category gathers a subject rather than versions of one evaluation and has no panel. */
  t: Trackable;
  benchmarks: Benchmark[];
  suites: Group[];
  /** Already sorted for display by the caller, so the panel lists labs in the same order the timeline's rows run in. */
  labs: Lab[];
  /** The releases every figure on the page is currently counted over, scope included, or null while the log is still in flight. Counting over the whole log here would put four labs in the panel under a card reading two, which is the disagreement the scope rollup in main.ts exists to prevent. */
  releases: Release[] | null;
  desc: Description | null;
}

/** What the suite line says, and which other benchmarks are worth naming.
 *
 *  Membership of a suite is the only relation this dataset actually records, so it is the only one offered. Anything else would be a similarity metric invented here, and a wrong neighbour presented as a related benchmark is worse than no list at all. */
function relationHTML(a: InfoArgs): string {
  const li = (b: Benchmark) => `<li>${esc(b.name)}</li>`;
  if (a.t.kind === "suite") {
    // Registry order, which is most-cited first, so the version a reader is most likely to have heard of leads the list.
    const members = a.benchmarks.filter((b) => b.suite === suiteIdOf(a.t));
    return `<p class="sheet__h">Versions</p>
      <p class="sheet__p">The ${members.length} versions this card counts together:</p>
      <ul class="sheet__l">${members.map(li).join("")}</ul>`;
  }
  const sid = a.t.suite;
  if (!sid) {
    // Said plainly rather than left as an empty heading. Six benchmarks in seven are in no suite, so this is what most panels say, and a reader who sees it twice should recognise it as an answer rather than as something missing.
    return `<p class="sheet__h">Suite</p><p class="sheet__p">Not part of a suite, so it has no other versions.</p>`;
  }
  const others = a.benchmarks.filter((b) => b.suite === sid && b.id !== a.t.id);
  const name = a.suites.find((s) => s.id === sid)?.name ?? sid;
  // Counted off the list rather than read from the suite's own members field, so the number and the names under it can never disagree.
  const head = `<p class="sheet__h">Suite</p><p class="sheet__p">One of ${others.length + 1} versions of ${esc(name)}.</p>`;
  if (!others.length) return head;
  return `${head}<p class="sheet__k">The other${others.length === 1 ? "" : "s"}:</p>
    <ul class="sheet__l">${others.map(li).join("")}</ul>`;
}

/** Which labs have cited it, and when it was first and last seen.
 *
 *  Derived rather than read: first_seen and last_seen were taken out of the registry to shrink the file every reader downloads, and the log they came from is already in memory by the time anyone can press an info button. */
function citedHTML(a: InfoArgs): string {
  const head = `<p class="sheet__h">Cited by</p>`;
  if (!a.releases) {
    // Reachable only in the seconds before the log lands, since the log is requested in the head alongside the registry. Saying so beats an empty heading or a zero.
    return `${head}<p class="sheet__p">The release log has not arrived yet.</p>`;
  }
  const members = memberIds(a.t, a.benchmarks);
  const hits = a.releases.filter((r) => r.benchmarks.some((b) => members.has(b)));
  if (!hits.length) {
    // Only possible under a scope that has filtered every citing release away, in which case the card above reads 0 labs and this says why.
    return `${head}<p class="sheet__p">No release in the current view cites it.</p>`;
  }
  const cited = new Set(hits.map((r) => r.lab));
  const names = a.labs.filter((l) => cited.has(l.id)).map((l) => l.name);
  const dates = hits.map((r) => r.date).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const when = hits.length === 1
    ? `One release, on ${fmtDay(first)}.`
    : first === last
      ? `${hits.length} releases, all on ${fmtDay(first)}.`
      : `${hits.length} releases. First ${fmtDay(first)}, most recently ${fmtDay(last)}.`;
  return `${head}<p class="sheet__p">${esc(sentenceList(names))}.</p><p class="sheet__k">${when}</p>`;
}

/** The whole panel, for the bottom sheet the timeline and the chart already use.
 *
 *  The description block is stamped with the card's id and rendered even when it is empty, because the file it comes from is fetched on the first press and can arrive after the panel is on screen. main.ts fills the block in place then, which leaves the reader's focus and the body's scroll where they were. */
export function infoSheet(a: InfoArgs): SheetRequest {
  // A suite's display name carries ", all versions" so a chip can be told from its headline version. In here the panel says how many versions there are in its own words, so the suffix would be said twice.
  const title = a.t.name.replace(/, all versions$/, "");
  return {
    title,
    html: `<div class="sheet__sec" data-about="${esc(a.t.id)}">${aboutHTML(a.desc)}</div>
      <div class="sheet__sec">${relationHTML(a)}</div>
      <div class="sheet__sec">${citedHTML(a)}</div>`,
  };
}
