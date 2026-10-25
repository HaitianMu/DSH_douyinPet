import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { BrowserSession } from '../lib/browser.mjs'
import { HOME_LOCATION, loadHome, migrateHome, validateHomePath } from '../lib/home.mjs'
import { stateDirOf } from '../lib/state.mjs'
import { SelfStore } from '../lib/self/store.mjs'

const pluginDir = fileURLToPath(new URL('../', import.meta.url))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'douyin-home-test-'))
  const base = join(root, 'douyin-duty')
  mkdirSync(base)
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    rmSync(root, { recursive: true, force: true })
  })
  return { root, base, ctx: { get: (key) => key === 'dshHomePath' ? (leaf) => join(root, leaf) : undefined } }
}
function mount(ctx) {
  const disposers = []; const tools = new Map(); let handler
  apply({
    ...ctx,
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    webServer: { register: (spec) => { handler = spec.handler; return () => {} } },
  }, {})
  return {
    tools,
    close: () => { for (const dispose of disposers.splice(0).reverse()) dispose() },
    api: async (path, { method = 'GET', body, bodyStream, token } = {}) => {
      const req = bodyStream || Readable.from(body === undefined ? [] : [JSON.stringify(body)])
      req.url = '/api/douyin-duty' + path; req.method = method
      req.headers = { host: '127.0.0.1:13579', 'content-type': 'application/json', ...(token ? { 'x-douyin-token': token } : {}) }
      let status; let data
      await handler(req, { writeHead: (code) => { status = code }, end: (raw) => { data = JSON.parse(raw) } })
      return { status, data }
    },
  }
}

test('home migration preserves identity, growth, diary RAG, working table and account ledgers', async (t) => {
  const { root, base, ctx } = fixture(t)
  const target = join(root, "女儿的新家 带空格 '")
  const store = new SelfStore(base)
  let identity; let profile; let history
  try {
    const evidence = store.observation({ videoId: '123456789', body: '合成测试：看见木工榫卯的制作过程。' })
    store.evolve({ patch: { name: '榫卯鱼' }, reason: '合成测试：对手工好奇', sources: [evidence.source], expectedRevision: 1 })
    store.diary({ day: '2026-10-01', experiences: '合成测试：第一次认识榫卯。', publicText: '认识了新手艺。', sources: [evidence.source] })
    store.replaceWorking([{ key: '兴趣', text: '继续了解榫卯', sources: [evidence.source] }])
    identity = store.stats().instance; profile = store.profile(); history = store.history()
  } finally { store.close() }
  mkdirSync(join(base, 'browser', 'Default'), { recursive: true })
  writeFileSync(join(base, 'browser', 'Default', 'Cookies'), 'isolated synthetic browser data')
  writeFileSync(join(base, 'config.json'), '{"dailyCommentQuota":0,"autoComment":false}')
  writeFileSync(join(base, 'outbox.jsonl'), '{"id":"synthetic","status":"unknown"}\n')
  writeFileSync(join(base, 'acted.json'), '{"synthetic":"attempted"}')
  const originalDatabase = readFileSync(join(base, 'self', 'memory.sqlite'))
  const moved = await migrateHome({ defaultHome: base, from: base, to: target, pluginDir })
  assert.equal(moved.changed, true)
  assert.equal(stateDirOf(ctx, { pluginDir }), moved.home)
  assert.equal(readFileSync(join(base, 'self', 'memory.sqlite')).equals(originalDatabase), true)
  assert.equal(readFileSync(join(target, 'browser', 'Default', 'Cookies'), 'utf8'), 'isolated synthetic browser data')
  assert.equal(readFileSync(join(target, 'outbox.jsonl'), 'utf8'), readFileSync(join(base, 'outbox.jsonl'), 'utf8'))
  assert.equal(readFileSync(join(target, 'acted.json'), 'utf8'), readFileSync(join(base, 'acted.json'), 'utf8'))
  const reopened = new SelfStore(target)
  try {
    assert.equal(reopened.stats().instance, identity)
    assert.deepEqual(reopened.profile(), profile)
    assert.deepEqual(reopened.history(), history)
    assert.ok(reopened.search('榫卯').length)
    assert.equal(reopened.document('diary:2026-10-01@1').data.publicText, '认识了新手艺。')
    assert.equal(reopened.workingTable()[0].text, '继续了解榫卯')
  } finally { reopened.close() }
  const next = join(root, 'next-home')
  await migrateHome({ defaultHome: base, from: target, to: next, pluginDir })
  assert.equal(stateDirOf(ctx), resolve(next))
  assert.equal(existsSync(join(next, HOME_LOCATION)), false)
  assert.equal(existsSync(join(base, 'self', 'memory.sqlite')), true)
  assert.equal(existsSync(join(target, 'self', 'memory.sqlite')), true)
})

