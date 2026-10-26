// Extract CLI-style switches (--flag, -key=value) from binaries.
const fs = require('fs');
const files = process.argv.slice(3);
const outFile = process.argv[2];
const found = new Map();
for (const file of files) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('latin1');
  for (const m of text.matchAll(/(?:^|[\s"'`(,])(--[a-z0-9][a-z0-9_-]{2,40})(?=[=\s"'`)]|$)/gi)) {
    const k = m[1];
    if (!found.has(k)) found.set(k, new Set());
    found.get(k).add(file);
  }
  for (const m of text.matchAll(/(?:^|[\s"'`(,])(-{1}[a-z][a-z0-9_]{2,30}=)/gi)) {
    const k = m[1];
    if (!found.has(k)) found.set(k, new Set());
    found.get(k).add(file);
  }
}
const lines = Array.from(found).sort().map(([k, v]) => k + '\t' + Array.from(v).join(','));
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log('switches=' + lines.length);
