import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import net from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { apply } from '../index.js'
import { BrowserSession } from '../lib/browser.mjs'
import { Cdp, launchBrowser, pickPort } from '../lib/cdp.mjs'
import { Douyin } from '../lib/douyin.mjs'

function temporaryHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'douyin-login-test-'))
  const home = join(root, 'douyin-duty')
  mkdirSync(home)
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    rmSync(root, { recursive: true, force: true })
  })
  return { root, home }
}

// All browser processes, HTTP, sockets and CDP messages below are synthetic.
function fakeBrowser(t) {
  const { root, home } = temporaryHome(t)
  const running = new Map(); const launches = []; const calls = []
  let seq = 0
  const mocks = []
  mocks.push(t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url)
    assert.equal(u.hostname, '127.0.0.1')
    const info = running.get(Number(u.port))
    if (!info) throw new Error('synthetic connection refused')
    assert.equal(u.pathname, '/json/version')
    return { ok: true, json: async () => info }
  }))
  mocks.push(t.mock.method(net, 'createConnection', ({ port }) => {
    const socket = Object.assign(new EventEmitter(), { destroy() {} })
    queueMicrotask(() => socket.emit(running.has(port) ? 'connect' : 'error', new Error('synthetic socket')))
    return socket
  }))
  mocks.push(t.mock.method(childProcess, 'spawn', (command, args) => {
    const port = Number(args.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1])
    const wsUrl = `ws://127.0.0.1:${port}/devtools/browser/synthetic-${++seq}`
    const proc = Object.assign(new EventEmitter(), { pid: seq, unref() {}, kill() { running.delete(port) } })
    running.set(port, { Browser: 'Synthetic', 'User-Agent': args.includes('--headless=new') ? 'HeadlessChrome' : 'Chrome', webSocketDebuggerUrl: wsUrl })
    launches.push({ command, args, port, wsUrl, proc })
    return proc
  }))
  mocks.push(t.mock.method(Cdp, 'connect', async (wsUrl) => ({
    async send(method, params) {
      calls.push({ wsUrl, method, params })
      if (method === 'Browser.close') running.delete(Number(new URL(wsUrl).port))
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'synthetic-page' }] }
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      return {}
    },
    close() { calls.push({ wsUrl, method: 'disconnect' }) },
  })))
  const previousBrowser = process.env.DOUYIN_BROWSER
  process.env.DOUYIN_BROWSER = process.execPath
  syncBuiltinESMExports()
  t.after(() => {
    if (previousBrowser === undefined) delete process.env.DOUYIN_BROWSER
    else process.env.DOUYIN_BROWSER = previousBrowser
    for (const mock of mocks.reverse()) mock.mock.restore()
    syncBuiltinESMExports()
  })
  return { root, home, running, launches, calls }
}

function hostFixture(t) {
  const { root, home } = temporaryHome(t)
  const disposers = []; const tools = new Map(); let handler
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden in offline login tests') })
  t.mock.method(BrowserSession.prototype, 'stop', async () => {})
  apply({
    get: (key) => key === 'dshHomePath' ? (leaf) => join(root, leaf) : undefined,
    tools: { register: (spec) => { tools.set(spec.name, spec); return () => {} } },
    effect: (effect) => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
    webServer: { register: (spec) => { handler = spec.handler; return () => {} } },
  }, {})
  t.after(() => { for (const dispose of disposers.reverse()) dispose() })
  const api = async (path, { method = 'GET', token, body } = {}) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.url = '/api/douyin-duty' + path; req.method = method
    req.headers = { host: '127.0.0.1:13579', 'content-type': 'application/json', ...(token ? { 'x-douyin-token': token } : {}) }
    let status; let data
    await handler(req, { writeHead: (code) => { status = code }, end: (raw) => { data = JSON.parse(raw) } })
    return { status, data }
  }
  return { root, home, api, tools }
}

