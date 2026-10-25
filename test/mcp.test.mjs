import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

test('MCP stdio serves memory and persists diaries without touching a browser', { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'douyin-mcp-test-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../lib/mcp-server.mjs', import.meta.url))], {
    env: { ...process.env, DOUYIN_HOME: home, DOUYIN_PORT: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let next = 0; let buffer = ''; const pending = new Map(); let stderr = ''
  child.stderr.on('data', (data) => { stderr += data })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (data) => {
    buffer += data
    let pos
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1)
      const msg = JSON.parse(line)
      const fn = pending.get(msg.id); pending.delete(msg.id); fn?.(msg)
    }
  })
  const rpc = (method, params = {}) => new Promise((done) => {
    const id = ++next; pending.set(id, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args })
    return r.error ? r : JSON.parse(r.result.content[0].text)
  }
  try {
    assert.ok((await rpc('initialize')).result.capabilities.tools)
    const list = (await rpc('tools/list')).result.tools
    assert.ok(list.some((t) => t.name === 'douyin_memory_search'))
    const draftSchema = list.find((t) => t.name === 'douyin_draft').inputSchema
    assert.ok(draftSchema.required.includes('ticket')); assert.ok(!draftSchema.required.includes('target'))
    const failed = await call('douyin_pick', { id: '123', reason: '没有人格 ticket' })
    assert.match(failed.error.message, /先调用/)
    const ctx = await call('douyin_self_context', { purpose: 'diary' })
    const written = await call('douyin_diary_write', { day: '2026-10-01', experiences: '今天认识了木工榫卯，记录自己的好奇。', ticket: ctx.ticket })
    assert.equal(written.source, 'diary:2026-10-01@1')
    const found = await call('douyin_memory_search', { query: '榫卯' })
    assert.equal(found[0].source, written.source)
    const remembered = await call('douyin_memory_remember', { kind: 'insight', title: '好奇', body: '我对手工有兴趣。', sources: [written.source] })
    const updated = await call('douyin_self_evolve', { patch: { interests: ['手工'] }, reason: '先观察再判断', sources: [remembered.source], expectedRevision: 1 })
    assert.equal(updated.revision, 2)
    await call('douyin_working_replace', { rows: [{ key: '当前兴趣', text: '想继续了解手工', sources: [remembered.source] }] })
    assert.equal((await call('douyin_self_context')).table[0].text, '想继续了解手工')
    writeFileSync(join(home, 'config.json'), JSON.stringify({ sources: { feed: false } }))
    assert.match((await call('douyin_feed')).error, /未开启/)
    assert.doesNotMatch(stderr, /ECONNREFUSED/)
  } finally {
    child.stdin.end()
    await new Promise((done) => child.once('exit', done))
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep))
    rmSync(home, { recursive: true, force: true })
  }
})
