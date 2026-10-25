/**
 * lib/browser.mjs —— 浏览器会话（**一台常驻的浏览器，插件自己养着**）
 * ============================================================================
 * 为什么"常驻"而不是"用完就关"：
 *   · 抖音的**登录态**就在这个 profile 里，开开关关容易掉登录、也慢；
 *   · 截帧要真的播视频，每次冷启动要等好几秒。
 * ⇒ 起一次，用一整天；dsh 关掉时再由插件收摊（`ctx.effect` 里 stop）。
 *
 * ⚠️ 四条硬规矩：
 *   1. **独立 user-data-dir**（跟使用者日常那个浏览器完全隔离，不碰他的书签/密码）；
 *   2. 进程 **detached + unref**，别拖住宿主退出；
 *   3. **端口复用**：同一个 profile 起不了第二台浏览器 ⇒ 先复用（见 cdp.mjs pickPort）；
 *   4. **三种显示方式**（2026-10-24 新增，用户要求"别弹窗抢前台"）：
 *        auto（默认，先 hidden 失败退 headless）/ hidden（真窗口挪到屏幕外+最小化）
 *        / headless（无窗口）/ visible（登录扫码时才用）
 * ============================================================================
 */
import { launchBrowser, openTab, closeTab, probeCdp, pickPort, cdpHealthy, portFree, closeBrowser, Cdp } from './cdp.mjs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const BROWSER_MODES = ['auto', 'hidden', 'headless', 'visible']

export class BrowserSession {
  constructor({ dir, port = 0, mode = 'auto', headless = false, log = () => {} } = {}) {
    this.dir = dir
    this.port = port
    this.mode = String(mode || (headless ? 'headless' : 'auto'))
    this.requestedMode = this.mode
    this.log = log
    this.userDataDir = join(dir, 'browser')
    this.runtimeFile = join(dir, 'browser-runtime.json')
    this.proc = null
    this.tabs = new Set()
    this.connections = new Map()
    this.wsUrl = ''
    this.starting = null
  }

  /** 账本：上次用的端口 —— 端口复用靠它 */
  recordedPort() {
    return Number(this.readRuntime()?.port) || 0
  }

  readRuntime() {
    try {
      const j = JSON.parse(readFileSync(this.runtimeFile, 'utf8'))
      if (j?.userDataDir && resolve(j.userDataDir) !== resolve(this.userDataDir)) return null
      return j
    } catch { return null }
  }

  saveRuntime(extra = {}) {
    try {
      writeFileSync(this.runtimeFile, JSON.stringify({ port: this.port, mode: this.mode, requestedMode: this.requestedMode, wsUrl: this.wsUrl, userDataDir: this.userDataDir, at: new Date().toISOString(), ...extra }, null, 2), 'utf8')
    } catch { /* 记账失败不影响跑 */ }
  }

  async alive() {
    return (await this.aliveInfo()).alive
  }

  /** 只探活，不起浏览器（面板刷新用这个） */
  async aliveInfo() {
    const info = await probeCdp(this.port || this.recordedPort())
    const runtime = this.readRuntime()
    const expected = this.wsUrl || runtime?.wsUrl
    const alive = Boolean(info && (!expected || info.webSocketDebuggerUrl === expected))
    return { alive, port: this.port || this.recordedPort(), mode: this.wsUrl ? this.mode : (runtime?.mode || this.mode), browser: alive ? info?.Browser || '' : '' }
  }

  /** 保证浏览器活着（已活就复用） */
  async start(url = 'about:blank') {
    if (this.starting) return this.starting
    this.starting = this.startBrowser(url)
    try { return await this.starting } finally { this.starting = null }
  }

