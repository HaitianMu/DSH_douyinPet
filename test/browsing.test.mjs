import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Douyin, DouyinAbort } from '../lib/douyin.mjs'
import { BrowsePacer } from '../lib/pacing.mjs'
import { syntheticBrowser } from './fixtures/browser.mjs'

function fixture(t, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'douyin-browsing-test-'))
  mkdirSync(join(home, 'frames'))
  t.after(() => {
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep))
    rmSync(home, { recursive: true, force: true })
  })
  const browser = syntheticBrowser({ home, ...opts })
  const cfg = {}
  const dy = browser.attachClock(new Douyin(browser.session, { dir: home, config: () => cfg }))
  return { home, browser, cfg, dy }
}

test('content requests are serialized, separated by 10 seconds, and batches never exceed 3', async (t) => {
  const { browser: b, dy, cfg } = fixture(t)
  const results = await Promise.all([dy.search('合成', 99), dy.feed(99), dy.following(99), dy.userPosts('synthetic-user', 99), dy.whoami()])
  for (const r of results.slice(0, 4)) { assert.equal(r.count, 3); assert.equal(r.items.length, 3) }
  assert.equal(results[4].loggedIn, true)
  assert.equal(b.requests.length, 5) // No automatic pagination to fill a batch.
  for (const r of b.requests.slice(0, 4)) assert.equal(new URL(r.path, 'https://www.douyin.com').searchParams.get('count'), '3')
  for (let i = 1; i < b.requests.length; i++) assert.ok(b.requests[i].at - b.requests[i - 1].at >= 10_000)
  cfg.requestIntervalSeconds = 25
  await dy.search('调慢'); await dy.search('调慢')
  assert.ok(b.requests.at(-1).at - b.requests.at(-2).at >= 25_000)
  cfg.requestIntervalSeconds = 0
  await dy.search('不能取消'); await dy.search('不能取消')
  assert.ok(b.requests.at(-1).at - b.requests.at(-2).at >= 10_000)
})

test('cooldown persists across instances and delayed callers recheck the current slot', async (t) => {
  const { home, browser: b } = fixture(t)
  const options = { dir: home, now: b.now, wait: b.wait }
  await new BrowsePacer(options).take(10_000)
  const initial = b.now()
  await new BrowsePacer(options).take(10_000)
  assert.equal(b.now() - initial, 10_000)
  let resume; let entered
  const waiting = new Promise((done) => { entered = done })
  const delayed = new BrowsePacer({ ...options, wait: async () => { entered(); await new Promise((done) => { resume = done }) } })
  const pending = delayed.take(10_000)
  await waiting
  b.advance(30_000)
  await new BrowsePacer(options).take(10_000)
  delayed.wait = b.wait
  const resumedAt = b.now(); resume()
  await pending
  assert.equal(b.now() - resumedAt, 10_000)
  writeFileSync(join(home, 'browse-pacing.json'), '{damaged}')
  await assert.rejects(new BrowsePacer(options).take(10_000), /无法读取/)
})

test('videos play normally for at least 30 seconds, with spaced samples and a cooldown before the next page', async (t) => {
  const { browser: b, dy, cfg } = fixture(t)
  const result = await dy.frames('synthetic', 3)
  assert.equal(result.ok, true)
  assert.equal(result.frames.length, 3)
  assert.ok(result.watchedSeconds >= 30)
  assert.ok(b.closed[0].at - b.opened[0].at >= 30_000)
  assert.equal(b.video.muted, true); assert.equal(b.video.playbackRate, 1)
  assert.equal(b.timeWrites(), 0)
  assert.equal(b.captures.length, 3)
  assert.ok(b.captures[1].at - b.captures[0].at >= 7500)
  await dy.frames('synthetic-next', 1)
  assert.ok(b.opened[1].at - b.closed[0].at >= 10_000)
  cfg.videoWatchSeconds = 45
  assert.ok((await dy.frames('synthetic-slower', 1)).watchedSeconds >= 45)
  cfg.videoWatchSeconds = 0
  assert.ok((await dy.frames('synthetic-minimum', 1)).watchedSeconds >= 30)
})

