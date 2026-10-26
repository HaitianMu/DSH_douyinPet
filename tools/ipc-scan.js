// Extract Electron IPC channel names from JS text files: ipcMain.on/handle/once, ipcRenderer.send/invoke/on,
// and `IPC_EVENTS.X` constant usage. Reports channel -> files + direction.
const fs = require('fs');
const path = require('path');
const roots = process.argv.slice(2);
const map = new Map();

function add(ch, dir, file) {
  if (!ch || ch.length > 120) return;
  const key = ch;
  if (!map.has(key)) map.set(key, { dirs: new Set(), files: new Set() });
  map.get(key).dirs.add(dir);
  map.get(key).files.add(file);
}

const RE_MAIN = /ipcMain(?:Internal)?\.(?:on|handle|once|handleOnce)\(\s*["'`]([^"'`]+)["'`]/g;
const RE_RENDERER = /ipcRenderer\.(?:on|send|invoke|sendSync|postMessage)\(\s*["'`]([^"'`]+)["'`]/g;
const RE_ANY = /(?:ipcMain|ipcRenderer|ipcMainInternal)\.(?:on|handle|once|send|invoke|sendSync)\(\s*["'`]([^"'`]+)["'`]/g;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [];
for (const r of roots) {
  const st = fs.statSync(r);
  if (st.isDirectory()) walk(r, files);
  else files.push(r);
}

for (const f of files) {
  let src;
  try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (src.length > 30_000_000) continue;
  const rel = path.relative(process.cwd(), f);
  for (const m of src.matchAll(RE_MAIN)) add(m[1], 'main:' + m[0].includes('handle') ? 'main:handle' : 'main:on', rel);
  for (const m of src.matchAll(RE_RENDERER)) add(m[1], 'renderer:' + (m[0].match(/\.(on|send|invoke|sendSync)/) || [])[1], rel);
}
const lines = [];
for (const [ch, v] of Array.from(map).sort()) {
  lines.push([ch, Array.from(v.dirs).sort().join(','), Array.from(v.files).map((x) => x.replace(/\\/g, '/')).join(';')].join('\t'));
}
fs.writeFileSync('x/ipc_channels.txt', lines.join('\n') + '\n');
console.log('channels=' + lines.length + ' files=' + files.length);
