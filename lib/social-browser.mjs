import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { check, throwIfHit, snapshot } from './guard.mjs'
import { browseSettings, sleep } from './pacing.mjs'

/** Only a positively identified one-to-one conversation is readable/sendable. */
export function chatDOM(action, a) {
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 }
  const selector = '[data-e2e="im-chat-panel"],[data-e2e="im-conversation"],[data-testid="chat-panel"],[class*="chat-room"],[class*="im-chat"]'
  const candidates = [...document.querySelectorAll(selector)].filter(visible)
  let headers = 0, profiles = 0, named = 0
  const roots = candidates.filter((e) => {
    const peers = [...e.querySelectorAll('header a[href*="/user/"],[data-e2e="chat-header"] a[href*="/user/"],[class*="chat-header"] a[href*="/user/"]')].filter(visible)
    if (!peers.length) return false
    headers++
    // An avatar and a nickname can be separate links to the same person.
    // Every visible header profile must still identify this exact recipient.
    if (!peers.every((p) => {
      try {
        const url = new URL(p.href, location.href)
        return url.protocol === 'https:' && url.hostname === 'www.douyin.com' && !url.username && !url.password && !url.port && url.pathname.replace(/\/$/, '') === '/user/' + a.secUid
      } catch { return false }
    })) return false
    profiles++
    if (!peers.some((p) => p.textContent.trim() === a.name)) return false
    named++
    // A matching header alone is not a conversation (nested header wrappers
    // also match class*=im-chat). Require an editor and a message area together.
    return [...e.querySelectorAll('[contenteditable="true"],textarea')].filter(visible).length === 1 &&
      (!!e.querySelector('[data-e2e="message-list"],[class*="message-list"],[role="log"]') ||
        [...e.querySelectorAll('[data-message-id]')].some(visible))
  })
  const smallest = roots.filter((e) => !roots.some((other) => other !== e && e.contains(other)))
  const reason = !candidates.length ? '未识别到可见的私信面板' : !headers ? '私信面板中没有可见的会话主页链接'
    : !profiles ? '会话标题中的主页链接不唯一或与名单不一致' : !named ? '会话标题昵称与名单不一致'
      : !roots.length ? '未识别到完整的消息列表和唯一输入框' : '存在多个无法区分的私信会话'
  const diagnostic = { candidates: candidates.length, headers, profiles, named, conversations: smallest.length }
  if (action === 'probe') return { ready: smallest.length === 1, reason: smallest.length === 1 ? '' : reason, diagnostic }
  if (smallest.length !== 1) throw new Error('无法唯一确认私信会话的主页和昵称，已停止：' + reason)
  const root = smallest[0]
  const editors = [...root.querySelectorAll('[contenteditable="true"],textarea')].filter(visible)
  const textOf = (e) => ('value' in e ? e.value : e.innerText || '').trim()
  const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }
  if (action === 'focus' || action === 'send') {
    if (editors.length !== 1) throw new Error('未找到唯一的私信输入框')
    const editor = editors[0]
    if (action === 'focus') {
      if (textOf(editor)) throw new Error('私信框有未发送内容，保留原文并停止')
      editor.focus(); return { focused: true }
    }
    if (textOf(editor) !== a.text) throw new Error('输入框内容与草稿不一致，停止发送')
    const buttons = [...root.querySelectorAll('button,[role="button"]')].filter(visible).filter((b) =>
      (b.textContent || b.getAttribute('aria-label') || '').trim() === '发送' && !b.disabled && b.getAttribute('aria-disabled') !== 'true')
    if (buttons.length !== 1) throw new Error('未找到唯一的私信发送按钮')
    return box(buttons[0])
  }
  const nodes = [...root.querySelectorAll('[data-message-id]')].filter(visible).slice(-30)
  const messages = nodes.map((node) => {
    const id = node.getAttribute('data-message-id')
    const sender = node.getAttribute('data-sender-id') || node.getAttribute('data-sender-uid')
    const self = node.getAttribute('data-is-self')
    if (sender && sender !== a.accountUid && sender !== a.uid) throw new Error('消息发送人不属于当前会话')
    if ((sender === a.accountUid && self === 'false') || (sender === a.uid && self === 'true')) throw new Error('消息发送人标记冲突')
    const role = sender === a.accountUid || self === 'true' ? 'self'
      : sender === a.uid || self === 'false' ? 'peer' : ''
    if (!id || !role) throw new Error('消息缺少稳定ID或发送人标记，无法安全处理')
    const body = node.querySelector('[data-e2e="message-text"],[data-message-type="text"],[class*="message-text"]')
    const text = String(body?.innerText || body?.textContent || '').trim()
    if (text.length > 2000) throw new Error('消息过长，交由人工处理')
    return { id, role, text }
  })
  if (!nodes.length && !root.querySelector('[data-e2e="message-list"],[class*="message-list"],[role="log"]')) throw new Error('未识别到消息列表，当前页面暂不支持自动回复')
  return { messages, editorEmpty: editors.length === 1 && !textOf(editors[0]) }
}