test('auto mode and concurrent checks reuse one dedicated browser without restarting', async (t) => {
  const { home, launches, calls } = fakeBrowser(t)
  const session = new BrowserSession({ dir: home })
  await Promise.all([session.start(), session.start()])
  assert.equal(launches.length, 1)
  assert.equal(session.mode, 'hidden')
  await session.setMode('auto'); await session.start()
  assert.equal(launches.length, 1)
  assert.equal(calls.filter((c) => c.method === 'Browser.close').length, 0)
  await session.setMode('visible')
  assert.equal(session.mode, 'visible')
  assert.equal(launches.length, 1)
  assert.ok(calls.some((c) => c.method === 'Browser.setWindowBounds' && c.params.bounds.left === 120))
  const runtime = JSON.parse(readFileSync(session.runtimeFile, 'utf8'))
  assert.equal(runtime.wsUrl, launches[0].wsUrl)
  assert.equal(runtime.userDataDir, join(home, 'browser'))
})

test('auto fallback keeps reusing headless across checks and host restarts', async (t) => {
  const { home, launches, calls } = fakeBrowser(t)
  const syntheticSpawn = childProcess.spawn
  let attempts = 0
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (++attempts > 1) return syntheticSpawn(command, args, options)
    const proc = Object.assign(new EventEmitter(), { unref() {}, kill() {} })
    queueMicrotask(() => proc.emit('error', new Error('synthetic hidden launch denied')))
    return proc
  })
  syncBuiltinESMExports()
  const first = new BrowserSession({ dir: home })
  await first.start()
  assert.equal(first.mode, 'headless')
  await first.setMode('auto'); await first.start()
  const second = new BrowserSession({ dir: home })
  await second.start()
  assert.equal(second.mode, 'headless')
  assert.equal(second.requestedMode, 'auto')
  assert.equal(attempts, 2)
  assert.equal(launches.length, 1)
  assert.equal(calls.filter((c) => c.method === 'Browser.close').length, 0)
})

test('reused headless browser exits gracefully before opening the same profile visibly', async (t) => {
  const { home, launches, calls, running } = fakeBrowser(t)
  const first = new BrowserSession({ dir: home, mode: 'headless' })
  await first.start()
  const second = new BrowserSession({ dir: home, mode: 'visible' })
  await second.start()
  assert.equal(launches.length, 2)
  assert.ok(launches[1].args.includes('--window-position=120,80'))
  assert.ok(!launches[1].args.includes('--window-position=-32000,-32000'))
  assert.ok(!launches[1].args.includes('--headless=new'))
  assert.ok(calls.some((c) => c.method === 'Browser.close' && c.wsUrl === launches[0].wsUrl))
  assert.ok(launches.every((p) => p.args.includes('--user-data-dir=' + join(home, 'browser'))))
  assert.equal(second.mode, 'visible')
  await second.stop()
  assert.equal(running.size, 0)
  assert.equal(calls.filter((c) => c.method === 'Browser.close').length, 2)
})

test('a browser reopened by another host is reused and closed even without a process handle', async (t) => {
  const { home, launches, running } = fakeBrowser(t)
  const first = new BrowserSession({ dir: home, mode: 'visible' }); await first.start()
  const second = new BrowserSession({ dir: home, mode: 'visible' }); await second.start()
  assert.equal(launches.length, 1); assert.equal(second.proc, null)
  await second.stop()
  assert.equal(running.size, 0)
})

