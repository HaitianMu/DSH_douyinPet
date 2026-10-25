import { runInNewContext } from 'node:vm'
import { basename } from 'node:path'
import { SocialBrowser } from '../../lib/social-browser.mjs'

export const peer = { name: '合成好友', secUid: 'synthetic-peer', uid: '200', url: 'https://www.douyin.com/user/synthetic-peer' }
const rect = () => ({ x: 20, y: 40, width: 100, height: 40 })
const node = (attrs = {}) => ({ getBoundingClientRect: rect, contains: () => false,
  getAttribute(k) { return attrs[k] ?? null }, setAttribute(k, v) { attrs[k] = v }, ...attrs })

/** Executes actual DOM expressions and CDP flows, with no sockets or live account. */
export function socialBrowser({ dir = '', creator = false, confirm = true, authorize } = {}) {
  const state = { uid: '100', secUid: 'synthetic-self', messages: [{ id: 'old', role: 'peer', text: '合成来信' }],
    clicks: 0, reads: 0, accounts: 0, closed: 0, deferred: 0, pageText: '合成页面',
    onInsert: () => {}, onAccount: () => {}, onRead: () => {}, previews: 1, overflow: false, foreignSender: false }
  const editor = node({ value: '', focus() {}, placeholder: '添加作品描述' })
  const send = node({ textContent: '发送' })
  const header = node({ href: peer.url, textContent: peer.name })
  const own = node({ href: 'https://www.douyin.com/user/synthetic-self' })
  const file = node({ accept: 'image/png,image/jpeg', files: [] })
  const preview = node({ complete: true, naturalWidth: 1080 })
  const article = node({ style: {}, getBoundingClientRect: () => ({ bottom: state.overflow ? 2000 : 1100 }) })
  const root = node({ querySelectorAll(selector) {
    if (selector.startsWith('header ')) return [header]
    if (selector === '[contenteditable="true"],textarea') return [editor]
    if (selector === 'button,[role="button"]') return [send]
    if (selector === '[data-message-id]') {
      state.reads++; state.onRead(state)
      return state.messages.map((m) => node({ 'data-message-id': m.id, 'data-sender-id': state.foreignSender ? '300' : m.role === 'self' ? state.uid : peer.uid,
        querySelector: () => ({ innerText: m.text }) }))
    }
    return []
  }, querySelector: () => ({}) })
  const document = { title: '合成页面', body: { get innerText() { return state.pageText } }, fonts: { ready: Promise.resolve() },
    querySelector(selector) { return selector === 'article' ? article : file },
    querySelectorAll(selector) {
      if (selector.startsWith('[data-e2e="im-chat-panel"]')) return [root]
      if (selector.startsWith('header ')) return [own]
      if (selector === 'input[type="file"]') return [file]
      if (selector === '[contenteditable="true"],textarea') return [editor]
      if (selector.startsWith('[data-e2e="image-preview"]')) return Array(state.previews).fill(preview)
      if (selector.startsWith('button,a,')) return [node({ textContent: creator ? state.uploaded ? '发布' : '发布图文' : '私信' })]
      return []
    } }
  const location = { href: creator ? 'https://creator.douyin.com/creator-micro/content/upload' : peer.url }
  const page = { target: { id: 'synthetic-social' }, cdp: {
    async send(method, args = {}) {
      if (method === 'Runtime.evaluate') {
        try { return { result: { value: await runInNewContext(args.expression, { document, location, URL }) } } }
        catch (e) { return { exceptionDetails: { text: e.message } } }
      }
      if (method === 'Input.insertText') { editor.value = args.text; state.onInsert(state, editor) }
      if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
        if (!creator && !state.chatOpened) { state.chatOpened = true; return {} }
        if (creator ? state.uploaded : !!editor.value) {
          state.clicks++
          if (confirm) {
            if (creator) state.pageText = '发布成功'
            else { state.messages.push({ id: 'new-self', role: 'self', text: editor.value }); editor.value = '' }
          }
        }
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.setFileInputFiles') { file.files = args.files.map((path) => ({ name: basename(path) })); state.uploaded = true }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'local-card' } } }
      if (method === 'Page.setDocumentContent') state.html = args.html
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('synthetic-png').toString('base64') }
      return {}
    }, close() {} } }
  const dy = { dir, config: () => ({}), session: { tab: async () => page, close: async () => { state.closed++ } }, log() {},
    whoami: async () => { state.accounts++; state.onAccount(state); return { loggedIn: true, uid: state.uid, secUid: state.secUid } },
    api: async () => ({ user: { uid: peer.uid, sec_uid: peer.secUid, nickname: peer.name, follow_status: 2 } }),
    pacer: { take: async (gap) => { state.gap = gap }, defer: (gap) => { state.deferred = gap } } }
  const browser = new SocialBrowser(dy, { wait: async () => {}, authorize })
  return { browser, state, editor, header, root, document, location, peer, own, file, dy }
}