function buttonDOM(labels) {
  const nodes = [...document.querySelectorAll('button,a,[role="button"],span,div')].filter((e) => {
    if (!labels.includes((e.getAttribute('aria-label') || e.textContent || '').trim())) return false
    const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8 && !e.disabled
  })
  const smallest = nodes.filter((e) => !nodes.some((o) => o !== e && e.contains(o)))
  if (smallest.length !== 1) throw new Error('无法唯一定位按钮：' + labels.join('/'))
  const r = smallest[0].getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export function diaryHTML(day, text) {
  return `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#f4f0e7;color:#233f38;font:42px/1.8 "Microsoft YaHei",sans-serif;padding:110px 90px;width:1080px;height:1440px}header{font-size:30px;letter-spacing:4px;color:#687e6e}h1{font-size:66px;margin:24px 0 54px}article{white-space:pre-wrap;overflow-wrap:anywhere;font-size:38px;line-height:1.8}footer{position:absolute;bottom:68px;font-size:24px;color:#687e6e}</style><header>${escapeHtml(day)}</header><h1>今天的小日常</h1><article>${escapeHtml(text)}</article><footer>抖音大肥鱼 · AI 日常</footer>`
}

export class SocialBrowser {
  constructor(dy, { dir = dy.dir, config = dy.config, wait = sleep, authorize = async () => {} } = {}) {
    this.dy = dy; this.session = dy.session; this.dir = dir; this.config = config; this.wait = wait
    this.authorize = authorize
  }
  async evaluate(page, fn, ...args) {
    const r = await page.cdp.send('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true }, 15000)
    if (r?.exceptionDetails || !r?.result || !('value' in r.result)) throw new Error(r?.exceptionDetails?.exception?.description || r?.exceptionDetails?.text || '页面未返回结果')
    return r.result.value
  }
  async guard(page) {
    // Fail closed on an unreadable page; account actions must not skip inspection.
    if (!(await snapshot(page.cdp))?.url) throw new Error('无法检查页面状态，停止账号操作')
    const checked = await check(page, { dir: this.dir, log: this.dy.log, phase: 'social' })
    if (checked.skipped) throw new Error('页面检查中断，停止账号操作')
    throwIfHit(checked)
  }
  async click(page, box) {
    await this.guard(page)
    for (const type of ['mousePressed', 'mouseReleased']) await page.cdp.send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 }, 10000)
  }
  async open(url) {
    await this.dy.pacer.take(Math.max(60000, browseSettings(this.config()).requestIntervalSeconds * 1000))
    const page = await this.session.tab(url)
    try { await page.cdp.send('Page.enable'); await this.wait(3500); await this.guard(page); return page }
    catch (e) { if (e.name !== 'DouyinAbort') await this.close(page); throw e }
  }
  async close(page, keep = false) {
    if (!page) return
    try {
      if (!keep) await this.session.close(page.target.id)
      else page.cdp.close()
    } catch { /* Already closed; never retry an account action. */ }
    // Preserve the original error (especially verification) if pacing persistence fails.
    try { this.dy.pacer.defer(60000) } catch (e) { this.dy.log?.('互动间隔未保存：' + e.message) }
  }
  async account(expected = '') {
    const self = await this.dy.whoami()
    if (!self.loggedIn || !/^\d{1,30}$/.test(self.uid || '') || (expected && self.uid !== expected)) throw new Error('登录账号已变化或掉登录，停止互动和发布')
    return self
  }
  async mutual(contact) {
    const j = await this.dy.api('/aweme/v1/web/user/profile/other/?device_platform=webapp&aid=6383&sec_user_id=' + encodeURIComponent(contact.secUid))
    const u = j?.user
    const mutual = Number(u?.follow_status) === 2 || (Number(u?.follow_status) === 1 && Number(u?.follower_status) === 1)
    if (!/^\d{1,30}$/.test(String(u?.uid || '')) || u.sec_uid !== contact.secUid || u.nickname !== contact.name || !mutual) throw new Error('不能确认互关或昵称已变化：' + contact.name)
    return { ...contact, uid: String(u.uid) }
  }
  async waitForChat(page, args) {
    let status
    // Only poll the current page. Never reopen a conversation or retry Send.
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.guard(page)
      status = await this.evaluate(page, chatDOM, 'probe', args)
      if (status.ready) return
      if (attempt < 5) await this.wait(1000)
    }
    const counts = Object.entries(status.diagnostic).map(([key, n]) => key + '=' + n).join(',')
    this.dy.log?.('私信页面识别停止：' + status.reason + ' [' + counts + ']')
    throw new Error('无法唯一确认私信会话的主页和昵称，已停止：' + status.reason + '。未输入或发送文字；请检查会话标题，页面结构可能尚未适配')
  }
  async chat(contact, accountUid, fn) {
    let page, keep = false
    try {
      page = await this.open(contact.url)
      await this.click(page, await this.evaluate(page, buttonDOM, ['私信', '发私信']))
      await this.wait(2000); await this.guard(page)
      const args = { ...contact, accountUid }
      await this.waitForChat(page, args)
      const state = await this.evaluate(page, chatDOM, 'read', args)
      return await fn(page, state, args)
    } catch (e) { keep = e.name === 'DouyinAbort'; throw e }
    finally { await this.close(page, keep) }
  }
  async readChat(contact, accountUid) {
    await this.account(accountUid)
    return this.chat(contact, accountUid, async (_page, state) => {
      await this.account(accountUid)
      return state.messages
    })
  }
  async sendText(item, contact, incomingText = '') {
    let clicked = false
    try {
      await this.account(item.accountUid)
      contact = await this.mutual(contact)
      return await this.chat(contact, item.accountUid, async (page, before, args) => {
        if (item.kind === 'reply' && (before.messages.at(-1)?.id !== item.replyTo || before.messages.at(-1)?.role !== 'peer' || before.messages.at(-1)?.text !== incomingText)) throw new Error('对话已有更新或已被回复，旧草稿停止发送')
        await this.authorize(item)
        await this.account(item.accountUid)
        await this.evaluate(page, chatDOM, 'focus', args)
        await page.cdp.send('Input.insertText', { text: item.text }, 10000)
        const latest = await this.evaluate(page, chatDOM, 'read', args)
        if (JSON.stringify(latest.messages) !== JSON.stringify(before.messages)) throw new Error('输入期间对话更新，停止发送')
        await this.account(item.accountUid)
        await this.authorize(item)
        const finalState = await this.evaluate(page, chatDOM, 'read', args)
        if (JSON.stringify(finalState.messages) !== JSON.stringify(before.messages)) throw new Error('发送前对话更新，停止发送')
        const send = await this.evaluate(page, chatDOM, 'send', { ...args, text: item.text })
        clicked = true
        await this.click(page, send); await this.wait(2000); await this.guard(page)
        const after = await this.evaluate(page, chatDOM, 'read', args)
        const last = after.messages.at(-1)
        const confirmed = after.editorEmpty && last?.role === 'self' && last.text === item.text && !before.messages.some((m) => m.id === last.id)
        return { ok: confirmed, unknown: !confirmed, msg: confirmed ? '文字消息已发送并确认' : '发送结果未确认，请人工核实，不会自动重发' }
      })
    } catch (e) { if (e.name === 'DouyinAbort') throw e; return { ok: false, unknown: clicked, msg: e.message } }
  }
  async renderCard(day, text) {
    let page
    try {
      page = await this.session.tab('about:blank')
      await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1440, deviceScaleFactor: 1, mobile: false })
      const tree = await page.cdp.send('Page.getFrameTree')
      await page.cdp.send('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html: diaryHTML(day, text) })
      await this.evaluate(page, async () => {
        await document.fonts.ready
        const article = document.querySelector('article')
        for (let size = 38; article.getBoundingClientRect().bottom > 1280 && size >= 20; size--) article.style.fontSize = size + 'px'
        if (article.getBoundingClientRect().bottom > 1280) throw new Error('公开日常换行过多，无法完整排版，请缩短文案')
        return true
      })
      const shot = await page.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000)
      if (!shot?.data) throw new Error('日常图卡未生成')
      const folder = join(this.dir, 'diary-cards'); mkdirSync(folder, { recursive: true })
      const path = join(folder, day + '-' + createHash('sha256').update(text).digest('hex').slice(0, 16) + '.png')
      writeFileSync(path, Buffer.from(shot.data, 'base64')); return path
    } finally { if (page) { try { await this.session.close(page.target.id) } catch { /* Local render tab. */ } } }
  }
  async publishDiary(item) {
    let page, clicked = false, keep = false
    try {
      await this.authorize(item)
      const self = await this.account(item.accountUid)
      const card = await this.renderCard(item.diaryDay, item.text)
      page = await this.open('https://creator.douyin.com/creator-micro/content/upload')
      await this.evaluate(page, (secUid) => {
        const own = [...document.querySelectorAll('header a[href*="/user/"],[class*="header"] a[href*="/user/"],[data-e2e="creator-profile"] a[href*="/user/"]')]
        if (!secUid || !own.some((a) => new URL(a.href, location.href).pathname === '/user/' + secUid) || own.some((a) => new URL(a.href, location.href).pathname !== '/user/' + secUid)) throw new Error('无法确认创作者中心登录的是同一账号，停止发布')
        return true
      }, self.secUid)
      await this.click(page, await this.evaluate(page, buttonDOM, ['发布图文', '图文']))
      await this.wait(1500); await this.guard(page)
      await this.evaluate(page, () => {
        const inputs = [...document.querySelectorAll('input[type="file"]')].filter((e) => /image|\.png|\.jpg/.test(e.accept || ''))
        if (inputs.length !== 1) throw new Error('未找到唯一的图文上传入口，停止发布')
        if (inputs[0].files?.length) throw new Error('发布页已有图片，停止发布')
        inputs[0].setAttribute('data-dsh-diary-upload', 'true'); return true
      })
      const { root } = await page.cdp.send('DOM.getDocument')
      const { nodeId } = await page.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-dsh-diary-upload="true"]' })
      await this.account(item.accountUid)
      await this.authorize(item)
      await page.cdp.send('DOM.setFileInputFiles', { nodeId, files: [card] })
      await this.wait(4000); await this.guard(page)
      await this.evaluate(page, () => {
        const fields = [...document.querySelectorAll('[contenteditable="true"],textarea')].filter((e) => /作品简介|作品描述|添加描述|添加作品|描述/.test(e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || e.getAttribute('aria-label') || ''))
        if (fields.length !== 1) throw new Error('未找到唯一的图文描述框，停止发布')
        const e = fields[0]
        if ((e.value || e.innerText || '').trim()) throw new Error('发布框已有文字，保留原文并停止')
        e.focus(); return true
      })
      await page.cdp.send('Input.insertText', { text: item.text }, 10000)
      await this.account(item.accountUid)
      await this.authorize(item)
      await this.evaluate(page, (text, secUid, filename) => {
        const fields = [...document.querySelectorAll('[contenteditable="true"],textarea')].filter((e) => /作品简介|作品描述|添加描述|添加作品|描述/.test(e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || e.getAttribute('aria-label') || ''))
        if (fields.length !== 1 || (fields[0].value || fields[0].innerText || '').trim() !== text) throw new Error('公开描述与草稿不一致，停止发布')
        const profiles = [...document.querySelectorAll('header a[href*="/user/"],[class*="header"] a[href*="/user/"],[data-e2e="creator-profile"] a[href*="/user/"]')]
        if (!profiles.length || profiles.some((a) => new URL(a.href, location.href).pathname !== '/user/' + secUid)) throw new Error('创作者账号已变化，停止发布')
        if (/上传失败|正在上传|上传中/.test(document.body.innerText)) throw new Error('图片上传未完成，停止发布')
        const input = document.querySelector('[data-dsh-diary-upload="true"]')
        const previews = [...document.querySelectorAll('[data-e2e="image-preview"] img,[data-testid="image-preview"] img,[class*="image-preview"] img,[class*="imagePreview"] img,[class*="upload-list"] img,[class*="uploadList"] img')].filter((e) => {
          const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4
        })
        if (input?.files?.length !== 1 || input.files[0].name !== filename || previews.length !== 1 || !previews[0].complete || !previews[0].naturalWidth) throw new Error('无法确认唯一的日常图卡已上传，停止发布')
        return true
      }, item.text, self.secUid, card.split(/[\\/]/).at(-1))
      const button = await this.evaluate(page, buttonDOM, ['发布'])
      await this.guard(page); clicked = true
      await this.click(page, button); await this.wait(4000); await this.guard(page)
      const ok = await this.evaluate(page, () => /发布成功|作品发布成功/.test(document.body.innerText) && !/发布失败|上传失败/.test(document.body.innerText))
      return { ok, unknown: !ok, msg: ok ? '日常图文已发布并确认' : '发布结果未确认，请人工核实，不会自动重发' }
    } catch (e) { keep = e.name === 'DouyinAbort'; if (keep) throw e; return { ok: false, unknown: clicked, msg: e.message } }
    finally { await this.close(page, keep) }
  }
}
