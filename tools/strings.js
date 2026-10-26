// Extract printable ASCII / UTF-16LE strings from a binary into a text file.
// usage: node strings.js <file> <out.txt> [minLen]
const fs = require('fs');
const [file, outFile, minLenStr] = process.argv.slice(2);
const minLen = parseInt(minLenStr || '6', 10);
const buf = fs.readFileSync(file);

const ascii = new Set();
const utf16 = new Set();

// ASCII runs
let start = -1;
for (let i = 0; i < buf.length; i++) {
  const b = buf[i];
  const printable = b >= 0x20 && b < 0x7f;
  if (printable) {
    if (start < 0) start = i;
  } else {
    if (start >= 0 && i - start >= minLen) ascii.add(buf.toString('latin1', start, i));
    start = -1;
  }
}
if (start >= 0 && buf.length - start >= minLen) ascii.add(buf.toString('latin1', start, buf.length));

// UTF-16LE runs (printable ascii chars with zero high bytes, or CJK)
let run = [];
const flush = () => {
  if (run.length >= minLen) utf16.add(run.join(''));
  run = [];
};
for (let i = 0; i + 1 < buf.length; i += 2) {
  const lo = buf[i];
  const hi = buf[i + 1];
  const cp = lo | (hi << 8);
  const ok = (cp >= 0x20 && cp < 0x7f) || (cp >= 0x4e00 && cp <= 0x9fff) || cp === 0x9 || cp === 0xd || cp === 0xa;
  if (ok) run.push(String.fromCharCode(cp));
  else flush();
}
flush();

const lines = [];
for (const s of ascii) lines.push(s);
lines.push('\n#--- UTF16 ---\n');
for (const s of utf16) lines.push(s);
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`ascii=${ascii.size} utf16=${utf16.size} -> ${outFile} (${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB)`);
