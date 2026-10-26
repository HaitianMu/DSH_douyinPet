// Harvest "interface-relevant" strings from binaries: URLs, hostnames, api-ish paths,
// protocol schemes, and bridge-ish identifiers. Writes one .txt per input file.
// usage: node harvest.js <outDir> <file1> <file2> ...
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
const files = process.argv.slice(3);
fs.mkdirSync(outDir, { recursive: true });

const RE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|cn|net|org|io|co|tv|cc|so|im|app|cloud|top|xyz|me|dev|info|biz|edu|gov|link|live|site|online|tech|vip|wang|shop|club|fun|pro|name|mobi|asia|hk|tw|jp|kr|sg|us|eu|ru|de|uk|in|id|th|vn|my|ph|br|au|ca|fr|nl|se|no|fi|dk|pl|tr|ua|ir|sa|ae|il)(?::\d+)?(?:\/.*)?$/i;
const RE_URL = /(?:https?|wss?|ftp|file):\/\/[^\s"'<>`\\]{3,300}/i;
const RE_PATH = /^(?:~)?\/[A-Za-z0-9_\-]+\/[A-Za-z0-9_\-\/]{1,120}$/;
const RE_PATH_VER = /^\/[A-Za-z0-9_\-]+\/v\d+\//;
const RE_SCHEME = /^[a-z][a-z0-9+.\-]{2,30}:\/\//;
const RE_IPC = /^(?:[a-z0-9_\-]{2,40}[:.][a-z0-9_\-.$]{2,80})$/i;

function extractStrings(buf, minLen) {
  const out = new Set();
  let start = -1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= minLen) out.add(buf.toString('latin1', start, i));
      start = -1;
    }
  }
  if (start >= 0 && buf.length - start >= minLen) out.add(buf.toString('latin1', start, buf.length));
  // UTF-16LE
  let run = [];
  const flush = () => { if (run.length >= minLen) out.add(run.join('')); run = []; };
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const cp = buf[i] | (buf[i + 1] << 8);
    if ((cp >= 0x20 && cp < 0x7f) || (cp >= 0x4e00 && cp <= 0x9fff)) run.push(String.fromCharCode(cp));
    else flush();
  }
  flush();
  return out;
}

const summary = [];
for (const file of files) {
  const buf = fs.readFileSync(file);
  const strings = extractStrings(buf, 4);
  const hits = new Set();
  for (const s of strings) {
    const line = s.trim();
    if (!line) continue;
    if (RE_URL.test(line)) {
      const m = line.match(RE_URL);
      hits.add('#URL\t' + m[0]);
      continue;
    }
    if (RE_SCHEME.test(line) && line.length < 200) { hits.add('#SCHEME\t' + line); continue; }
    if (RE_PATH_VER.test(line) || (RE_PATH.test(line) && line.length < 140)) { hits.add('#PATH\t' + line); continue; }
    if (RE_HOST.test(line) && line.length < 200) { hits.add('#HOST\t' + line); continue; }
    if (RE_IPC.test(line) && /^(?:douyin|tt|byted|pc|app|web|native|im|push|update|crash|log|guard|tray|lan|net|jsb|bridge|sami|lynx|cef|chromium|cronet|ttnet)[:._]/i.test(line)) {
      hits.add('#IPC\t' + line);
    }
  }
  const parent = path.basename(path.dirname(file)).replace(/[^\w.-]/g, '_');
  const base = (parent + '__' + path.basename(file) + '__' + require('crypto').createHash('md5').update(file).digest('hex').slice(0, 6)).replace(/[^\w.-]/g, '_');
  const dest = path.join(outDir, base + '.hits.txt');
  fs.writeFileSync(dest, Array.from(hits).sort().join('\n') + '\n');
  summary.push(`${base}\t${hits.size}`);
}
fs.writeFileSync(path.join(outDir, '_summary.txt'), summary.join('\n') + '\n');
console.log(summary.join('\n'));
