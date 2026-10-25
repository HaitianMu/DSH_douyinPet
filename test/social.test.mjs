import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { runInNewContext } from 'node:vm'
import { DEFAULT_CFG, dayKey } from '../lib/state.mjs'
import { contactsOf, socialPolicy, validateSocialSource } from '../lib/social-policy.mjs'
import { recordInbox, pendingInbox, socialTools, socialKey } from '../lib/social-tools.mjs'
import { withSelf, wakePrompt } from '../lib/self/tools.mjs'
import { addDraft, reserveDelivery, checkReservedDelivery, setStatus, readOutbox, quotaLeft } from '../lib/outbox.mjs'
import { SocialBrowser, chatDOM, diaryHTML } from '../lib/social-browser.mjs'
import { socialBrowser, peer } from './fixtures/social.mjs'

const config = () => ({ ...DEFAULT_CFG, socialContacts: [peer.name + ' | ' + peer.url], proactiveEnabled: true, autoReplyEnabled: true, diaryEnabled: true, diaryPublishEnabled: true })
const item = (extra = {}) => ({ kind: 'reply', target: peer.name, peerSecUid: peer.secUid, accountUid: '100', replyTo: 'old', text: '合成回复', ticket: 'synthetic', memorySource: 'synthetic@1', ...extra })
const msg = (id, text = '合成新消息', role = 'peer') => ({ id, text, role })
function homeOf(t) {
  const home = mkdtempSync(join(tmpdir(), 'douyin-social-test-'))
  t.after(() => { assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true }) })
  return home
}

test('new actions default off and require exact contacts, switches, account, source and quotas', () => {
  for (const key of ['proactiveEnabled', 'autoReplyEnabled', 'diaryEnabled', 'diaryPublishEnabled']) assert.equal(DEFAULT_CFG[key], false)
  assert.throws(() => socialPolicy(DEFAULT_CFG, item()), /未开启/)
  assert.equal(socialPolicy(config(), item()), 5)
  assert.equal(socialPolicy({ ...config(), replyDailyQuota: 0 }, item()), 0)
  for (const bad of ['* | ' + peer.url, '甲 | https://evil.test/user/id', '甲 | http://www.douyin.com/user/id', '甲 | https://www.douyin.com@evil.test/user/id']) assert.throws(() => contactsOf({ socialContacts: [bad] }))
  assert.throws(() => contactsOf({ socialContacts: [peer.name + ' | ' + peer.url, peer.name + ' | ' + peer.url] }), /唯一/)
  for (const patch of [{ target: '改名' }, { peerSecUid: 'other' }, { replyTo: '' }, { accountUid: '' }, { ticket: '' }]) assert.throws(() => socialPolicy(config(), item(patch)))
  assert.throws(() => socialPolicy(config(), item({ kind: 'message', videoId: 'invalid' })), /视频/)
})

test('inbox establishes a baseline, persists pending across restarts, isolates accounts and skips gaps/history', (t) => {
  const home = homeOf(t)
  assert.equal(recordInbox(home, '100', peer, [msg('1')]).pending, '')
  const source = recordInbox(home, '100', peer, [msg('1'), msg('2')]).pending
  assert.ok(source.startsWith('inbox:'))
  assert.equal(pendingInbox(home, '100', config())[0].source, source)
  assert.equal(recordInbox(home, '100', peer, [msg('1'), msg('2')]).pending, source)
  withSelf(home, (s) => { const doc = validateSocialSource(s, item({ memorySource: source, replyTo: '2' })); assert.equal(doc.data.untrusted, true)
    assert.throws(() => validateSocialSource(s, item({ memorySource: source, accountUid: '999', replyTo: '2' })), /来源/)
    assert.throws(() => validateSocialSource(s, item({ memorySource: source, replyTo: '3' })), /来源/) })
  assert.deepEqual(pendingInbox(home, '999', config()), [])
  assert.equal(recordInbox(home, '999', peer, [msg('2')]).pending, '')
  assert.equal(recordInbox(home, '100', peer, [msg('99')]).pending, '')
  assert.equal(recordInbox(home, '100', peer, [msg('99'), msg('100', '人工已回', 'self')]).pending, '')
  assert.equal(recordInbox(home, '101', peer, []).pending, '')
  assert.ok(recordInbox(home, '101', peer, [msg('new')]).pending)
  assert.deepEqual(pendingInbox(home, '101', { ...config(), socialContacts: [] }), [])
})

