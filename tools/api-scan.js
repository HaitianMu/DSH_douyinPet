// Extract API endpoint paths + surrounding context (url/method/params) from JS bundles.
const fs = require('fs');
const path = require('path');
const roots = process.argv.slice(2);
const files = [];
function walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  else if (/\.(js|mjs|cjs)$/.test(p)) files.push(p);
}
roots.forEach(walk);

const paths = new Map(); // path -> Set(file)
const hits = []; // API-ish call sites
const RE = /["'`](\/(?:aweme|webcast|passport|api|cloudpush|service|monitor|im|live|user|video|comment|search|music|mix|lvideo|long|wallpaper|item)\/[A-Za-z0-9_\/\-.{}:]{2,80})["'`]/g;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(RE)) {
    const p = m[1].replace(/\/+$/, '');
    if (!paths.has(p)) paths.set(p, new Set());
    paths.get(p).add(path.relative(process.cwd(), f).replace(/\\/g, '/'));
  }
  // call sites: look for "url:" or ".get(" / ".post(" with adjacent path string
  for (const m of src.matchAll(/(?:url|uri)\s*:\s*["'`]([^"'`]{2,120})["'`]/g)) hits.push(m[1] + '\t' + f);
}
const lines = Array.from(paths).sort().map(([p, s]) => p + '\t' + Array.from(s).join(';'));
fs.writeFileSync('x/api_paths.txt', lines.join('\n') + '\n');
console.log('paths=' + lines.length + ' files=' + files.length + ' urlsites=' + hits.length);
