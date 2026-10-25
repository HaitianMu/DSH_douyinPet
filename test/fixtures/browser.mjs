import { runInNewContext } from 'node:vm'
import { BrowsePacer } from '../../lib/pacing.mjs'

/** Synthetic DOM/CDP only: evaluate the real page expressions without a network. */
export function syntheticBrowser({ home = '', verifyAt = Infinity, verifyAfterCapture = false, ready = true } = {}) {
  let clock = 100_000
  let playbackAt = null
  let currentTimeWrites = 0
  const requests = []; const captures = []; const opened = []; const closed = []
  const response = { status: 200, status_code: 0, status_msg: '', user: { uid: 'synthetic', nickname: '合成账号' } }
  const video = {
    readyState: ready ? 4 : 0, muted: false, playbackRate: 2, loop: false, paused: true, duration: 60,
    get currentTime() { return playbackAt === null ? 0 : (clock - playbackAt) / 1000 },
    set currentTime(_value) { currentTimeWrites++ },
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 200, height: 400 }),
    async play() { playbackAt = clock; this.paused = false },
    pause() { this.paused = true },
  }
  const page = { target: { id: 'synthetic-video' }, cdp: null }
  const document = {
    title: '合成页面',
    body: { get innerText() { return clock >= verifyAt || (verifyAfterCapture && captures.length) ? '请完成安全验证' : '合成画面' } },
    querySelector: () => video, querySelectorAll: () => [video],
  }
  const fetch = async (path) => {
    requests.push({ path, at: clock })
    const items = Array.from({ length: 10 }, (_, i) => ({ aweme_id: 'synthetic-' + i, desc: '合成内容', video: { duration: 60_000 } }))
    return { status: response.status, ok: response.status < 400, text: async () => JSON.stringify({ ...response, aweme_list: items, data: items }) }
  }
  page.cdp = {
    async send(method, args = {}) {
      if (method === 'Runtime.evaluate') return { result: { value: await runInNewContext(args.expression, { document, location: { href: 'https://www.douyin.com/video/synthetic', origin: 'https://www.douyin.com' }, fetch }) } }
      if (method === 'Page.captureScreenshot') { captures.push({ at: clock, clip: args.clip }); return { data: Buffer.from('synthetic-png').toString('base64') } }
      return {}
    },
    close() {},
  }
  const session = {
    async tab(url) { opened.push({ url, at: clock }); return page },
    async close(id) { closed.push({ id, at: clock }) },
  }
  const now = () => clock
  const wait = async (ms) => { clock += ms }
  const attachClock = (dy) => {
    dy.now = now; dy.wait = wait; dy.pacer = new BrowsePacer({ dir: home, now, wait })
    dy.ctxPage = async () => page
    return dy
  }
  return { session, page, now, wait, advance: (ms) => { clock += ms }, video, requests, captures, opened, closed, response, attachClock, timeWrites: () => currentTimeWrites }
}