test('archive before checkpoint crash is idempotent and a drafted/unknown reply is never queued again', (t) => {
  const home = homeOf(t); const file = join(home, 'social-inbox.json')
  recordInbox(home, '100', peer, [msg('1')]); const checkpoint = readFileSync(file)
  const source = recordInbox(home, '100', peer, [msg('1'), msg('2')]).pending
  writeFileSync(file, checkpoint)
  assert.equal(recordInbox(home, '100', peer, [msg('1'), msg('2')]).pending, source)
  withSelf(home, (s) => assert.equal(s.stats().versions, 1))
  const dedupeKey = socialKey('reply', '100', peer.secUid, '2')
  const draft = addDraft(home, item({ memorySource: source, replyTo: '2', dedupeKey })).item
  reserveDelivery(home, draft.id, dayKey(), 5); setStatus(home, draft.id, 'unknown')
  assert.deepEqual(pendingInbox(home, '100', config()), [])
  assert.equal(addDraft(home, item({ dedupeKey })).item.id, draft.id)
  assert.throws(() => reserveDelivery(home, draft.id, dayKey(), 5), /处理/)
  assert.equal(quotaLeft(home, dayKey(), 'reply', 5), 4)
  assert.throws(() => recordInbox(home, '100', peer, [msg('x'), msg('x')]), /格式/)
  writeFileSync(file, '{bad'); assert.throws(() => recordInbox(home, '100', peer, []))
})

test('older proactive drafts cannot double-send to the same peer on the delivery day', (t) => {
  const home = homeOf(t)
  const first = addDraft(home, item({ kind: 'message', dedupeKey: 'previous-day' })).item
  const next = addDraft(home, item({ kind: 'message', dedupeKey: 'today' })).item
  reserveDelivery(home, first.id, dayKey(), 5); setStatus(home, first.id, 'unknown')
  assert.throws(() => reserveDelivery(home, next.id, dayKey(), 5), /此对象/)
})

test('reserved sends respect lowered quotas and only unattempted diaries can refresh', (t) => {
  const home = homeOf(t)
  const first = addDraft(home, item()).item
  reserveDelivery(home, first.id, dayKey(), 5); setStatus(home, first.id, 'sent')
  const second = addDraft(home, item()).item
  reserveDelivery(home, second.id, dayKey(), 5)
  assert.equal(checkReservedDelivery(home, second.id, dayKey(), 2).id, second.id)
  assert.throws(() => checkReservedDelivery(home, second.id, dayKey(), 1), /调低/)
  assert.throws(() => checkReservedDelivery(home, second.id, '2000-01-01', 5), /失效/)
  const diary = item({ kind: 'diary', diaryDay: dayKey(), target: '', dedupeKey: 'one-diary', text: '旧公开文案' })
  const original = addDraft(home, diary).item
  const refreshed = addDraft(home, { ...diary, text: '新公开文案', memorySource: 'diary:today@2' })
  assert.equal(refreshed.refreshed, true); assert.equal(refreshed.item.id, original.id)
  assert.equal(refreshed.item.text, '新公开文案'); assert.equal(refreshed.item.status, 'pending')
  reserveDelivery(home, original.id, dayKey(), 1); setStatus(home, original.id, 'unknown')
  assert.equal(addDraft(home, diary).item.status, 'unknown')
  assert.equal(addDraft(home, diary).item.text, '新公开文案')
  const rejected = addDraft(home, { ...diary, dedupeKey: 'rejected-diary' }).item
  setStatus(home, rejected.id, 'rejected')
  assert.equal(addDraft(home, { ...diary, dedupeKey: 'rejected-diary' }).item.status, 'rejected')
})