  async startBrowser(url) {
    const runtime = this.readRuntime()
    const autoHeadless = this.mode === 'headless' || (runtime?.requestedMode === 'auto' && runtime.mode === 'headless')
    const wantMode = this.requestedMode === 'auto' ? (autoHeadless ? 'headless' : 'hidden') : this.requestedMode
    const expected = this.wsUrl || runtime?.wsUrl || ''
    // ⭐ 2026-10 真机踩坑：构造函数里给了明确端口就别再"挑"——
    //   挑端口会命中一个卡死的实例（HTTP 答话正常、WS 永不回），之后所有 CDP 命令都超时。
    const fixed = Number(this.port) > 0
    let pick
    if (fixed) {
      const healthy = await cdpHealthy(this.port, 2_000)
      if (healthy && (!expected || healthy.webSocketDebuggerUrl !== expected)) throw new Error(`调试端口 ${this.port} 不属于当前抖音专用实例，请关闭旧的专用浏览器或更换端口`)
      if (!healthy && !(await portFree(this.port))) {
        throw new Error(`端口 ${this.port} 被一个不响应的浏览器占着 —— 换个端口或先关掉它`)
      }
      pick = { port: this.port, reused: Boolean(healthy), info: healthy }
    } else {
      pick = await pickPort({ recorded: this.recordedPort(), wsUrl: expected })
    }
    this.port = pick.port
    if (pick.reused) {
      const info = pick.info
      this.wsUrl = info.webSocketDebuggerUrl
      // ⭐ 2026-10-24 真机事故：复用到的是**之前 headless 起的那个**，屏幕上根本没有窗口，
      //   主人点「登录抖音」只看到日志说"已打开登录窗口"，实际什么也没弹出来。
      //   要可见却没窗口 ⇒ 关掉重开（走 CDP，不误杀主人自己的 Edge）。
      const headless = /headless/i.test(String(info?.['User-Agent'] || ''))
      const needWindow = wantMode === 'visible' || wantMode === 'hidden'
      if ((headless && needWindow) || (!headless && wantMode === 'headless')) {
        this.log(`浏览器需要切到 ${wantMode}，关闭原实例后重开`)
        if (!(await closeBrowser(this.port))) throw new Error('无窗口浏览器未能关闭，请先关闭抖音专用浏览器再登录')
        pick = { port: this.port, reused: false }
      } else {
        this.mode = headless ? 'headless' : (runtime?.mode || wantMode)
        if (wantMode === 'visible' && this.mode !== 'visible') {
          if (!(await this.show())) {
            if (!(await closeBrowser(this.port))) throw new Error('无法显示或关闭抖音专用浏览器，请先手动关闭后重新登录')
            return this.launch(wantMode, url)
          }
          this.mode = 'visible'
        }
        if (wantMode === 'hidden' && this.mode !== 'hidden') { await this.minimize(); this.mode = 'hidden' }
        this.saveRuntime({ reused: true })
        this.log(`复用已开的浏览器（端口 ${this.port}）`)
        return { reused: true, port: this.port }
      }
    }
    return this.launch(wantMode, url)
  }

  async launch(wantMode, url) {
    let r
    try {
      r = await launchBrowser({ userDataDir: this.userDataDir, port: this.port, mode: wantMode, url })
    } catch (e) {
      // auto：hidden 起不来就退 headless（有些机器挪到屏幕外会被窗口管理器拒绝）
      if (this.requestedMode === 'auto' && wantMode !== 'headless') {
        this.log(`hidden 模式起不来（${e?.message ?? e}），退回 headless`)
        r = await launchBrowser({ userDataDir: this.userDataDir, port: this.port, mode: 'headless', url })
      } else throw e
    }
    this.proc = r.proc
    this.mode = r.mode
    this.wsUrl = r.wsUrl
    this.saveRuntime({ pid: r.proc?.pid || 0 })
    this.log(`浏览器已起（${r.browser.replace(/\\/g, '/').split('/').pop()}，${r.mode}），调试端口 ${this.port}`)
    if (r.mode === 'hidden') await this.minimize()
    return { reused: false, browser: r.browser, mode: r.mode }
  }

