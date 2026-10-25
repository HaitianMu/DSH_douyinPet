/**
 * lib/douyin.mjs —— 抖音数据层（**本插件的地基**）
 * ============================================================================
 * 🔴 关键发现（本机实测 2026-10-23，写在最前面，免得后人再试一遍错路）：
 *   抖音的 web 接口**不用自己签名**。只要在**已登录的页面上下文**里 `fetch` 同源接口
 *   （cookie 里带 sessionid / ttwid），服务端就认 —— 实测 `search/item`、`tab/feed`、
 *   `aweme/post`、`aweme/detail`、`user/profile/self` 全部 `status_code=0` 正常返回 ✓。
 *   ⇒ 我们**不需要**去逆向 a_bogus / X-Bogus、也不需要 playwright。
 *   ⇒ 唯一的前提：**浏览器里得是登录态**（设置页点一次「登录抖音」即可，长期有效）。
 *
 * 另一条规矩：**给模型看的东西必须先瘦身**。
 *   一个 aweme 原始对象几十 KB，直接丢给模型会把 token 烧光 ⇒
 *   在**页面里**就把它压成下面这个精简结构（normalize），只留判断用得上的字段。
 * ============================================================================
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check as guardCheck, throwIfHit, DouyinAbort, inspect, abort } from './guard.mjs'
import { BrowsePacer, browseSettings, batchSize, sleep } from './pacing.mjs'

export { DouyinAbort }

const BASE = 'device_platform=webapp&aid=6383&channel=channel_pc_web'

/** 页面里执行的归一化函数（字符串注入）—— 把 aweme 对象压成精简结构 */
const NORMALIZE = `(a) => {
  if (!a) return null;
  const s = a.statistics || {};
  const au = a.author || {};
  const v = a.video || {};
  const cover = (v.cover?.url_list || v.origin_cover?.url_list || [])[0] || '';
  const dur = Number(v.duration || a.duration || 0) / 1000;
  const tags = [];
  for (const t of (a.text_extra || [])) { if (t && t.hashtag_name) tags.push(t.hashtag_name); }
  if (a.text_extra) for (const t of (a.text_extra || [])) { if (t && t.user_id) tags.push('@' + (t.user_unique_id || t.user_id)); }
  const ct = Number(a.create_time || 0);
  return {
    id: String(a.aweme_id || ''),
    desc: String(a.desc || '').slice(0, 500),
    author: { name: String(au.nickname || ''), secUid: String(au.sec_uid || ''), uid: String(au.uid || '') },
    stats: { like: s.digg_count|0, comment: s.comment_count|0, fav: s.collect_count|0, share: s.share_count|0, play: s.play_count|0 },
    durationSec: Math.round(dur),
    createdAt: ct ? new Date(ct * 1000).toISOString() : '',
    tags,
    cover,
    url: 'https://www.douyin.com/video/' + String(a.aweme_id || ''),
    isAd: Boolean(a.is_ads || a.is_top || (a.rawdata && a.rawdata.is_ad)),
  };
}`

/** 搜索结果有两种形状：直接 aweme，或包一层 aweme_info */
const NORMALIZE_SEARCH = `(item) => {
  if (!item) return null;
  const a = item.aweme_info || item.aweme || item;
  const n = (${NORMALIZE})(a);
  if (n && item.type !== undefined) n.searchType = item.type;
  return n;
}`

export class Douyin {
  /**
   * @param {BrowserSession} session
   * @param {{log?:Function, dir?:string, config?:Function, now?:Function, wait?:Function}} opts
   */
  constructor(session, { log = () => {}, dir = '', config = () => ({}), now = Date.now, wait = sleep } = {}) {
    this.session = session
    this.log = log
    this.dir = dir
    this.config = config
    this.now = now
    this.wait = wait
    this.pacer = new BrowsePacer({ dir, now, wait })
    this._queue = Promise.resolve()
    this._page = null       // 常驻的"API 上下文"标签（douyin.com 页面）
  }

  serial(fn) {
    const pending = this._queue.then(fn)
    this._queue = pending.catch(() => {})
    return pending
  }

  async responseGuard(page, status, message, phase) {
    const hit = inspect({ text: String(message || '') })
    if (status === 429 || status === 403 || hit) {
      throwIfHit(await abort(page, hit?.reason || `接口拒绝访问（HTTP ${status}），请稍后人工检查`, { dir: this.dir, log: this.log, phase }))
    }
    throwIfHit(await guardCheck(page, { dir: this.dir, log: this.log, phase }))
  }

