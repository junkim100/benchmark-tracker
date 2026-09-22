// Whether a source_url is a page the lab itself published.
//
// research.mjs restricts the agent's web SEARCH to each lab's own domains, which is not the same thing as restricting the URL it writes down. The search tool constrains what the model may read; source_url is still free text the model emits, and arxiv.org is a reachable domain for every lab that anyone in the world can publish to. So a prompt injection on a page the agent reads can make the pipeline record an attacker's URL under a lab's name, and nothing downstream would question it: a merge is valid by construction and so is a URL.
//
// That matters because of what the site does with the value. A timeline mark opens source_url in a new tab on click, the tooltip prints its hostname as provenance, and the footer promises every source is the lab's own site, model card or arXiv paper. An off-domain source_url is therefore a phishing link wearing the lab's logo and this project's word for it.
//
// Hence a check on the value that gets written rather than on the pages that were read, run in two places: research.mjs drops the record before it reaches disk so one poisoned result costs one record instead of the whole run, and normalize.mjs repeats it as a contract rule so hand-edited data and any future writer are covered too.

// Hosts that carry every lab, where a bare hostname would let anyone's upload count as official. Each is pinned to the org or bucket named in the lab's own source list. github.com and huggingface.co are the two research.mjs already scopes for search; storage.googleapis.com belongs with them for the same reason, since a Cloud Storage bucket is one signup away and labs.json already names the bucket (deepmind-media) rather than the bare host.
export const SHARED_HOSTS = new Set(["huggingface.co", "github.com", "storage.googleapis.com"]);

const norm = (h) => h.toLowerCase().replace(/^www\./, "");

/** Host to the set of first path segments allowed under it. An empty set means the whole host belongs to the lab. arxiv.org is added for every lab because a lab's own paper is a primary source. */
function allowedHosts(lab) {
  const hosts = new Map();
  const add = (host, seg) => {
    const h = norm(host);
    const segs = hosts.get(h) ?? new Set();
    if (seg) segs.add(seg.toLowerCase());
    hosts.set(h, segs);
  };
  for (const s of lab.sources ?? []) {
    if (!/^https?:\/\//.test(s)) continue;
    let u;
    try { u = new URL(s); } catch { continue; }
    const h = norm(u.hostname);
    add(h, SHARED_HOSTS.has(h) ? u.pathname.split("/").filter(Boolean)[0] : null);
  }
  add("arxiv.org", null);
  return hosts;
}

/** A readable form of the rule, so a rejection can say what it wanted. */
export const describeAllowed = (lab) =>
  [...allowedHosts(lab)].map(([h, segs]) => (segs.size ? [...segs].map((s) => `${h}/${s}`).join(", ") : h)).join(", ");

/** True when `url` is https and sits on one of the lab's own hosts.
 *
 *  Subdomains of a listed host count. The data already contains www-cdn.anthropic.com, deploymentsafety.openai.com, data.x.ai, media.x.ai and autoclaw.z.ai, none of which are listed but all of which are genuinely the lab's, and nobody can create a subdomain of a domain they do not already control. So this widens the rule without weakening it.
 *
 *  Not for a shared host, though. A subdomain of github.com is somebody's Pages site rather than a repo, so those match on the exact host and only under the lab's own org.
 *
 *  https only. Every one of the 777 records already uses it, and a source link the reader is invited to click should not be one a network can rewrite. */
export function isOfficialSource(lab, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = norm(u.hostname);
  for (const [allowed, segs] of allowedHosts(lab)) {
    const exact = host === allowed;
    if (!exact && !host.endsWith(`.${allowed}`)) continue;
    if (!segs.size) return true;
    if (!exact) continue;
    if (segs.has((u.pathname.split("/").filter(Boolean)[0] ?? "").toLowerCase())) return true;
  }
  return false;
}
