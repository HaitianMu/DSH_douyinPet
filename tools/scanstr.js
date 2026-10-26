// Dump keyword-matching ASCII/UTF-16 strings with offsets from binaries.
// usage: node scanstr.js <outdir> <file...>
const fs = require('fs');
const path = require('path');
const outDir = process.argv[2];
const files = process.argv.slice(3);
fs.mkdirSync(outDir, { recursive: true });

const KW = [
  'aweme', 'passport', 'douyin', 'toutiaoapi', 'snssdk', 'zijieapi', 'bytedance', 'byteoversea',
  'gecko', 'webcast', 'imapi', 'frontier', 'cloudpush', 'ticket', 'bogus', 'mstoken', 'webid',
  'scc', 'tnc', 'httpdns', 'ttnet', 'applog', 'slardar', 'crash', 'installer', 'update', 'updater',
  'device_register', 'appsetting', 'service/settings', 'get_domains', 'jsb', 'lynx', 'sslocal', 'bytedns',
  'douyinpic', 'bytedance.com', 'elevation', 'parfait', 'guard', 'wallpaper', 'live', 'charge', 'pay',
  'third_party', 'cookie', 'sessionid', 'ts_sign', 'signature', 'license', 'vids', 'vid', 'play',
];

const out = [];
for (const file of files) {
  const buf = fs.readFileSync(file);
  const seen = new Set();
  let start = -1;
  const emit = (s, off, kind) => {
    if (s.length < 5 || s.length > 4000) return;
    const low = s.toLowerCase();
    if (!KW.some((k) => low.includes(k))) return;
    const key = kind + s;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(`${path.basename(file)}\t${kind}\t${off}\t${s.replace(/[\r\n]+/g, ' ')}`);
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) { if (start < 0) start = i; }
    else { if (start >= 0 && i - start >= 5) emit(buf.toString('latin1', start, i), start, 'A'); start = -1; }
  }
  if (start >= 0) emit(buf.toString('latin1', start, buf.length), start, 'A');
  // UTF-16
  let runStart = -1; const chars = [];
  const flush16 = () => { if (chars.length >= 5) emit(chars.join(''), runStart, 'U'); chars.length = 0; runStart = -1; };
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const cp = buf[i] | (buf[i + 1] << 8);
    const ok = (cp >= 0x20 && cp < 0x7f) || (cp >= 0x4e00 && cp <= 0x9fff) || cp === 9;
    if (ok) { if (runStart < 0) runStart = i; chars.push(String.fromCharCode(cp)); }
    else flush16();
  }
  flush16();
}
fs.writeFileSync(path.join(outDir, '_kw.txt'), out.join('\n') + '\n');
console.log('lines=' + out.length + ' bytes=' + fs.statSync(path.join(outDir, '_kw.txt')).size);
