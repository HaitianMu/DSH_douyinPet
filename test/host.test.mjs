import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { apply } from '../index.js'
import { BrowserSession } from '../lib/browser.mjs'
import { readJsonObject } from '../lib/state.mjs'
import { addDraft } from '../lib/outbox.mjs'

test('host memory/settings API works in an isolated runtime without a browser', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'douyin-host-test-'))
  const home = join(root, 'douyin-duty')
  const disposers = []; let handler; let starts = 0
  t.mock.method(BrowserSession.prototype, 'start', async () => { starts++; throw new Error('Browser forbidden in offline tests') })
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    rmSync(root, { recursive: true, force: true })
  })
  const registered = new Map()
  const hostSettings = { autoComment: false, outboxMode: 'review', dailyCommentQuota: 5 }
  apply({
    get: (key) => key === 'dshHomePath' ? (leaf) => join(root, leaf) : undefined,
    tools: { register: (tool) => { registered.set(tool.name, tool); return () => {} } },
    effect: (effect) => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
    webServer: { register: (spec) => { handler = spec.handler; return () => {} } },
  }, hostSettings)
  assert.ok(registered.has('douyin_state'))
  const api = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.url = '/api/douyin-duty' + path; req.method = method
    req.headers = { host: '127.0.0.1:13579', 'content-type': 'application/json', ...(token ? { 'x-douyin-token': token } : {}), ...headers }
    let status; let data
    await handler(req, { writeHead: (code) => { status = code }, end: (raw) => { data = JSON.parse(raw) } })
    return { status, data }
  }
  const token = (await api('/token')).data.token
  const initial = (await api('/self')).data
  assert.equal(initial.stats.platform, 'douyin'); assert.equal(initial.persona.revision, 1)
  assert.equal(existsSync(join(home, 'browser')), false)
  assert.equal((await api('/self/feedback', { method: 'POST', body: { text: '孤立的合成测试记录' } })).status, 403)
  const written = (await api('/self/feedback', { method: 'POST', token, body: { text: '合成测试：今天观察了榫卯结构。' } })).data
  assert.equal(written.ok, true)
  assert.equal((await api('/self/search?q=' + encodeURIComponent('榫卯'))).data.results[0].source, written.source)
  assert.match((await api('/self/read?source=' + encodeURIComponent(written.source))).data.record.body, /合成测试/)
  const configured = (await api('/config', { method: 'POST', token, body: {
    dailyCommentQuota: 0, familyMembers: ['测试姑姑 | 合成测试收件人 | 手工'], autoComment: 'true', outboxMode: 'review',
  } })).data
  assert.equal(configured.cfg.dailyCommentQuota, 0)
  assert.equal(configured.cfg.autoComment, false)
  assert.ok(configured.rejected.includes('autoComment'))
  // A stale host setting must never re-enable actions or raise a disk-configured quota.
  Object.assign(hostSettings, { autoComment: true, outboxMode: 'auto', dailyCommentQuota: 99 })
  const authoritative = (await api('/config')).data.cfg
  assert.equal(authoritative.autoComment, false)
  assert.equal(authoritative.outboxMode, 'review')
  assert.equal(authoritative.dailyCommentQuota, 0)
  assert.equal((await api('/self')).data.family[0].name, '测试姑姑')
  assert.equal((await api('/config', { method: 'POST', token, body: {}, headers: { origin: 'http://127.0.0.1:13580' } })).status, 403)
  const draft = addDraft(home, { kind: 'comment', videoId: '123', text: '合成测试草稿，不会发送' }).item
  const rejected = (await api('/outbox/approve', { method: 'POST', token, body: { id: draft.id } })).data
  assert.equal(rejected.results[0].ok, false)
  writeFileSync(join(home, 'config.json'), '{broken-config}')
  assert.equal((await api('/config')).data.ok, false)
  assert.equal((await api('/self')).data.ok, true)
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{broken-config}')
  assert.equal(starts, 0)
})

test('critical JSON defaults only when missing and preserves damaged data', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'douyin-json-test-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'acted.json')
  assert.deepEqual(readJsonObject(path), {})
  writeFileSync(path, '{bad')
  assert.throws(() => readJsonObject(path))
  assert.equal(readFileSync(path, 'utf8'), '{bad')
  writeFileSync(path, '[]')
  assert.throws(() => readJsonObject(path), /对象/)
})
