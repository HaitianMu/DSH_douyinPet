// Extract a balanced JSON-ish array/object starting near a needle, split into lines.
const fs = require('fs');
const [file, needle, outFile, mode] = process.argv.slice(2);
const s = fs.readFileSync(file, 'utf8');
const i = s.indexOf(needle);
if (i < 0) { console.log('needle not found'); process.exit(1); }
const open = mode === 'object' ? '{' : '[';
const close = mode === 'object' ? '}' : ']';
let start = s.lastIndexOf(open, i);
let depth = 0, end = start;
for (let j = start; j < s.length; j++) {
  const c = s[j];
  if (c === open) depth++;
  else if (c === close) { depth--; if (depth === 0) { end = j; break; } }
}
const arr = s.slice(start, end + 1);
const pretty = arr.replace(/,(?=["{[])/g, ',\n');
fs.writeFileSync(outFile, pretty);
console.log('len=' + arr.length + ' start=' + start + ' -> ' + outFile);