  /** 拿到（或新建）一个 douyin.com 的常驻标签 —— 所有接口都在这个上下文里 fetch */
  async ctxPage() {
    if (this._page && this._page.cdp) {
      try { await this._page.cdp.send('Runtime.evaluate', { expression: 'location.origin' }, 5000); return this._page }
      catch { try { this._page.cdp.close() } catch { /* 已关 */ } this._page = null }
    }
    const t = await this.session.tab('https://www.douyin.com/')
    await t.cdp.send('Page.enable')
    await t.cdp.send('Runtime.enable')
    this._page = t
    // 等首屏就绪（cookie / sdk 要就位）
    await this.wait(3500)
    return t
  }

  /** 在页面上下文里 GET 一个接口，返回解析后的 JSON */
  async api(path, { timeout = 30_000 } = {}) {
    return this.serial(() => this._api(path, timeout))
  }

  async _api(path, timeout) {
    const page = await this.ctxPage()
    await this.pacer.take(browseSettings(this.config()).requestIntervalSeconds * 1000)
    // ⭐ 每一步之前先看页面：遇到验证码/掉登录/风控提示 ⇒ 抛 DouyinAbort，上层停下来写"没刷成"
    throwIfHit(await guardCheck(page, { dir: this.dir, log: this.log, phase: 'api ' + String(path).slice(0, 40) }))
    const { cdp } = page
    const expr = `fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { accept: 'application/json' } })
      .then(async r => ({ status: r.status, text: await r.text() }))`
    const raw = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout)
    if (raw?.exceptionDetails) throw new Error(String(raw.exceptionDetails.text || '接口请求失败'))
    const response = raw?.result?.value
    const txt = String(response?.text ?? '')
    let json
    try { json = JSON.parse(txt) } catch { /* Check HTML verification responses too. */ }
    await this.responseGuard(page, response?.status, json ? json.status_msg : txt.slice(0, 4000), 'api response')
    return json || { __raw: txt.slice(0, 500), status_code: -1 }
  }

  /**
   * ⭐ 取一批数据：**转换全在页面里做**，node 只收结果（一个 aweme 原始对象几十 KB，
   *    全传回来既慢又会把模型的 token 烧光）。
   */
  async listAll(path, { kind = 'aweme', limit = 3 } = {}) {
    return this.serial(() => this._listAll(path, kind, batchSize(limit)))
  }

  async _listAll(path, kind, limit) {
    const page = await this.ctxPage()
    await this.pacer.take(browseSettings(this.config()).requestIntervalSeconds * 1000)
    throwIfHit(await guardCheck(page, { dir: this.dir, log: this.log, phase: 'listAll ' + String(path).slice(0, 40) }))
    const { cdp } = page
    const expr = `(async () => {
      const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { accept: 'application/json' } });
      const txt = await r.text();
      if (!r.ok) return { ok:false, httpStatus:r.status, msg:'HTTP ' + r.status };
      let j; try { j = JSON.parse(txt) } catch (e) { return { ok:false, msg:'非JSON', raw: txt.slice(0,4000) } }
      if (j.status_code !== undefined && j.status_code !== 0) return { ok:false, status: j.status_code, msg: j.status_msg || '' };
      let arr = ${kind === 'search' ? `(j.data || j.aweme_list || [])` : `(j.aweme_list || j.data || [])`};
      if (!Array.isArray(arr)) arr = [];
      const NORM = ${NORMALIZE};
      const out = [];
      for (const it of arr) {
        const a = (it && (it.aweme_info || it.aweme)) || it;
        const n = NORM(a);
        if (n && n.id) out.push(n);
        if (out.length >= ${limit}) break;
      }
      return { ok: true, count: out.length, items: out };
    })()`
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 40_000)
    if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.text || '页面里执行失败').slice(0, 200))
    const result = r?.result?.value || { ok: false, msg: '没拿到结果' }
    await this.responseGuard(page, result.httpStatus, result.raw || result.msg, 'list response')
    return result
  }

  // ─────────────────────────── 具体场景 ───────────────────────────

  /** 我是谁（登录检查）：能拿到自己 = 登录着 */
  async whoami() {
    const j = await this.api(`/aweme/v1/web/user/profile/self/?${BASE}`)
    const u = j?.user
    if (j?.status_code === 0 && u && String(u.uid || '') !== '' && String(u.uid) !== '0') {
      return {
        ok: true, loggedIn: true,
        name: String(u.nickname || ''),
        uid: String(u.uid || ''),
        secUid: String(u.sec_uid || ''),
        followers: Number(u.follower_count || 0),
        following: Number(u.following_count || 0),
      }
    }
    return { ok: true, loggedIn: false, status: j?.status_code, msg: j?.status_msg || '没登录（去设置页点「登录抖音」）' }
  }

  /** 推荐流（主人没选这路，开关留着，想开随时能开） */
  async feed(n = 3) {
    const c = batchSize(n)
    return this.listAll(`/aweme/v1/web/tab/feed/?${BASE}&count=${c}`, { limit: c })
  }

  /** 关键词搜索 */
  async search(keyword, n = 3) {
    const kw = encodeURIComponent(String(keyword || '').slice(0, 60))
    if (!kw) return { ok: false, msg: '关键词是空的' }
    const c = batchSize(n)
    return this.listAll(`/aweme/v1/web/search/item/?${BASE}&keyword=${kw}&count=${c}&offset=0`, { kind: 'search', limit: c })
  }

  /** 热榜词条（不带视频，只是"今天什么在火"） */
  async hot(n = 3) {
    const j = await this.api(`/aweme/v1/web/hot/search/list/?${BASE}&detail_list=1`)
    const d = j?.data
    const list = Array.isArray(d) ? d : (d?.word_list || [])
    const out = []
    for (const w of list) {
      out.push({
        word: String(w.word || w.query || ''),
        hot: Number(w.hot_value || w.hot_score || 0),
        label: String(w.sentence_tag || w.label || ''),
        url: 'https://www.douyin.com/search/' + encodeURIComponent(String(w.word || w.query || '')),
      })
      if (out.length >= batchSize(n)) break
    }
    return { ok: true, count: out.length, items: out }
  }

  /** 热榜上的视频（挑前几个词各搜一下，省得一条条翻） */
  async hotVideos(words = 3, n = 3) {
    n = batchSize(n)
    const h = await this.hot(words)
    const items = []
    for (const w of h.items || []) {
      const s = await this.search(w.word, Math.max(2, Math.ceil((Number(n) || 6) / Math.max(1, words))))
      for (const it of s.items || []) { it.fromHot = w.word; items.push(it) }
      if (items.length >= n) break
    }
    return { ok: true, count: Math.min(items.length, n), items: items.slice(0, n) }
  }

  /** 关注流（你关注的博主最近发了什么） */
  async following(n = 3) {
    const c = batchSize(n)
    return this.listAll(`/aweme/v1/web/follow/feed/?${BASE}&count=${c}`, { limit: c })
  }

  /** 某个博主的作品（传 sec_uid 或主页链接都行） */
  async userPosts(secUid, n = 3) {
    let su = String(secUid || '').trim()
    const m = su.match(/\/user\/([A-Za-z0-9_\-]+)/)
    if (m) su = m[1]
    if (!su) return { ok: false, msg: '没给我 sec_uid 或主页链接' }
    const c = batchSize(n)
    return this.listAll(`/aweme/v1/web/aweme/post/?${BASE}&sec_user_id=${encodeURIComponent(su)}&count=${c}&max_cursor=0&publish_video_strategy_type=2`, { limit: c })
  }

  /** 单条详情（补字段 / 确认还在） */
  async detail(id) {
    const j = await this.api(`/aweme/v1/web/aweme/detail/?${BASE}&aweme_id=${encodeURIComponent(String(id || ''))}`)
    const a = j?.aweme_detail
    if (!a) return { ok: false, msg: j?.status_msg || '没拿到这条' }
    // 复用归一化：直接在页面里转一次
    const { cdp } = await this.ctxPage()
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(${NORMALIZE})(${JSON.stringify(a).replace(/</g, '\\u003c')})`,
      returnByValue: true,
    }, 20_000)
    return { ok: true, item: r?.result?.value || null }
  }

  /** 正常播放并按时间取样；不拖动进度条，成功取样也要停留满配置时长。 */
  async frames(id, n = 3, { dir } = {}) {
    return this.serial(() => this._frames(id, n, dir))
  }

  async _frames(id, n, dir) {
    const outDir = dir || join(this.dir || '.', 'frames')
    const shots = []
    const settings = browseSettings(this.config())
    const watchMs = settings.videoWatchSeconds * 1000
    const intervalMs = settings.requestIntervalSeconds * 1000
    let tab = null
    let aborted = false
    const check = async () => throwIfHit(await guardCheck(tab, { dir: this.dir, log: this.log, phase: 'frames ' + id }))
    try {
      // Reserve loading + watch time across host/MCP processes as well as this instance.
      await this.pacer.take(Math.max(intervalMs, watchMs + 12_000))
      tab = await this.session.tab(`https://www.douyin.com/video/${encodeURIComponent(String(id))}`)
      const { cdp } = tab
      await cdp.send('Page.enable')
      let ready = false
      for (let i = 0; i < 24; i++) {
        await this.wait(500)
        if (i % 4 === 0) await check()
        const st = await cdp.send('Runtime.evaluate', {
          expression: `(() => { const v = document.querySelector('video'); return v ? { ready: v.readyState, w: v.getBoundingClientRect().width } : null })()`,
          returnByValue: true,
        }, 10_000)
        if (st?.result?.value?.ready >= 2 && st.result.value.w > 40) { ready = true; break }
      }
      await check()
      if (!ready) return { ok: false, error: '这个页面里没等到可播放的视频（可能已下架 or 要登录）' }
      const play = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const v = document.querySelector('video');
          if (!v) return false;
          v.muted = true; v.playbackRate = 1; v.loop = true;
          try { await v.play(); return !v.paused } catch { return false }
        })()`,
        returnByValue: true, awaitPromise: true,
      }, 10_000)
      if (!play?.result?.value) {
        await check()
        return { ok: false, error: '视频未能正常播放，请在专用浏览器中检查' }
      }
      this.log(`正常播放视频 ${id}，至少停留 ${settings.videoWatchSeconds} 秒`)
      const startedAt = this.now()
      const count = Math.max(1, Math.min(Math.floor(Number(n)) || 3, 6))
      for (let i = 1; i <= count + 1; i++) {
        const target = startedAt + watchMs * i / (count + 1)
        while (this.now() < target) {
          await this.wait(Math.min(2000, target - this.now()))
          await check()
          this.pacer.defer(intervalMs)
        }
        await check()
        if (i > count) break
        const rect = await cdp.send('Runtime.evaluate', {
          expression: `(() => { const v = document.querySelector('video'); if (!v) return null; const r = v.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), seconds: v.currentTime, duration: v.duration } })()`,
          returnByValue: true,
        }, 10_000)
        const r = rect?.result?.value
        if (!r || r.w < 20 || r.h < 20) continue
        const pad = (v) => Math.round(v * 0.08)
        const clip = {
          x: r.x + pad(r.w), y: r.y + pad(r.h),
          width: Math.max(20, r.w - pad(r.w) * 2), height: Math.max(20, r.h - pad(r.h) * 2), scale: 1,
        }
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip }, 20_000)
        // A challenge can appear during capture; discard that image and stop immediately.
        await check()
        if (shot?.data) {
          const file = join(outDir, `${String(id)}_${i}.png`)
          try {
            writeFileSync(file, Buffer.from(shot.data, 'base64'))
            const at = r.duration > 0 ? Math.max(0, Math.min(1, r.seconds / r.duration)) : 0
            shots.push({ file, at: Math.round(at * 100) / 100, seconds: Number(r.seconds) || 0 })
          } catch (e) { this.log(`截帧保存失败：${e?.message ?? e}`) }
        }
      }
      return { ok: shots.length > 0, frames: shots, watchedSeconds: (this.now() - startedAt) / 1000, error: shots.length ? '' : '一帧都没截下来' }
    } catch (e) {
      if (e instanceof DouyinAbort) { aborted = true; throw e }
      return { ok: false, error: String(e?.message ?? e) }
    } finally {
      if (tab) {
        // Keep the challenge page available for the user, but stop video playback.
        if (aborted) {
          try { await tab.cdp.send('Runtime.evaluate', { expression: `document.querySelectorAll('video').forEach(v => v.pause())` }, 3000) } catch { /* Disconnected page. */ }
          try { tab.cdp.close() } catch { /* Already disconnected. */ }
        } else {
          try { await this.session.close(tab.target.id) } catch { /* Already closed. */ }
        }
        try { this.pacer.defer(intervalMs) } catch (e) { this.log(`浏览间隔保存失败：${e?.message ?? e}`); if (!aborted) throw e }
      }
    }
  }
}
