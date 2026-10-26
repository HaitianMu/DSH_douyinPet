// Extract JSBridge method metadata (name / access / params) from @annie bridge method classes.
const fs = require('fs');
const path = require('path');
const dirs = process.argv.slice(2);
const out = [];
for (const dir of dirs) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const name = (src.match(/"name",\s*"([^"]+)"/) || [])[1] || '';
    const access = (src.match(/"access",\s*[\w.]*E_ACCESS\.([A-Z_]+)/) || [])[1] || '';
    const paramsDestructure = (src.match(/handle,?\s*=?\s*(?:async\s*)?\(?\s*bridgeContext\s*,\s*([\w{}\s,:]+)\)?\s*=>\s*\{\s*(?:try\s*\{\s*)?const\s*\{([^}]*)\}/) || [])[2] || '';
    const keys = new Set();
    for (const m of src.matchAll(/params\.([a-zA-Z0-9_]+)/g)) keys.add(m[1]);
    for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*(?:params|options)/g)) {
      for (const k of m[1].split(',')) {
        const kk = k.split(':')[0].split('=')[0].trim();
        if (kk && /^[a-zA-Z0-9_$]+$/.test(kk)) keys.add(kk);
      }
    }
    out.push({
      file: path.basename(dir) + '/' + f,
      name,
      access,
      paramsKeys: Array.from(keys).sort().join(','),
      paramsDestructure: paramsDestructure.replace(/\s+/g, ' ').trim(),
    });
  }
}
out.sort((a, b) => a.name.localeCompare(b.name));
const lines = out.map((o) => [o.name, o.access, o.file, o.paramsKeys].join('\t'));
fs.writeFileSync('x/bridge_map.txt', lines.join('\n') + '\n');
console.log('methods=' + out.length);
