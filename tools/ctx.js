// Print contexts around a needle in a text file, with N chars before/after.
const fs = require('fs');
const [file, needle, beforeS, afterS, outFile] = process.argv.slice(2);
const src = fs.readFileSync(file, 'utf8');
const before = parseInt(beforeS || '300', 10);
const after = parseInt(afterS || '600', 10);
let out = [];
let idx = 0, n = 0;
while ((idx = src.indexOf(needle, idx)) !== -1 && n < 20) {
  out.push(`--- match ${n} @${idx} ---`);
  out.push(src.slice(Math.max(0, idx - before), idx + needle.length + after).replace(/;/g, ';\n'));
  idx += needle.length;
  n++;
}
if (outFile) fs.writeFileSync(outFile, out.join('\n'));
else console.log(out.join('\n'));
console.log('matches=' + n);
