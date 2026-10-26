// Minimal ASAR (Electron archive) reader/extractor.
// Format: UInt32LE(4) UInt32LE(headerPickleLen) UInt32LE(jsonLen) UInt32LE(jsonStrLen)
//         json (padded to 4) + file data blob
const fs = require('fs');
const path = require('path');

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  const headerPickleLen = b.readUInt32LE(4);
  const jsonStrLen = b.readUInt32LE(12);
  const buf = Buffer.alloc(jsonStrLen);
  fs.readSync(fd, buf, 0, jsonStrLen, 16);
  fs.closeSync(fd);
  const header = JSON.parse(buf.toString('utf8'));
  const baseOffset = 8 + headerPickleLen;
  return { header, baseOffset };
}

function walk(node, prefix, out) {
  for (const [name, meta] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (meta.files) walk(meta, p, out);
    else out.push({ path: p, size: meta.size, offset: meta.offset, unpacked: !!meta.unpacked, executable: !!meta.executable, integrity: meta.integrity });
  }
  return out;
}

function list(file) {
  const { header } = readHeader(file);
  return walk(header, '', []);
}

function extract(file, outDir, filter) {
  const { header, baseOffset } = readHeader(file);
  const entries = walk(header, '', []);
  const fd = fs.openSync(file, 'r');
  let n = 0;
  for (const e of entries) {
    if (e.unpacked) continue;
    if (filter && !filter(e.path)) continue;
    const dest = path.join(outDir, e.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, baseOffset + Number(e.offset));
    fs.writeFileSync(dest, buf);
    n++;
  }
  fs.closeSync(fd);
  return { count: n, total: entries.length };
}

module.exports = { list, extract, readHeader };

if (require.main === module) {
  const [cmd, file, out, pattern] = process.argv.slice(2);
  if (cmd === 'list') {
    const entries = list(file);
    for (const e of entries) console.log([e.size, e.path].join('\t'));
    console.error('total ' + entries.length);
  } else if (cmd === 'extract') {
    const filter = pattern ? (p) => new RegExp(pattern).test(p) : null;
    console.log(JSON.stringify(extract(file, out, filter)));
  } else {
    console.log('usage: node asar.js list|extract <asar> [outDir] [regex]');
  }
}