test('social tools rotate contacts, require current inbox/frames evidence and only enqueue public diary text', async (t) => {
  const home = homeOf(t); let cfg = config(); let accountUid = '100'; const visited = []
  t.mock.method(SocialBrowser.prototype, 'account', async () => ({ uid: accountUid }))
  t.mock.method(SocialBrowser.prototype, 'mutual', async (c) => { visited.push(c.secUid); return { ...c, uid: '200' } })
  let messages = [msg('1')]
  t.mock.method(SocialBrowser.prototype, 'readChat', async () => messages)
  cfg.socialContacts = Array.from({ length: 4 }, (_, i) => '好友' + i + ' | https://www.douyin.com/user/peer' + i)
  const inspected = new Map()
  const tools = new Map(socialTools(home, () => cfg, async () => ({}), inspected).map((v) => [v.name, v.fn]))
  const call = (name, args = {}) => tools.get(name)(args)
  await call('douyin_contacts'); assert.deepEqual(visited.splice(0), ['peer0', 'peer1', 'peer2'])
  await call('douyin_contacts'); assert.deepEqual(visited.splice(0), ['peer3', 'peer0', 'peer1'])
  const ticket = () => withSelf(home, (s) => s.context({ purpose: 'draft' }).ticket)
  await assert.rejects(call('douyin_social_draft', { kind: 'message', peerSecUid: 'peer0', videoId: '123', text: '合成', ticket: ticket() }), /本轮/)
  const observation = withSelf(home, (s) => s.observation({ videoId: '123', body: '合成画面', title: '合成' }))
  inspected.set('123', observation.source)
  const outgoing = await call('douyin_social_draft', { kind: 'message', peerSecUid: 'peer0', videoId: '123', text: '合成互动', ticket: ticket() })
  assert.equal(outgoing.ok, true); assert.equal(readOutbox(home)[0].status, 'pending')
  await call('douyin_inbox'); messages = [msg('1'), msg('2')]
  const inbox = await call('douyin_inbox'); assert.equal(inbox.items.length, 2)
  const pending = inbox.items[0]
  const reply = { kind: 'reply', peerSecUid: pending.peer.secUid, source: pending.source, text: '合成回复', ticket: ticket() }
  assert.equal((await call('douyin_social_draft', reply)).ok, true)
  await assert.rejects(call('douyin_social_draft', { ...reply, ticket: ticket() }), /已处理/)
  accountUid = '999'; await call('douyin_contacts')
  await assert.rejects(call('douyin_social_draft', { ...reply, peerSecUid: 'peer3', ticket: ticket() }), /先核验/)
  const diary = withSelf(home, (s) => s.diary({ day: dayKey(), experiences: '私人密码和合成来信不发布', publicText: '今天学习了榫卯。' }))
  const publication = await call('douyin_diary_publish', { day: dayKey(), source: diary.source, ticket: ticket() })
  assert.equal(publication.ok, true)
  const queued = readOutbox(home).find((o) => o.kind === 'diary')
  assert.equal(queued.text, '今天学习了榫卯。'); assert.equal(queued.accountUid, '999')
  withSelf(home, (s) => {
    validateSocialSource(s, queued)
    s.diary({ day: dayKey(), experiences: '修订', publicText: '新的公开文案', expectedRevision: 1 })
    assert.throws(() => validateSocialSource(s, queued), /修订|版本/)
  })
})

test('disabled social tools never initialize a browser', async (t) => {
  const home = homeOf(t)
  const tools = socialTools(home, () => DEFAULT_CFG, async () => { throw new Error('Browser forbidden') }, new Map())
  for (const tool of tools.filter((v) => ['douyin_contacts', 'douyin_inbox'].includes(v.name))) assert.equal((await tool.fn({})).ok, false)
  await assert.rejects(tools.find((v) => v.name === 'douyin_diary_publish').fn({}), /未开启/)
})

test('real chat DOM rejects ambiguous identities, existing text and foreign senders', () => {
  const f = socialBrowser(); const args = { ...peer, accountUid: '100' }
  const read = (action) => runInNewContext(`(${chatDOM.toString()})(${JSON.stringify(action)},${JSON.stringify(args)})`, { document: f.document, location: f.location, URL })
  assert.equal(read('read').messages[0].text, '合成来信')
  f.editor.value = '人工草稿'; assert.throws(() => read('focus'), /未发送/)
  f.editor.value = ''; f.state.foreignSender = true; assert.throws(() => read('read'), /不属于/)
  f.state.foreignSender = false
  const original = f.document.querySelectorAll
  f.document.querySelectorAll = (q) => q.startsWith('[data-e2e="im-chat-panel"]') ? [f.root, { ...f.root }] : original(q)
  assert.throws(() => read('read'), /唯一/)
})