  /** 把所有窗口最小化（hidden 模式下用；比"挪到屏幕外"更稳） */
  async minimize() {
    let cdp
    try {
      const info = await probeCdp(this.port)
      if (!info?.webSocketDebuggerUrl) return false
      cdp = await Cdp.connect(info.webSocketDebuggerUrl, 8_000)
      const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, 8_000)
      let n = 0
      for (const t of targetInfos.filter((x) => x.type === 'page')) {
        try {
          const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId }, 8_000)
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }, 8_000)
          n++
        } catch { /* 这个窗口不让改就算了 */ }
      }
      this.log(`已把 ${n} 个窗口最小化（不抢前台）`)
      return n > 0
    } catch (e) {
      this.log(`最小化失败（不影响跑）：${e?.message ?? e}`)
      return false
    } finally { try { cdp?.close() } catch { /* 已关 */ } }
  }

  /**
   * 需要人看的时候（登录扫码）：切到可见窗口。
   * ⚠️ 2026-10-24 踩到的：hidden 模式是把窗口挪到屏幕外（--window-position=-32000,-32000），
   *   只把 windowState 设成 normal 等于"还原到原来的位置"= 还在屏幕外 ⇒ 主人点了「登录抖音」
   *   只看到日志写"已打开登录窗口"，屏幕上什么都没有。所以还原之后**必须再显式摆一次位置**。
   */
  async show() {
    let cdp
    try {
      const info = await probeCdp(this.port)
      if (!info?.webSocketDebuggerUrl) return false
      cdp = await Cdp.connect(info.webSocketDebuggerUrl, 8_000)
      const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, 8_000)
      let n = 0
      for (const t of targetInfos.filter((x) => x.type === 'page')) {
        try {
          const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId }, 8_000)
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, 8_000)
          // 再摆到主屏左上角（这一步才是"从屏幕外拽回来"的关键）
          await cdp.send('Browser.setWindowBounds', {
            windowId,
            bounds: { left: 120, top: 80, width: 1200, height: 900 },
          }, 8_000)
          n++
        } catch { /* 忽略 */ }
      }
      if (n) this.log(`已把 ${n} 个窗口摆到屏幕上（120, 80）`)
      return n > 0
    } catch (e) { this.log(`显示窗口失败：${e?.message ?? e}`); return false }
    finally { try { cdp?.close() } catch { /* 已关 */ } }
  }

  /** 切显示方式（登录时 visible，平时 hidden/headless）—— 变了才重启浏览器 */
  async setMode(mode) {
    if (!mode || mode === this.requestedMode) return { changed: false }
    if (!BROWSER_MODES.includes(mode)) throw new Error('不支持的浏览器窗口模式')
    if (await this.alive()) {
      if (mode === 'visible' && this.mode !== 'headless' && await this.show()) {
        this.mode = mode; this.requestedMode = mode; this.saveRuntime(); return { changed: true, restarted: false }
      }
      await this.stop()
    }
    this.mode = mode; this.requestedMode = mode
    await this.start()
    return { changed: true, restarted: true }
  }

  /** 开一个标签页（返回 CDP 连接） */
  async tab(url = 'about:blank') {
    await this.start()
    const { cdp, target } = await openTab({ port: this.port, url })
    this.tabs.add(target.id)
    this.connections.set(target.id, cdp)
    return { cdp, target }
  }

  async close(id) {
    this.tabs.delete(id)
    try { this.connections.get(id)?.close() } catch { /* 已关 */ }
    this.connections.delete(id)
    await closeTab(this.port, id)
  }

  /** 正常关闭本家浏览器，并等待退出、释放登录数据文件。 */
  async stop() {
    if (this.starting) { try { await this.starting } catch { /* 启动失败也要清理。 */ } }
    // 先用 CDP 正常退出，让浏览器把 Cookie 刷盘；复用的进程也需要这样关闭。
    const runtime = this.readRuntime()
    const port = this.port || this.recordedPort()
    const info = port ? await probeCdp(port) : null
    const expected = this.wsUrl || runtime?.wsUrl
    let closed = !info
    if (info) {
      if (!expected || info.webSocketDebuggerUrl !== expected) throw new Error('无法确认浏览器属于当前抖音家目录，未关闭其他实例；请手动关闭抖音专用浏览器')
      closed = await closeBrowser(port)
    }
    if (!closed) throw new Error('抖音专用浏览器尚未退出，请手动关闭后再试')
    for (const id of [...this.tabs]) {
      try { this.connections.get(id)?.close() } catch { /* 已关 */ }
    }
    this.tabs.clear(); this.connections.clear(); this.proc = null; this.wsUrl = ''
  }

  /** 已登录检查用的兜底：看 profile 目录里有没有东西（有 cookie 才算数） */
  get hasProfile() {
    try { return ['Cookies', join('Network', 'Cookies')].some((path) => existsSync(join(this.userDataDir, 'Default', path))) } catch { return false }
  }
}

export { sleep }