test('verification during video loading or capture propagates as an abort and preserves the challenge page', async (t) => {
  for (const opts of [{ ready: false, verifyAt: 100_500 }, { verifyAfterCapture: true }]) {
    const { home, dy, browser: b } = fixture(t, opts)
    await assert.rejects(dy.frames('synthetic'), (e) => e instanceof DouyinAbort && /安全验证/.test(e.reason))
    assert.equal(b.closed.length, 0)
    assert.equal(b.video.paused, true)
    assert.match(JSON.parse(readFileSync(join(home, 'abort-latest.json'), 'utf8')).reason, /安全验证/)
    assert.ok(b.now() < 130_000)
  }
})

test('HTTP rate limits and server verification messages abort both API and list calls', async (t) => {
  for (const method of ['whoami', 'feed']) {
    for (const response of [{ status: 429 }, { status: 403 }, { status_code: 1, status_msg: '访问频繁' }]) {
      const { home, dy, browser: b } = fixture(t)
      Object.assign(b.response, response)
      await assert.rejects(dy[method](), DouyinAbort)
      assert.ok(JSON.parse(readFileSync(join(home, 'abort-latest.json'), 'utf8')).reason)
      assert.equal(b.requests.length, 1)
    }
  }
})

test('MCP stops all subsequent browsing after a frame challenge while local status remains available', { timeout: 15_000 }, async (t) => {
  const { home } = fixture(t)
  const moduleUrl = (p) => new URL(p, import.meta.url).href
  const preload = join(home, 'synthetic-preload.mjs')
  writeFileSync(preload, `
    import { BrowserSession } from ${JSON.stringify(moduleUrl('../lib/browser.mjs'))};
    import { Douyin } from ${JSON.stringify(moduleUrl('../lib/douyin.mjs'))};
    import { syntheticBrowser } from ${JSON.stringify(moduleUrl('./fixtures/browser.mjs'))};
    const b = syntheticBrowser({ home: process.env.DOUYIN_HOME, verifyAfterCapture: true });
    BrowserSession.prototype.start = async () => ({});
    BrowserSession.prototype.tab = b.session.tab;
    BrowserSession.prototype.close = b.session.close;
    const serial = Douyin.prototype.serial;
    Douyin.prototype.serial = function (fn) { if (!this.synthetic) { b.attachClock(this); this.synthetic = true; } return serial.call(this, fn); };
  `)
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('../lib/mcp-server.mjs', import.meta.url))], {
    env: { ...process.env, DOUYIN_HOME: home, DOUYIN_PORT: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const exited = new Promise((done) => child.once('exit', done))
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited })
  let next = 0; let buffer = ''; let stderr = ''; const pending = new Map()
  child.stderr.on('data', (data) => { stderr += data })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1)
      const done = pending.get(msg.id); pending.delete(msg.id); done?.(msg)
    }
  })
  const call = async (name, args = {}) => {
    const response = await new Promise((done) => {
      const id = ++next; pending.set(id, done)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    })
    assert.equal(response.error, undefined, stderr)
    return JSON.parse(response.result.content[0].text)
  }
  assert.equal((await call('douyin_search', { keyword: '合成', n: 999 })).count, 3)
  assert.equal((await call('douyin_frames', { id: 'synthetic' })).aborted, true)
  for (const name of ['douyin_search', 'douyin_whoami', 'douyin_frames', 'douyin_pick', 'douyin_draft']) assert.equal((await call(name, { keyword: '停止', id: 'synthetic' })).aborted, true)
  const status = await call('douyin_status')
  assert.equal(status.scanned, 3)
  assert.equal(status.browse.batchLimit, 3)
  assert.equal(status.browse.videoWatchSeconds, 30)
  assert.equal((await call('douyin_seen', { ids: ['synthetic'] })).ok, true)
  child.stdin.end(); await exited
})
