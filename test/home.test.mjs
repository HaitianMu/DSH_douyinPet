import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { BrowserSession } from '../lib/browser.mjs'
import { defaultHomeOf, homeDirOf, migrateHome } from '../lib/home.mjs'
import { withSelf } from '../lib/self/tools.mjs'
import { addDraft } from '../lib/outbox.mjs'
import { dayKey } from '../lib/state.mjs'

const pluginDir = fileURLToPath(new URL('../', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'douyin-home-test-'))
  const home = join(root, 'douyin-duty')
  const ctx = { get: (key) => key === 'dshHomePath' ? (leaf) => join(root, leaf) : undefined }
  const hosts = []
  t.after(() => {
    for (const host of hosts) host.dispose()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    rmSync(root, { recursive: true, force: true })
  })
  const start = () => {
    const disposers = []; const tools = new Map(); let handler
    apply({
      ...ctx,
      tools: { register: (spec) => { tools.set(spec.name, spec); return () => {} } },
      effect: (effect) => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
      webServer: { register: (spec) => { handler = spec.handler; return () => {} } },
    }, {})
    const api = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
      const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
      req.url = '/api/douyin-duty' + path; req.method = method
      req.headers = { host: '127.0.0.1:13579', 'content-type': 'application/json', ...(token ? { 'x-douyin-token': token } : {}), ...headers }
      let status; let data
      await handler(req, { writeHead: (code) => { status = code }, end: (raw) => { data = JSON.parse(raw) } })
      return { status, data }
    }
    const host = { api, tools, dispose: () => { for (const dispose of disposers.splice(0).reverse()) dispose() } }
    hosts.push(host)
    return host
  }
  return { root, home, ctx, start }
}