test('home validation refuses shared identities, overlapping directories and junction aliases', async (t) => {
  const { root, base } = fixture(t)
  const change = (to) => migrateHome({ defaultHome: base, from: base, to, pluginDir })
  assert.throws(() => validateHomePath('relative-folder'), /绝对/)
  assert.throws(() => validateHomePath(parse(root).root), /根目录/)
  await assert.rejects(change(join(base, 'nested')), /互相包含/)
  await assert.rejects(change(root), /互相包含/)
  await assert.rejects(change(join(pluginDir, 'private-data')), /源码/)
  await assert.rejects(change(join(root, '.bili-ai', 'nested')), /B 站/)
  const other = join(root, 'other-fish'); mkdirSync(other)
  writeFileSync(join(other, 'sentinel'), '合成测试：另一条鱼的资料')
  await assert.rejects(change(other), /必须为空/)
  assert.equal(readFileSync(join(other, 'sentinel'), 'utf8'), '合成测试：另一条鱼的资料')
  const bili = join(root, 'bili-duty'); mkdirSync(bili)
  const alias = join(root, 'alias')
  symlinkSync(bili, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(change(join(alias, 'new-home')), /B 站/)
  assert.equal(existsSync(join(bili, 'new-home')), false)
  assert.equal(loadHome(base), resolve(base))
})

test('failed copy preserves the active home and does not activate a partial destination', async (t) => {
  const { root, base } = fixture(t)
  writeFileSync(join(base, 'config.json'), '{"synthetic":true}')
  const external = join(root, 'external'); mkdirSync(external)
  writeFileSync(join(external, 'sentinel'), 'synthetic data never imported')
  symlinkSync(external, join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const target = join(root, 'failed-copy')
  await assert.rejects(migrateHome({ defaultHome: base, from: base, to: target, pluginDir }), /迁移未切换/)
  assert.equal(loadHome(base), resolve(base))
  assert.equal(readFileSync(join(base, 'config.json'), 'utf8'), '{"synthetic":true}')
  assert.equal(existsSync(join(base, HOME_LOCATION)), false)
  assert.equal(existsSync(join(target, '.douyin-home-incomplete')), true)
  assert.equal(existsSync(join(target, 'linked')), false)
})

test('damaged locator or unavailable custom home never silently resets a fish', async (t) => {
  const { root, base } = fixture(t)
  const locator = join(base, HOME_LOCATION)
  writeFileSync(locator, '{broken')
  assert.throws(() => loadHome(base), /损坏/)
  assert.equal(readFileSync(locator, 'utf8'), '{broken')
  const missing = join(root, 'missing-custom-home')
  writeFileSync(locator, JSON.stringify({ version: 1, platform: 'douyin', home: missing }))
  assert.throws(() => loadHome(base), /不可用/)
  assert.equal(existsSync(missing), false)
})

test('empty destinations work, while writer locks and locator commit failures preserve the source', async (t) => {
  const { root, base } = fixture(t)
  writeFileSync(join(base, 'config.json'), '{"synthetic":true}')
  const target = join(root, 'empty-destination'); mkdirSync(target)
  const move = () => migrateHome({ defaultHome: base, from: base, to: target, pluginDir })
  const outboxLock = join(base, 'outbox.jsonl.lock')
  writeFileSync(outboxLock, 'synthetic writer')
  await assert.rejects(move(), /待发件箱/)
  assert.equal(existsSync(join(target, 'config.json')), false)
  rmSync(outboxLock)
  const migrationLock = join(base, HOME_LOCATION + '.lock')
  writeFileSync(migrationLock, 'synthetic migration')
  await assert.rejects(move(), /其他迁移/)
  assert.equal(readFileSync(migrationLock, 'utf8'), 'synthetic migration')
  rmSync(migrationLock)
  // A directory at the locator makes its final atomic rename fail on every platform.
  const locator = join(base, HOME_LOCATION); mkdirSync(locator)
  await assert.rejects(move(), /迁移未切换/)
  assert.equal(readFileSync(join(base, 'config.json'), 'utf8'), '{"synthetic":true}')
  assert.equal(existsSync(migrationLock), false)
  rmdirSync(locator)
  assert.equal(loadHome(base), resolve(base))
  const retryTarget = join(root, 'empty-retry'); mkdirSync(retryTarget)
  const moved = await migrateHome({ defaultHome: base, from: base, to: retryTarget, pluginDir })
  assert.equal(loadHome(base), moved.home)
  assert.equal(readFileSync(join(retryTarget, 'config.json'), 'utf8'), '{"synthetic":true}')
  assert.equal((await migrateHome({ defaultHome: base, from: retryTarget, to: retryTarget, pluginDir })).changed, false)
})

test('guardian home API switches all paths, preserves feedback and survives host restart', async (t) => {
  const { root, base, ctx } = fixture(t)
  let browserAlive = true
  t.mock.method(BrowserSession.prototype, 'alive', async () => browserAlive)
  t.mock.method(BrowserSession.prototype, 'start', async () => { throw new Error('Offline test must never open a browser') })
  let host = mount(ctx)
  t.after(() => host.close())
  const token = (await host.api('/token')).data.token
  const initial = (await host.api('/self')).data
  const entry = (await host.api('/self/feedback', { method: 'POST', token, body: { text: '合成测试：迁移前记住榫卯。' } })).data
  const target = join(root, 'custom-home')
  assert.equal((await host.api('/home', { method: 'POST', body: { home: target } })).status, 403)
  assert.equal((await host.api('/home', { method: 'POST', token, body: { home: target } })).status, 409)
  assert.equal(existsSync(target), false)
  browserAlive = false
  const moved = await host.api('/home', { method: 'POST', token, body: { home: target } })
  assert.equal(moved.status, 200); assert.equal(moved.data.ok, true)
  assert.equal((await host.api('/config')).data.home, moved.data.home)
  assert.equal((await host.api('/status')).data.home, moved.data.home)
  assert.equal((await host.api('/self')).data.stats.instance, initial.stats.instance)
  assert.match((await host.api('/self/read?source=' + encodeURIComponent(entry.source))).data.record.body, /迁移前/)
  const next = await host.api('/self/feedback', { method: 'POST', token, body: { text: '合成测试：搬家后继续成长。' } })
  assert.equal(next.data.ok, true)
  await host.api('/config', { method: 'POST', token, body: { dailyCommentQuota: 0 } })
  assert.equal(JSON.parse(readFileSync(join(target, 'config.json'), 'utf8')).dailyCommentQuota, 0)
  assert.equal(JSON.parse(readFileSync(join(base, 'config.json'), 'utf8')).dailyCommentQuota, 5)
  const oldStore = new SelfStore(base)
  try { assert.equal(oldStore.search('搬家后').length, 0) } finally { oldStore.close() }
  host.close(); host = mount(ctx)
  assert.equal((await host.api('/config')).data.home, moved.data.home)
  assert.equal((await host.api('/self')).data.stats.instance, initial.stats.instance)
  assert.ok((await host.api('/self/search?q=' + encodeURIComponent('搬家后'))).data.results.length)
})

test('pending migration blocks writes, tools and concurrent migrations', async (t) => {
  const { root, ctx } = fixture(t)
  let entered; let release
  const probing = new Promise((resolve) => { entered = resolve })
  const result = new Promise((resolve) => { release = resolve })
  t.mock.method(BrowserSession.prototype, 'alive', async () => { entered(); return result })
  const host = mount(ctx)
  t.after(() => { release(false); host.close() })
  const token = (await host.api('/token')).data.token
  const moving = host.api('/home', { method: 'POST', token, body: { home: join(root, 'destination') } })
  await probing
  assert.equal((await host.api('/self/feedback', { method: 'POST', token, body: { text: '合成测试：迁移中不写入' } })).status, 409)
  assert.equal((await host.api('/home', { method: 'POST', token, body: { home: join(root, 'concurrent') } })).status, 409)
  await assert.rejects(host.tools.get('douyin_run').execute({}), /迁移/)
  release(false)
  assert.equal((await moving).status, 200)
})

test('migration waits for an unfinished guardian write to complete', async (t) => {
  const { root, ctx } = fixture(t)
  t.mock.method(BrowserSession.prototype, 'alive', async () => false)
  const host = mount(ctx)
  t.after(() => host.close())
  const token = (await host.api('/token')).data.token
  const bodyStream = new Readable({ read() {} })
  t.after(() => bodyStream.destroy())
  const writing = host.api('/self/feedback', { method: 'POST', token, bodyStream })
  const target = join(root, 'after-write')
  assert.equal((await host.api('/home', { method: 'POST', token, body: { home: target } })).status, 409)
  assert.equal(existsSync(target), false)
  bodyStream.push(JSON.stringify({ text: '合成测试：等待写完这条记忆再搬家。' })); bodyStream.push(null)
  const entry = await writing
  assert.equal(entry.status, 200)
  assert.equal((await host.api('/home', { method: 'POST', token, body: { home: target } })).status, 200)
  assert.match((await host.api('/self/read?source=' + encodeURIComponent(entry.data.source))).data.record.body, /等待写完/)
})
