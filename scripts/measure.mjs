#!/usr/bin/env node
// Reports raw and gzip bytes for everything in a directory. GitHub Pages gzips
// text assets on the way out, so the compressed column is what a visitor pays
// and the raw column is what the browser then has to parse.

import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const root = process.argv[2] ?? "dist";
const rows = [];

const walk = (dir, prefix = "") => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
    else {
      const bytes = readFileSync(path);
      rows.push([`${prefix}${entry.name}`, bytes.length, gzipSync(bytes, { level: 9 }).length]);
    }
  }
};

walk(root);
rows.sort((a, b) => b[1] - a[1]);

const pad = (s, n) => String(s).padStart(n);
let totalRaw = 0;
let totalGz = 0;
console.log(`${"file".padEnd(46)}${pad("raw", 11)}${pad("gzip", 10)}`);
for (const [name, raw, gz] of rows) {
  totalRaw += raw;
  totalGz += gz;
  console.log(`${name.padEnd(46)}${pad(raw.toLocaleString(), 11)}${pad(gz.toLocaleString(), 10)}`);
}
console.log(`${"TOTAL".padEnd(46)}${pad(totalRaw.toLocaleString(), 11)}${pad(totalGz.toLocaleString(), 10)}`);