test('ports from other profiles are never adopted or closed, including stale recorded ports', async (t) => {
  const { home, launches, running, calls } = fakeBrowser(t)
  const foreign = { Browser: 'Synthetic foreign', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/foreign' }
  running.set(9333, foreign)
  assert.deepEqual(await pickPort({ from: 9333, to: 9334 }), { port: 9334, reused: false, info: null })
  writeFileSync(join(home, 'browser-runtime.json'), JSON.stringify({ port: 9333, wsUrl: 'ws://127.0.0.1:9333/devtools/browser/old', userDataDir: join(home, 'browser') }))
  const session = new BrowserSession({ dir: home, mode: 'visible' }); await session.start()
  assert.equal(session.port, 9334)
  const fixed = new BrowserSession({ dir: home, port: 9333 })
  await assert.rejects(fixed.start(), /不属于/)
  await assert.rejects(fixed.stop(), /未关闭其他实例/)
  assert.equal(running.get(9333), foreign)
  assert.equal(launches.length, 1)
  assert.equal(calls.filter((c) => c.method === 'Browser.close').length, 0)
})

test('browser launch errors are reported and modern cookie file locations are recognized', async (t) => {
  const { home, running } = fakeBrowser(t)
  t.mock.method(childProcess, 'spawn', () => {
    const proc = Object.assign(new EventEmitter(), { unref() {}, kill() {} })
    queueMicrotask(() => proc.emit('error', new Error('synthetic launch denied')))
    return proc
  })
  syncBuiltinESMExports()
  await assert.rejects(launchBrowser({ userDataDir: join(home, 'browser'), port: 9333, mode: 'visible' }), /synthetic launch denied/)
  assert.equal(running.size, 0)
  const cookies = join(home, 'browser', 'Default', 'Network')
  mkdirSync(cookies, { recursive: true }); writeFileSync(join(cookies, 'Cookies'), 'synthetic bytes')
  assert.equal(new BrowserSession({ dir: home }).hasProfile, true)
})

test('visible launch reports immediate process exits even when CDP responds during shutdown', async (t) => {
  const { home, running } = fakeBrowser(t)
  let kills = 0; let probes = 0
  const attempts = []
  const proc = Object.assign(new EventEmitter(), { unref() {}, kill() { kills++ } })
  t.mock.method(childProcess, 'spawn', (_command, args) => { attempts.push(args); return proc })
  t.mock.method(globalThis, 'fetch', async () => {
    probes++
    proc.emit('exit', 23, null)
    return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/exiting' }) }
  })
  syncBuiltinESMExports()
  await assert.rejects(new BrowserSession({ dir: home, mode: 'visible' }).start(), /立即退出（退出码 23）/)
  assert.equal(probes, 1)
  assert.equal(kills, 1)
  assert.equal(attempts.length, 1)
  assert.ok(attempts[0].includes('--window-position=120,80'))
  assert.ok(!attempts[0].includes('--headless=new'))
  assert.equal(running.size, 0)
})

test('login polling keeps the visible window and shared page through config and status refreshes', async (t) => {
  const { api, home, tools } = hostFixture(t)
  const token = (await api('/token')).data.token
  const modes = []; let starts = 0; let pages = 0; let loggedIn = false
  t.mock.method(BrowserSession.prototype, 'setMode', async function (mode) { modes.push(mode); this.mode = mode; return {} })
  t.mock.method(BrowserSession.prototype, 'start', async () => { starts++; return { reused: true } })
  t.mock.method(BrowserSession.prototype, 'show', async () => true)
  t.mock.method(BrowserSession.prototype, 'alive', async () => true)
  t.mock.method(BrowserSession.prototype, 'aliveInfo', async () => ({ alive: true, mode: 'visible' }))
  t.mock.method(Douyin.prototype, 'ctxPage', async () => { pages++; return { cdp: { send: async () => ({}) } } })
  t.mock.method(Douyin.prototype, 'whoami', async () => ({ loggedIn, name: loggedIn ? '合成账号' : '' }))
  assert.equal((await api('/login/poll')).data.state, 'idle'); assert.equal(starts, 0)
  assert.equal((await api('/login/start', { method: 'POST' })).status, 403)
  assert.equal((await api('/login/start', { method: 'POST', token, body: {} })).status, 200)
  assert.deepEqual(modes, ['visible']); assert.equal(pages, 1)
  assert.equal((await api('/login/poll')).data.state, 'wait')
  assert.equal((await api('/status')).data.loginPending, true)
  assert.equal((await api('/config', { method: 'POST', token, body: { browserMode: 'headless' } })).data.cfg.browserMode, 'headless')
  assert.deepEqual(modes, ['visible']); assert.equal(starts, 1)
  assert.equal((await api('/run', { method: 'POST', token, body: {} })).data.busy, true)
  assert.equal((await api('/home', { method: 'POST', token, body: { home: join(home, '..', 'target') } })).status, 409)
  loggedIn = true
  assert.equal((await api('/login/poll')).data.state, 'ok')
  const status = (await api('/status')).data
  assert.equal(status.loggedIn, true); assert.equal(status.who, '合成账号')
  assert.deepEqual(modes, ['visible']); assert.equal(starts, 1)
  assert.equal((await api('/login/poll')).data.state, 'idle')
  await tools.get('douyin_whoami').execute({})
  assert.deepEqual(modes, ['visible', 'headless'])
})

test('failed login, closed windows and cancellation stop polling without reopening a browser', async (t) => {
  const { api, root, home } = hostFixture(t)
  const token = (await api('/token')).data.token
  let starts = 0; let shown = false; let alive = true; const dirs = []
  t.mock.method(BrowserSession.prototype, 'setMode', async () => ({}))
  t.mock.method(BrowserSession.prototype, 'start', async function () { starts++; dirs.push(this.dir); return { reused: true } })
  t.mock.method(BrowserSession.prototype, 'show', async () => shown)
  t.mock.method(BrowserSession.prototype, 'alive', async () => alive)
  t.mock.method(Douyin.prototype, 'ctxPage', async () => ({ cdp: { send: async () => ({}) } }))
  t.mock.method(Douyin.prototype, 'whoami', async () => ({ loggedIn: false }))
  const failed = await api('/login/start', { method: 'POST', token, body: {} })
  assert.equal(failed.status, 500); assert.match(failed.data.error, /显示/)
  assert.match(readFileSync(join(home, 'duty.log'), 'utf8'), /打开登录窗口失败：无法把登录窗口显示到屏幕上/)
  assert.equal((await api('/login/poll')).data.state, 'idle')
  shown = true
  assert.equal((await api('/login/start', { method: 'POST', token, body: {} })).status, 200)
  alive = false
  assert.equal((await api('/login/poll')).data.state, 'closed')
  assert.equal(starts, 2)
  alive = true
  await api('/login/start', { method: 'POST', token, body: {} })
  assert.equal((await api('/login/cancel', { method: 'POST', body: {} })).status, 403)
  assert.equal((await api('/login/cancel', { method: 'POST', token, body: {} })).status, 200)
  assert.equal((await api('/login/poll')).data.state, 'idle')
  assert.equal(starts, 3)
  const target = join(root, 'moved-home')
  assert.equal((await api('/home', { method: 'POST', token, body: { home: target } })).status, 200)
  assert.ok(existsSync(join(target, 'config.json')))
  await api('/login/start', { method: 'POST', token, body: {} })
  assert.deepEqual(dirs, [home, home, home, target])
})

test('anonymous self-profile responses do not count as a logged-in account', async () => {
  const dy = new Douyin({})
  for (const user of [{}, { uid: '0', nickname: '游客' }]) {
    dy.api = async () => ({ status_code: 0, user })
    assert.equal((await dy.whoami()).loggedIn, false)
  }
  dy.api = async () => ({ status_code: 0, user: { uid: 'synthetic-uid', nickname: '合成账号' } })
  assert.equal((await dy.whoami()).loggedIn, true)
})

test('concurrent login checks share one request and expiration stops the session', async (t) => {
  const { api } = hostFixture(t)
  const token = (await api('/token')).data.token
  t.mock.method(BrowserSession.prototype, 'setMode', async () => ({}))
  t.mock.method(BrowserSession.prototype, 'start', async () => ({ reused: true }))
  t.mock.method(BrowserSession.prototype, 'show', async () => true)
  t.mock.method(BrowserSession.prototype, 'alive', async () => true)
  t.mock.method(Douyin.prototype, 'ctxPage', async () => ({ cdp: { send: async () => ({}) } }))
  let checks = 0; let enter; let finish
  const entered = new Promise((done) => { enter = done })
  const finished = new Promise((done) => { finish = done })
  t.mock.method(Douyin.prototype, 'whoami', async () => { checks++; enter(); return finished })
  await api('/login/start', { method: 'POST', token, body: {} })
  const first = api('/login/poll'); await entered
  const second = api('/login/poll')
  await new Promise(setImmediate)
  assert.equal(checks, 1)
  finish({ loggedIn: false })
  for (const result of await Promise.all([first, second])) assert.equal(result.data.state, 'wait')
  const future = Date.now() + 6 * 60_000
  t.mock.method(Date, 'now', () => future)
  assert.equal((await api('/login/poll')).data.state, 'expired')
  assert.equal((await api('/login/poll')).data.state, 'idle')
  assert.equal(checks, 1)
})

test('CDP disconnection rejects pending commands immediately and releases them', async () => {
  const ws = Object.assign(new EventTarget(), { send() {}, close() {} })
  const cdp = new Cdp(ws)
  const pending = cdp.send('Runtime.evaluate', {}, 60_000)
  ws.dispatchEvent(new Event('close'))
  await assert.rejects(pending, /连接已断开/)
  assert.equal(cdp.pending.size, 0)
  const next = cdp.send('Page.enable', {}, 60_000)
  cdp.close()
  await assert.rejects(next, /连接已关闭/)
  assert.equal(cdp.pending.size, 0)
})