test('relocation preserves identity, history, drafts and login files immediately and across restarts', async (t) => {
  const { root, home, start } = fixture(t)
  t.mock.method(BrowserSession.prototype, 'start', async () => { throw new Error('Offline test must not start a browser') })
  let host = start(); let token = (await host.api('/token')).data.token
  await host.api('/config', { method: 'POST', token, body: { guardianName: '测试监护人', perDay: 7, dailyCommentQuota: 0 } })
  const source = (await host.api('/self/feedback', { method: 'POST', token, body: { text: '合成经历：学习榫卯。' } })).data.source
  withSelf(home, (s) => {
    s.evolve({ patch: { name: '榫卯鱼' }, reason: '根据合成观察', sources: [source], expectedRevision: 1 })
    s.diary({ day: '2026-10-01', experiences: '合成私人日记：学习榫卯。', sources: [source] })
  })
  const original = (await host.api('/self')).data
  const draft = addDraft(home, { kind: 'comment', videoId: '123', text: '仅合成草稿，不会发送' }).item
  mkdirSync(join(home, 'browser', 'Default'), { recursive: true })
  writeFileSync(join(home, 'browser', 'Default', 'Cookies'), 'synthetic-login-bytes')
  writeFileSync(join(home, 'out', dayKey() + '.md'), '# 合成日报')
  writeFileSync(join(home, 'duty.md'), '合成自定义章程')
  writeFileSync(join(home, 'acted.json'), '{"synthetic":"attempted"}')
  const runtimeFiles = {
    'state.json': '{"lastRunAt":"synthetic"}',
    'seen.json': '["synthetic-video"]',
    'picks.json': '[]',
    'duty.log': 'synthetic log\n',
    'duty.log.1': 'synthetic older log\n',
    'frames/合成画面.png': Buffer.from([0, 1, 2, 255]),
    'browser/Local State': '{"os_crypt":{"encrypted_key":"synthetic-key"}}',
    'browser/Default/Network/Cookies': 'synthetic-modern-cookie-db',
    'browser/Default/Local Storage/leveldb/000001.log': 'synthetic-login-storage',
    'browser/Default/Network/Cookies-wal': 'synthetic-cookie-wal',
    'private-extra/自定义资料.txt': '合成自定义运行文件',
  }
  for (const [file, bytes] of Object.entries(runtimeFiles)) {
    mkdirSync(dirname(join(home, file)), { recursive: true })
    writeFileSync(join(home, file), bytes)
  }
  writeFileSync(join(home, 'browser', 'DevToolsActivePort'), '12345\n/synthetic-old-instance')
  writeFileSync(join(home, 'browser-runtime.json'), '{"port":0,"wsUrl":"synthetic-old-instance"}')
  writeFileSync(join(home, 'headless-overlay.yml'), 'synthetic old paths')
  const configBefore = readFileSync(join(home, 'config.json'), 'utf8')
  const target = join(root, '新家 with spaces')
  mkdirSync(target)
  const moved = await host.api('/home', { method: 'POST', token, body: { home: target } })
  assert.equal(moved.status, 200); assert.equal(moved.data.changed, true)
  assert.equal(moved.data.previousHome, home)
  assert.equal((await host.api('/status')).data.home, target)
  assert.deepEqual((await host.api('/self')).data, original)
  assert.equal((await host.api('/report')).data.md, '# 合成日报')
  assert.equal((await host.api('/outbox')).data.items[0].id, draft.id)
  for (const file of ['config.json', 'duty.md', 'acted.json', 'browser/Default/Cookies']) {
    assert.deepEqual(readFileSync(join(target, file)), readFileSync(join(home, file)))
  }
  for (const file of Object.keys(runtimeFiles)) {
    if (file === 'duty.log') assert.ok(readFileSync(join(target, file), 'utf8').startsWith(String(runtimeFiles[file])))
    else assert.deepEqual(readFileSync(join(target, file)), readFileSync(join(home, file)), file)
  }
  assert.equal(existsSync(join(target, 'browser', 'DevToolsActivePort')), false)
  assert.equal(existsSync(join(target, 'browser-runtime.json')), false)
  assert.equal(existsSync(join(target, 'headless-overlay.yml')), false)
  assert.equal(existsSync(join(target, 'home-location.json')), false)
  assert.equal(existsSync(join(target, 'home-location.json.lock')), false)
  await host.api('/config', { method: 'POST', token, body: { perDay: 9 } })
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), configBefore)
  assert.equal((await host.api('/self/search?q=' + encodeURIComponent('榫卯'))).data.results.length, 2)
  host.dispose(); host = start(); token = (await host.api('/token')).data.token
  assert.equal((await host.api('/config')).data.home, target)
  assert.equal((await host.api('/config')).data.cfg.perDay, 9)
  assert.equal((await host.api('/self')).data.stats.instance, original.stats.instance)
  const again = join(root, 'another', '第二次搬家')
  assert.equal((await host.api('/home', { method: 'POST', token, body: { home: again } })).status, 200)
  host.dispose(); host = start()
  assert.equal((await host.api('/config')).data.home, again)
  assert.equal((await host.api('/self')).data.stats.instance, original.stats.instance)
  assert.equal(existsSync(join(target, 'self', 'memory.sqlite')), true)
})

test('relocation requires a token and rejects occupied, overlapping, foreign and linked directories', async (t) => {
  const { root, home, ctx, start } = fixture(t)
  const host = start(); const token = (await host.api('/token')).data.token
  const target = join(root, 'new-home')
  assert.equal((await host.api('/home', { method: 'POST', body: { home: target } })).status, 403)
  assert.equal((await host.api('/home', { method: 'POST', token, body: { home: target }, headers: { origin: 'http://127.0.0.1:9999' } })).status, 403)
  const occupied = join(root, 'occupied'); mkdirSync(occupied)
  writeFileSync(join(occupied, 'sentinel'), 'keep-existing-data')
  const file = join(root, 'a-file'); writeFileSync(file, 'keep-file')
  const configBefore = readFileSync(join(home, 'config.json'), 'utf8')
  for (const bad of ['', 'relative/path', 'invalid\npath', 12, null, parse(root).root, file, occupied, root, join(home, 'child'), pluginDir, join(pluginDir, 'private-data'), join(root, 'bili-duty', 'child')]) {
    const result = await host.api('/home', { method: 'POST', token, body: { home: bad } })
    assert.equal(result.status, 400, String(bad))
    assert.equal((await host.api('/config')).data.home, home)
  }
  const bili = join(root, '.bili-ai'); mkdirSync(bili)
  writeFileSync(join(bili, 'sentinel'), 'synthetic-sibling-data')
  const alias = join(root, 'alias'); symlinkSync(bili, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await host.api('/home', { method: 'POST', token, body: { home: join(alias, 'child') } })).status, 400)
  assert.equal(existsSync(join(bili, 'child')), false)
  const link = join(home, 'external'); symlinkSync(bili, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.match((await host.api('/home', { method: 'POST', token, body: { home: target } })).data.error, /符号链接|联接/)
  assert.equal(existsSync(target), false)
  assert.equal(readFileSync(join(bili, 'sentinel'), 'utf8'), 'synthetic-sibling-data')
  assert.equal(readFileSync(join(occupied, 'sentinel'), 'utf8'), 'keep-existing-data')
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), configBefore)
  assert.equal(homeDirOf(ctx), home)
})