test('contact URLs discard tracking parameters without changing the recipient', () => {
  const contacts = contactsOf({ socialContacts: [peer.name + '|' + peer.url + '?from_tab_name=main#profile'] })
  assert.equal(contacts[0].url, peer.url)
  assert.equal(contacts[0].secUid, peer.secUid)
  assert.equal(contacts[0].name, peer.name)
})

test('chat identity accepts duplicate avatar/name links and ignores hidden headers', () => {
  const f = socialBrowser(); const args = { ...peer, accountUid: '100' }
  const query = f.root.querySelectorAll
  let headers = [
    { ...f.header, textContent: '', href: peer.url + '?from_tab_name=main' },
    { ...f.header, href: peer.url + '/' },
    { ...f.header, href: 'https://www.douyin.com/user/hidden-peer', getBoundingClientRect: () => ({ width: 0, height: 0 }) },
  ]
  f.root.querySelectorAll = (q) => q.startsWith('header ') ? headers : query(q)
  const read = (action) => runInNewContext(`(${chatDOM.toString()})(${JSON.stringify(action)},${JSON.stringify(args)})`, { document: f.document, location: f.location, URL })
  assert.equal(read('probe').ready, true)
  assert.equal(read('read').messages[0].text, '合成来信')
  for (const href of ['https://www.douyin.com/user/other-peer', 'https://evil.test/user/' + peer.secUid]) {
    headers = [f.header, { ...f.header, href }]
    assert.equal(read('probe').ready, false)
    assert.throws(() => read('read'), /主页链接不唯一或与名单不一致/)
  }
  headers = [{ ...f.header, textContent: '另一个昵称' }]
  assert.throws(() => read('focus'), /昵称与名单不一致/)
})

test('nested header wrappers cannot replace a full conversation', () => {
  const f = socialBrowser()
  const headerOnly = { ...f.root, querySelectorAll: (q) => q.startsWith('header ') ? [f.header] : [], querySelector: () => null }
  f.root.contains = (e) => e === headerOnly
  const query = f.document.querySelectorAll
  f.document.querySelectorAll = (q) => q.startsWith('[data-e2e="im-chat-panel"]') ? [f.root, headerOnly] : query(q)
  const read = (action) => runInNewContext(`(${chatDOM.toString()})(${JSON.stringify(action)},${JSON.stringify({ ...peer, accountUid: '100' })})`, { document: f.document, location: f.location, URL })
  assert.equal(read('probe').ready, true)
  assert.equal(read('read').messages[0].text, '合成来信')
})

test('chat waits for delayed mounting and reports unsupported pages before typing', async () => {
  const f = socialBrowser(); const query = f.document.querySelectorAll; let probes = 0
  f.document.querySelectorAll = (q) => {
    if (q.startsWith('[data-e2e="im-chat-panel"]') && ++probes < 4) return []
    return query(q)
  }
  assert.equal((await f.browser.sendText(item(), peer, '合成来信')).ok, true)
  assert.equal(f.state.clicks, 1)
  const unsupported = socialBrowser(); const original = unsupported.document.querySelectorAll; let polls = 0, guards = 0
  unsupported.document.querySelectorAll = (q) => {
    if (q.startsWith('[data-e2e="im-chat-panel"]')) { polls++; return [] }
    return original(q)
  }
  const guard = unsupported.browser.guard.bind(unsupported.browser)
  unsupported.browser.guard = async (page) => { guards++; return guard(page) }
  let log = ''
  unsupported.dy.log = (message) => { log = message }
  const result = await unsupported.browser.sendText(item(), peer, '合成来信')
  assert.equal(result.ok, false); assert.equal(result.unknown, false)
  assert.match(result.msg, /未识别到可见的私信面板/)
  assert.match(result.msg, /未输入或发送文字/)
  assert.match(log, /candidates=0/)
  assert.equal(polls, 6); assert.ok(guards >= polls)
  assert.equal(unsupported.editor.value, ''); assert.equal(unsupported.state.clicks, 0)
})

