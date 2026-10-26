// Byte-scan binaries for needles; print matches with surrounding ASCII/UTF-16 context.
// usage: node findbytes.js <needlefile-or-comma-list> <file...>
const fs = require('fs');
const needlesArg = process.argv[2];
const files = process.argv.slice(3);
const needles = needlesArg.includes(',') ? needlesArg.split(',') : fs.readFileSync(needlesArg, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

function ctx(buf, pos, needleLen) {
  const start = Math.max(0, pos - 80);
  const end = Math.min(buf.length, pos + needleLen + 80);
  let s = '';
  for (let i = start; i < end; i++) {
    const b = buf[i];
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return s;
}

const out = [];
for (const file of files) {
  const buf = fs.readFileSync(file);
  for (const needle of needles) {
    // ascii scan
    const nb = Buffer.from(needle, 'latin1');
    let idx = 0;
    let count = 0;
    while ((idx = buf.indexOf(nb, idx)) !== -1 && count < 12) {
      out.push(`${file}\t${needle}\t@${idx}\t${ctx(buf, idx, nb.length)}`);
      idx += nb.length;
      count++;
    }
    // utf16le scan
    const u16 = Buffer.from(needle, 'utf16le');
    idx = 0;
    count = 0;
    while ((idx = buf.indexOf(u16, idx)) !== -1 && count < 6) {
      out.push(`${file}\t${needle}[utf16]\t@${idx}\t${ctx(buf, idx, u16.length)}`);
      idx += u16.length;
      count++;
    }
  }
}
fs.writeFileSync('x/scan_out.txt', out.join('\n') + '\n');
console.log('matches=' + out.length);