test('a failed locator commit rolls back the copy and keeps the previous home authoritative', async (t) => {
  const { root, home, ctx, start } = fixture(t)
  start()
  writeFileSync(join(home, 'out', 'synthetic.md'), 'preserve this report')
  const target = join(root, 'empty-target'); mkdirSync(target)
  const originalRename = fs.renameSync
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === join(home, 'home-location.json')) throw Object.assign(new Error('synthetic disk write denied'), { code: 'EACCES' })
    return originalRename(from, to)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(migrateHome({ defaultHome: home, currentHome: home, targetHome: target, pluginDir }), /synthetic disk write denied/)
    assert.deepEqual(readdirSync(target), [])
    assert.equal(homeDirOf(ctx), home)
    assert.equal(readFileSync(join(home, 'out', 'synthetic.md'), 'utf8'), 'preserve this report')
    assert.equal(existsSync(join(home, 'home-location.json')), false)
    assert.equal(existsSync(join(home, 'home-location.json.lock')), false)
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})

test('live browser and concurrent operations prevent migration without starting a browser', async (t) => {
  const { root, home, start } = fixture(t)
  const host = start(); const token = (await host.api('/token')).data.token
  const target = join(root, 'target')
  writeFileSync(join(home, 'browser-runtime.json'), '{"port":12345}')
  let enterProbe; let finishProbe
  const entered = new Promise((done) => { enterProbe = done })
  const finished = new Promise((done) => { finishProbe = done })
  t.mock.method(BrowserSession.prototype, 'alive', async () => { enterProbe(); await finished; return true })
  const pending = host.api('/home', { method: 'POST', token, body: { home: target } })
  await entered
  assert.equal((await host.api('/run', { method: 'POST', token, body: {} })).status, 409)
  assert.equal((await host.api('/self/feedback', { method: 'POST', token, body: { text: '迁移时不能写' } })).status, 409)
  assert.equal((await host.tools.get('douyin_run').execute({})).ok, false)
  finishProbe()
  assert.equal((await pending).status, 409)
  assert.equal(existsSync(target), false)
  let enterStart; let finishStart
  const startEntered = new Promise((done) => { enterStart = done })
  const startFinished = new Promise((done) => { finishStart = done })
  t.mock.method(BrowserSession.prototype, 'start', async () => { enterStart(); await startFinished; throw new Error('Offline test stops before network access') })
  const looking = host.tools.get('douyin_whoami').execute({})
  const rejected = assert.rejects(looking, /Offline test/)
  await startEntered
  const blocked = await host.api('/home', { method: 'POST', token, body: { home: target } })
  assert.equal(blocked.status, 409); assert.match(blocked.data.error, /其他操作/)
  finishStart(); await rejected
  assert.equal(existsSync(target), false)
})

