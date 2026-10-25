import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { apply } from '../index.js'
import { BrowserSession } from '../lib/browser.mjs'
import { SocialBrowser } from '../lib/social-browser.mjs'
import { withSelf } from '../lib/self/tools.mjs'
import { addDraft, readOutbox } from '../lib/outbox.mjs'
import { dayKey } from '../lib/state.mjs'
import { peer } from './fixtures/social.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'douyin-social-host-')); const home = join(root, 'douyin-duty')
  const disposers = []; const launches = []; let handler, tick
  t.mock.method(BrowserSession.prototype, 'start', async () => ({ reused: true }))
  t.mock.method(BrowserSession.prototype, 'setMode', async () => ({ restarted: false }))
  t.mock.method(BrowserSession.prototype, 'stop', async () => {})
  t.mock.method(BrowserSession.prototype, 'tab', async () => { throw new Error('Real browser forbidden in offline tests') })
  t.mock.method(globalThis, 'setInterval', (fn) => { tick = fn; return { unref() {} } })
  t.mock.method(globalThis, 'clearInterval', () => {})
  const mocked = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false, unref() {}, kill() { this.killed = true } })
    launches.push({ child, command, args, options }); return child
  })
  syncBuiltinESMExports()
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose()
    mocked.mock.restore(); syncBuiltinESMExports()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true })
  })
  apply({
    get: (key) => key === 'dshHomePath' ? (leaf) => join(root, leaf) : undefined,
    tools: { register: () => () => {} },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    webServer: { register: (spec) => { handler = spec.handler; return () => {} } },
  }, {})
  let token
  const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.url = '/api/douyin-duty' + path; req.method = method
    req.headers = { host: '127.0.0.1:13579', 'content-type': 'application/json', 'x-douyin-token': token || '' }
    let status, data
    await handler(req, { writeHead: (code) => { status = code }, end: (raw) => { data = JSON.parse(raw) } })
    return { status, data }
  }
  const init = async () => {
    token = (await api('/token')).data.token
    await api('/config', { dshBin: process.execPath, socialContacts: [peer.name + ' | ' + peer.url],
      proactiveEnabled: true, autoReplyEnabled: true, diaryEnabled: true, diaryAt: '00:00', diaryPublishEnabled: true })
  }
  const draft = (kind = 'message') => withSelf(home, (s) => {
    let source
    if (kind === 'diary') {
      const id = 'diary:' + dayKey(); const head = s.db.prepare('SELECT rev FROM heads WHERE id=?').get(id)
      source = head ? s.document(`${id}@${head.rev}`, { current: true }).source
        : s.diary({ day: dayKey(), experiences: '合成的私人记录', publicText: '合成的公开日常' }).source
    }
    else source = s.putDocument({ kind: 'observation', title: '合成视频画面', body: '合成木工作品', data: { origin: 'douyin_frames', videoId: '123' } }).source
    return addDraft(home, { kind, target: kind === 'diary' ? '' : peer.name, peerSecUid: peer.secUid, accountUid: '100',
      diaryDay: kind === 'diary' ? dayKey() : '', videoId: kind === 'diary' ? '' : '123',
      text: kind === 'diary' ? '合成的公开日常' : '合成文字互动', ticket: s.context({ purpose: 'draft' }).ticket, memorySource: source }).item
  })
  return { home, api, init, draft, launches, tick: () => tick() }
}

test('host routes social and diary approval, enforces exclusivity and rechecks switches', async (t) => {
  const f = fixture(t); await f.init()
  const message = f.draft(); let enter, release
  const entered = new Promise((done) => { enter = done }); const released = new Promise((done) => { release = done })
  t.mock.method(SocialBrowser.prototype, 'sendText', async function (item, contact) {
    assert.equal(contact.secUid, peer.secUid); enter(); await released; await this.authorize(item)
    return { ok: true, msg: 'simulated delivery' }
  })
  const approving = f.api('/outbox/approve', { id: message.id }); await entered
  assert.equal((await f.api('/run', {})).data.busy, true)
  assert.equal((await f.api('/outbox/approve', { id: message.id })).status, 409)
  await f.api('/config', { proactiveEnabled: false }); release()
  assert.equal((await approving).data.results[0].ok, false)
  assert.equal(readOutbox(f.home).find((o) => o.id === message.id).status, 'unknown')
  const diary = f.draft('diary'); let publications = 0
  t.mock.method(SocialBrowser.prototype, 'publishDiary', async function (item) {
    await this.authorize(item); assert.equal(item.text, '合成的公开日常'); publications++
    return { ok: true, msg: 'simulated publication' }
  })
  assert.equal((await f.api('/outbox/approve', { id: diary.id })).data.results[0].ok, true)
  assert.equal(readOutbox(f.home).find((o) => o.id === diary.id).status, 'sent')
  assert.equal((await f.api('/outbox/approve', { id: diary.id })).data.results[0].ok, false)
  assert.equal(publications, 1)
})

test('a verification abort stops the whole host approval batch without retrying the reservation', async (t) => {
  const f = fixture(t); await f.init(); const first = f.draft(); const second = f.draft('diary')
  let calls = 0
  t.mock.method(SocialBrowser.prototype, 'sendText', async () => { calls++; throw Object.assign(new Error('synthetic verification'), { name: 'DouyinAbort' }) })
  t.mock.method(SocialBrowser.prototype, 'publishDiary', async () => { throw new Error('Must not continue after verification') })
  const result = await f.api('/outbox/approve', { ids: [first.id, second.id] })
  assert.equal(result.data.results.length, 1); assert.equal(calls, 1)
  assert.deepEqual(readOutbox(f.home).map((o) => o.status), ['unknown', 'pending'])
})

test('diary scheduler can queue publication after writing, and auto mode performs host delivery', async (t) => {
  const f = fixture(t); await f.init()
  await f.api('/config', { diaryPublishEnabled: false, autoReplyEnabled: false })
  f.tick(); assert.equal(f.launches.length, 1)
  assert.match(f.launches[0].args.at(-1), /本轮仅写每日日常/)
  withSelf(f.home, (s) => s.diary({ day: dayKey(), experiences: '合成私人记录', publicText: '合成的公开日常' }))
  f.launches[0].child.emit('exit', 0); f.launches[0].child.emit('close'); await nextTurn()
  const stateFile = join(f.home, 'state.json'); let st = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(st.diaryKey, dayKey()); assert.equal(st.diaryPublishKey, undefined)
  assert.equal(existsSync(join(f.home, 'out', dayKey() + '.md')), false)
  f.tick(); assert.equal(f.launches.length, 1)
  await f.api('/config', { diaryPublishEnabled: true, outboxMode: 'auto' })
  st.diaryAttemptAt = new Date(Date.now() - 31 * 60000).toISOString(); writeFileSync(stateFile, JSON.stringify(st))
  f.tick(); assert.equal(f.launches.length, 2)
  const diary = f.draft('diary'); let finish
  const sent = new Promise((done) => { finish = done })
  t.mock.method(SocialBrowser.prototype, 'publishDiary', async function (item) { await this.authorize(item); finish(); return { ok: true, msg: 'simulated automatic publication' } })
  f.launches[1].child.emit('exit', 0); f.launches[1].child.emit('close'); await sent; await nextTurn()
  assert.equal(readOutbox(f.home).find((o) => o.id === diary.id).status, 'sent')
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).diaryPublishKey, dayKey())
  f.tick(); assert.equal(f.launches.length, 2)
})
