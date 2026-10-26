// Aggregate harvested hits: group hosts / url prefixes, report source files.
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const urls = new Map(); // url -> Set(source)
const hosts = new Map();
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.hits.txt')) continue;
  const src = f.replace('.hits.txt', '');
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    const [tag, val] = line.split('\t');
    if (!val) continue;
    if (tag === '#URL') {
      if (!urls.has(val)) urls.set(val, new Set());
      urls.get(val).add(src);
      const m = val.match(/^(?:https?|wss?):\/\/([^/:?#]+)/i);
      if (m) {
        const h = m[1].toLowerCase();
        if (!hosts.has(h)) hosts.set(h, new Set());
        hosts.get(h).add(src);
      }
    } else if (tag === '#HOST') {
      const m = val.match(/^([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/i);
      if (m) {
        const h = m[1].toLowerCase();
        if (!hosts.has(h)) hosts.set(h, new Set());
        hosts.get(h).add(src);
      }
    }
  }
}
const out = [];
out.push('## HOSTS (' + hosts.size + ')');
for (const [h, s] of Array.from(hosts).sort()) out.push(`${h}\t${Array.from(s).map((x) => x.split('__')[0]).sort().join(',')}`);
out.push('\n## URLS (' + urls.size + ')');
for (const [u, s] of Array.from(urls).sort()) out.push(`${u}\t${Array.from(s).map((x) => x.split('__')[0]).sort().join(',')}`);
fs.writeFileSync(path.join(dir, '_aggregate.txt'), out.join('\n') + '\n');
console.log('hosts=' + hosts.size + ' urls=' + urls.size);
