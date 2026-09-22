import { defineConfig, type Plugin } from "vite";

// GitHub Pages cannot send response headers, so the policy has to travel inside the document. A meta CSP is weaker than a header in two specific ways worth knowing: frame-ancestors, report-uri and sandbox are ignored in meta, so clickjacking is not addressed here, and the policy only governs what the parser sees after it, which is why the tag is prepended to <head> rather than appended.
//
// What it is actually worth on a site with no auth, no cookies and no user data: an injected <script> or inline handler is what turns a data bug into script execution in this origin, and script-src with a hash and no 'unsafe-inline' stops exactly that. base-uri 'none' closes the other half of the same problem, where an injected <base> silently repoints every relative asset URL at somebody else's host. The rest is default-deny so that a future feature that starts talking to a third party has to say so here first.
//
// The hash is computed from the built output rather than written down, because a CSP hash that is maintained by hand is a blank page waiting for the next edit to the bootstrap script. Build only: the dev server needs its own inline preamble and an HMR websocket, and locking those down buys nothing because nothing untrusted is being served there.

// WebCrypto rather than node:crypto, so this file needs no @types/node. tsconfig sets "types": [] and includes vite.config.ts, and adding a dependency to a build that is being trimmed of unused ones would be an odd trade for one hash. crypto.subtle and btoa are both global in Node 20, which is what CI runs.
const sha256Base64 = async (s: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return btoa(String.fromCharCode(...digest));
};

function cspMeta(): Plugin {
  return {
    name: "benchmark-tracker:csp-meta",
    apply: "build",
    transformIndexHtml: {
      // Post, so the html has vite's own injected tags in it and every inline script that will ship is visible to be hashed.
      order: "post",
      async handler(html) {
        const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
        const hashes = await Promise.all(inline.map(async (m) => `'sha256-${await sha256Base64(m[1])}'`));
        const policy = [
          "default-src 'none'",
          // 'self' covers the hashed module bundle; the hashes cover the stale-asset bootstrap in index.html. No 'unsafe-inline': a hash in script-src disables it anyway, and there are no inline event handlers in this app to need it.
          `script-src 'self' ${hashes.join(" ")}`,
          // 'unsafe-inline' is unavoidable and deliberate. The table tints each cell by writing style="--v:..." on it, the timeline sizes itself with style="min-width:..." and style="--gut:...", and the lab marks carry their brand colour as style="--lg:...". Those are attributes built into innerHTML, which style-src-attr governs, and there is no hash form for them.
          "style-src 'self' 'unsafe-inline'",
          // The favicon, and nothing else. Every other graphic on the page is inline SVG.
          "img-src 'self'",
          "font-src 'self'",
          // The site fetches nothing at runtime: the data is compiled into the bundle at build time. Anything that starts making requests should fail loudly here rather than quietly acquire a network.
          "connect-src 'none'",
          "object-src 'none'",
          "frame-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; ");
        // Fail the build rather than ship a page with no policy. A replace that
        // quietly matches nothing is the failure mode that would leave everyone
        // believing the site had a CSP for however long it took to notice.
        if (!/<head>/i.test(html)) throw new Error("csp-meta: no <head> to prepend the policy to");
        return html.replace(
          /<head>/i,
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
        );
      },
    },
  };
}

// Project pages are served from https://junkim100.github.io/benchmark-tracker/,
// so every asset URL needs that prefix.
export default defineConfig({
  base: "/benchmark-tracker/",
  build: { outDir: "dist", sourcemap: true },
  plugins: [cspMeta()],
});