test('migration verifies critical files before switching and rolls back an inconsistent copy', async (t) => {
  const { root, home, ctx, start } = fixture(t)
  start()
  const target = join(root, 'inconsistent-copy')
  const originalConfig = readFileSync(join(home, 'config.json'), 'utf8')
  const originalCopy = fsPromises.copyFile
  const mocked = t.mock.method(fsPromises, 'copyFile', async (from, to, mode) => {
    await originalCopy(from, to, mode)
    if (to === join(target, 'config.json')) writeFileSync(to, '{"synthetic":"inconsistent-copy"}')
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(migrateHome({ defaultHome: home, currentHome: home, targetHome: target, pluginDir }), /资料发生变化/)
    assert.equal(homeDirOf(ctx), home)
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), originalConfig)
    assert.equal(existsSync(target), false)
    assert.equal(existsSync(join(home, 'home-location.json.lock')), false)
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})

test('running duty blocks migration and the next duty uses the new cwd, environment and quoted overlay', async (t) => {
  const { root, home, start } = fixture(t)
  const host = start(); const token = (await host.api('/token')).data.token
  const target = join(root, "新家 it's data")
  await host.api('/config', { method: 'POST', token, body: { dshBin: process.execPath } })
  const launches = []
  const mocked = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false, unref() {}, kill() { this.killed = true } })
    launches.push({ child, command, args, options }); return child
  })
  syncBuiltinESMExports()
  try {
    assert.equal((await host.api('/run', { method: 'POST', token, body: {} })).data.started, true)
    assert.equal((await host.api('/login/start', { method: 'POST', token, body: {} })).status, 409)
    assert.equal((await host.api('/home', { method: 'POST', token, body: { home: target } })).status, 409)
    launches[0].child.emit('close')
    assert.equal((await host.api('/home', { method: 'POST', token, body: { home: target } })).status, 200)
    assert.equal(existsSync(join(target, 'headless-overlay.yml')), false)
    assert.equal((await host.api('/run', { method: 'POST', token, body: {} })).data.started, true)
    assert.equal(launches[1].options.cwd, target)
    assert.equal(launches[1].options.env.DOUYIN_HOME, target)
    assert.ok(launches[1].args.includes(join(target, 'headless-overlay.yml')))
    assert.ok(readFileSync(join(target, 'headless-overlay.yml'), 'utf8').includes('DOUYIN_HOME: ' + JSON.stringify(target.replace(/\\/g, '/'))))
    assert.match(readFileSync(join(target, 'headless-overlay.yml'), 'utf8'), /toolCallTimeoutMs: 600000/)
    launches[1].child.emit('exit', 0); launches[1].child.emit('close')
    assert.equal(existsSync(join(target, 'state.json')), true)
    assert.equal(existsSync(join(home, 'state.json')), false)
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})

test('damaged or missing custom homes never fall back to an old identity', async (t) => {
  const { root, home, ctx, start } = fixture(t)
  start()
  assert.equal(defaultHomeOf({ get: () => root }), home)
  const file = join(home, 'home-location.json')
  for (const raw of ['{broken', 'null', '{"version":1,"home":"relative"}', JSON.stringify({ version: 1, platform: 'bili', home }), JSON.stringify({ version: 1, home: join(root, 'missing') })]) {
    writeFileSync(file, raw)
    assert.throws(() => homeDirOf(ctx), /不会回退/)
    assert.equal(readFileSync(file, 'utf8'), raw)
    assert.equal(existsSync(join(root, 'missing')), false)
  }
  writeFileSync(file, JSON.stringify({ version: 1, platform: 'douyin', home }))
  const marker = join(home, '.douyin-home-incomplete')
  writeFileSync(marker, 'synthetic incomplete migration')
  assert.throws(() => homeDirOf(ctx), /迁移未完成/)
  unlinkSync(marker)
  assert.equal(homeDirOf(ctx), home)
  unlinkSync(file)
  assert.equal(homeDirOf(ctx), home)
  writeFileSync(join(home, 'outbox.jsonl.lock'), 'synthetic stale lock')
  await assert.rejects(migrateHome({ defaultHome: home, currentHome: home, targetHome: join(root, 'new-home'), pluginDir }), /数据仍有锁/)
  assert.equal(homeDirOf(ctx), home)
})