test('text delivery confirms a new self message, pauses at least 60 seconds and marks uncertain clicks unknown', async () => {
  const f = socialBrowser()
  assert.equal((await f.browser.sendText(item(), peer, '合成来信')).ok, true)
  assert.equal(f.state.clicks, 1); assert.equal(f.state.gap, 60000); assert.equal(f.state.deferred, 60000)
  const unknown = socialBrowser({ confirm: false })
  const r = await unknown.browser.sendText(item(), peer, '合成来信')
  assert.equal(r.ok, false); assert.equal(r.unknown, true); assert.equal(unknown.state.clicks, 1)
})

test('message changes, manual replies, account switches and revoked permission stop before Send', async () => {
  const cases = [
    (f) => { f.state.messages.push(msg('manual', '人工回复', 'self')) },
    (f) => { f.state.onInsert = (s) => s.messages.push(msg('arrived')) },
    (f) => { f.state.onAccount = (s) => { if (s.accounts === 3) s.uid = '999' } },
    (f) => { f.browser.authorize = async () => { throw new Error('已关闭') } },
    (f) => { f.editor.value = '未发人工草稿' },
  ]
  for (const setup of cases) {
    const f = socialBrowser(); setup(f)
    const r = await f.browser.sendText(item(), peer, '合成来信')
    assert.equal(r.ok, false); assert.equal(r.unknown, false); assert.equal(f.state.clicks, 0)
  }
})

test('verification stops the flow and preserves its page even if saving cooldown fails', async () => {
  const f = socialBrowser(); f.state.pageText = '请完成安全验证'
  f.dy.pacer.defer = () => { throw new Error('synthetic disk error') }
  await assert.rejects(f.browser.sendText(item(), peer, '合成来信'), { name: 'DouyinAbort' })
  assert.equal(f.state.clicks, 0); assert.equal(f.state.closed, 0)
})

test('diary rendering escapes markup, contains only public text and rejects overflowing cards', async (t) => {
  const home = homeOf(t); const text = '<script>alert(1)</script> & 今天'
  assert.ok(diaryHTML(dayKey(), text).includes('&lt;script&gt;'))
  assert.ok(!diaryHTML(dayKey(), text).includes('<script>'))
  const f = socialBrowser({ dir: home })
  const path = await f.browser.renderCard(dayKey(), text)
  assert.equal(readFileSync(path, 'utf8'), 'synthetic-png')
  assert.match(f.state.html, /AI 日常/)
  f.state.overflow = true
  await assert.rejects(f.browser.renderCard(dayKey(), '换行过多'), /无法完整排版/)
})

test('diary publication verifies matching account, exact text, one uploaded image and positive confirmation', async (t) => {
  const home = homeOf(t)
  const draft = item({ kind: 'diary', diaryDay: dayKey(), text: '公开的合成日常' })
  const f = socialBrowser({ dir: home, creator: true })
  assert.equal((await f.browser.publishDiary(draft)).ok, true); assert.equal(f.state.clicks, 1)
  const unconfirmed = socialBrowser({ dir: home, creator: true, confirm: false })
  assert.equal((await unconfirmed.browser.publishDiary(draft)).unknown, true)
  for (const setup of [
    (g) => { g.state.onInsert = (_s, e) => { e.value = '被改动的文案' } },
    (g) => { g.own.href = 'https://www.douyin.com/user/other' },
    (g) => { g.state.previews = 0 },
    (g) => { g.state.previews = 2 },
    (g) => { g.state.pageText = '图片上传中' },
    (g) => { g.file.files = [{ name: '人工已有图卡.png' }] },
    (g) => { g.browser.authorize = async () => { throw new Error('发布已关闭') } },
  ]) {
    const g = socialBrowser({ dir: home, creator: true }); setup(g)
    assert.equal((await g.browser.publishDiary(draft)).ok, false); assert.equal(g.state.clicks, 0)
  }
})

test('wake prompts distinguish browsing, new-message checks and today diary publication', (t) => {
  const home = homeOf(t)
  assert.match(wakePrompt(home, 'social'), /本轮仅检查消息/)
  assert.match(wakePrompt(home, 'diary'), /day=今天/)
  assert.match(wakePrompt(home, 'diary'), /不得声称已发布/)
  assert.match(wakePrompt(home), /本轮实际frames/)
})
