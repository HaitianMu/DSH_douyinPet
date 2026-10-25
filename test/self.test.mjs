import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { SelfStore, LIMITS, localDate, previousDate } from '../lib/self/store.mjs'
import { selfTools, wakePrompt } from '../lib/self/tools.mjs'
import { addDraft, reserveDelivery, setStatus, quotaLeft, hitWhitelist, readOutbox } from '../lib/outbox.mjs'
import { deliveryPolicy } from '../lib/delivery-policy.mjs'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'douyin-self-test-'))
  const store = new SelfStore(home)
  t.after(() => {
    store.close()
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep))
    rmSync(home, { recursive: true, force: true })
  })
  return { home, store }
}
const observation = (s, body = '今天看了关于木工榫卯和手工家具的视频，画面展示了榫头与卯眼的连接。') => s.observation({ videoId: '12345678901234567890', body })

test('independent persistent identities never inherit sibling files', (t) => {
  const { home, store } = fixture(t)
  const otherHome = join(home, 'other-douyin'); const other = new SelfStore(otherHome)
  const evidence = observation(store)
  store.evolve({ patch: { name: '木工鱼' }, reason: '最近对手工好奇', sources: [evidence.source], expectedRevision: 1 })
  assert.notEqual(store.stats().instance, other.stats().instance)
  assert.equal(other.profile().name, '抖音大肥鱼')
  assert.equal(other.stats().documents, 0)
  other.close()
  const reopened = new SelfStore(home)
  assert.equal(reopened.profile().name, '木工鱼'); reopened.close()
  const bili = join(home, '.bili-ai'); mkdirSync(bili)
  writeFileSync(join(bili, 'sentinel'), '不读取、不修改')
  assert.throws(() => new SelfStore(bili), /B 站/)
  assert.equal(existsSync(join(bili, 'self')), false)
  const alias = join(home, 'directory-alias')
  symlinkSync(bili, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => new SelfStore(alias), /B 站/)
  assert.equal(existsSync(join(bili, 'self')), false)
  assert.equal(readFileSync(join(bili, 'sentinel'), 'utf8'), '不读取、不修改')
})

test('foreign and unidentified SQLite archives are preserved without initialization', (t) => {
  const { home } = fixture(t)
  for (const platform of ['', 'bilibili']) {
    const foreignHome = join(home, platform || 'unknown')
    mkdirSync(join(foreignHome, 'self'), { recursive: true })
    const path = join(foreignHome, 'self', 'memory.sqlite')
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('synthetic preserved data');")
    if (platform) {
      db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);')
      db.prepare('INSERT INTO meta VALUES (?,?)').run('platform', platform)
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    db.close()
    assert.throws(() => new SelfStore(foreignHome), /格式未知|平台不匹配/)
    const preserved = new DatabaseSync(path)
    try {
      assert.deepEqual(preserved.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), tables)
      assert.equal(preserved.prepare('SELECT value FROM sentinel').get().value, 'synthetic preserved data')
    } finally { preserved.close() }
  }
})

test('RAG finds an old relevant diary instead of just recent entries', (t) => {
  const { store } = fixture(t)
  store.diary({ day: '2025-01-02', experiences: '今天第一次理解了木工榫卯结构，榫头和卯眼靠形状连接，不使用钉子。', publicText: '今天认识了榫卯。' })
  for (let i = 1; i <= 12; i++) store.diary({ day: `2026-10-${String(i).padStart(2, '0')}`, experiences: '今天看见城市街景和咖啡，记下这次散步。' })
  const results = store.search('榫卯 木工结构')
  assert.ok(results.length); assert.equal(results[0].day, '2025-01-02')
  assert.match(results[0].source, /^diary:2025-01-02@1$/)
  assert.equal(store.search('" OR * ; DROP TABLE documents --').length, 0)
})

test('diaries preserve revisions, private text and separate short public drafts', (t) => {
  const { store } = fixture(t); const e = observation(store)
  const first = store.diary({ day: '2026-10-01', experiences: '私下给自己留一段详细记录。', growth: '我愿意继续了解手工。', sources: [e.source], publicText: '今天多了一点好奇。' })
  assert.throws(() => store.diary({ day: '2026-10-01', experiences: '不能覆盖' }), /变化/)
  const second = store.diary({ day: '2026-10-01', experiences: '修订自己的理解。', expectedRevision: 1 })
  assert.notEqual(first.source, second.source)
  assert.match(store.document(first.source).body, /私下/)
  assert.equal(store.document(first.source).data.publicText, '今天多了一点好奇。')
  assert.throws(() => store.diary({ experiences: '没有证据', growth: '却声称成长' }), /来源/)
  assert.throws(() => store.diary({ day: '2026-02-30', experiences: '不存在的日期' }), /日期/)
  assert.throws(() => store.diary({ day: '2099-01-01', experiences: '未来的经历' }), /未来/)
})

test('working table expires transitively after an original source is corrected', (t) => {
  const { store } = fixture(t); const e = observation(store)
  const insight = store.putDocument({ kind: 'insight', title: '手工兴趣', body: '我对榫卯感兴趣。', sources: [e.source] })
  store.replaceWorking([{ key: '兴趣', text: '继续了解榫卯', sources: [insight.source] }])
  assert.equal(store.workingTable()[0].stale, false)
  store.putDocument({ id: e.id, expectedRevision: 1, kind: 'observation', title: '更正', body: '纠正原来的识别内容。' })
  assert.equal(store.workingTable()[0].stale, true)
  const ctx = store.context({ topic: '榫卯' })
  assert.deepEqual(ctx.table, []); assert.deepEqual(ctx.staleKeys, ['兴趣'])
  assert.ok(!ctx.retrieved.some((r) => r.source === insight.source))
})

test('working table enforces size and never treats summaries as evidence', (t) => {
  const { store } = fixture(t)
  assert.throws(() => store.replaceWorking([{ key: '猜测', text: '没有来源', sources: [] }]), /来源/)
  assert.throws(() => store.replaceWorking(Array.from({ length: 9 }, (_, i) => ({ key: String(i), text: '很短', sources: ['persona@1'] }))), /最多/)
  assert.throws(() => store.replaceWorking([{ key: '太长', text: '鱼'.repeat(181), sources: ['persona@1'] }]), /180/)
  assert.throws(() => store.putDocument({ kind: 'insight', title: '错误', body: '用摘要证明自己', sources: ['working:兴趣@1'] }), /来源/)
  store.replaceWorking([{ key: '自己', text: '表达简短', sources: ['persona@1'], ttlDays: 1 }])
  store.db.prepare('UPDATE working SET expires=?').run('2000-01-01T00:00:00Z')
  assert.equal(store.workingTable()[0].stale, true)
})

test('evolution has evidence, optimistic concurrency and protected permission fields', (t) => {
  const { store } = fixture(t); const e = observation(store)
  for (const key of ['guardianName', 'familyMembers', 'dailyCommentQuota', 'outboxMode', 'personaPrompt', 'account', '__proto__']) {
    const patch = JSON.parse(`{"${key}":"随意"}`)
    assert.throws(() => store.evolve({ patch, reason: '试改权限', sources: [e.source], expectedRevision: 1 }), /不能自主/)
  }
  store.evolve({ patch: { interests: ['手工'] }, reason: '有具体内容触发好奇', sources: [e.source], expectedRevision: 1 })
  assert.throws(() => store.evolve({ patch: { voice: '不同表达' }, reason: '旧上下文', sources: [e.source], expectedRevision: 1 }), /冲突/)
  assert.equal(store.history().length, 2)
  assert.deepEqual(store.history()[0].sources, [e.source])
})

test('context stays bounded even with a large archive and source-rich table', (t) => {
  const { home, store } = fixture(t)
  const refs = []
  for (let i = 0; i < 15; i++) refs.push(observation(store, '榫卯。'.repeat(500)).source)
  store.replaceWorking(Array.from({ length: 6 }, (_, i) => ({ key: `关注${i}`, text: '木工榫卯'.repeat(20), sources: refs.slice(i, i + 2) })))
  const ctx = store.context({ topic: '榫卯', purpose: 'draft', guidance: '独立的人格指导。'.repeat(150) })
  assert.ok(JSON.stringify(ctx).length <= LIMITS.contextChars)
  assert.ok(wakePrompt(home).length < 550)
  assert.doesNotMatch(wakePrompt(home), /榫卯。榫卯/)
})

test('action tickets reject missing, wrong purpose, stale evidence and revised persona', (t) => {
  const { store } = fixture(t); const e = observation(store)
  const ctx = store.context({ purpose: 'draft' })
  assert.throws(() => store.checkTicket('', 'draft'), /先调用/)
  assert.throws(() => store.checkTicket(ctx.ticket, 'pick'), /先调用/)
  store.replaceWorking([{ key: '自己', text: '现在简短一些', sources: ['persona@1'] }])
  assert.throws(() => store.checkTicket(ctx.ticket, 'draft'), /先调用/)
  assert.equal(store.checkTicket(ctx.ticket, 'draft', { forDelivery: true }), true)
  store.evolve({ patch: { voice: '更平静' }, reason: '有来源的调整', sources: [e.source], expectedRevision: 1 })
  assert.throws(() => store.checkTicket(ctx.ticket, 'draft', { forDelivery: true }), /失效/)
})

test('corrected personality evidence requires a new, explained personality revision', (t) => {
  const { store } = fixture(t); const event = observation(store)
  store.evolve({ patch: { interests: ['手工'] }, reason: '合成经历中的好奇', sources: [event.source], expectedRevision: 1 })
  const corrected = store.putDocument({ id: event.id, kind: 'observation', title: '更正测试资料', body: '原来的画面识别不准确。', expectedRevision: 1 })
  const stale = store.context({ purpose: 'draft' })
  assert.equal(stale.personaEvidenceStale, true)
  assert.throws(() => store.checkTicket(stale.ticket, 'draft'), /修订/)
  store.evolve({ patch: { interests: [] }, reason: '撤回来源不可靠的兴趣判断', sources: [corrected.source], expectedRevision: 2 })
  const current = store.context({ purpose: 'draft' })
  assert.equal(current.personaEvidenceStale, false)
  assert.equal(store.checkTicket(current.ticket, 'draft'), true)
})

test('concurrent database connections see revisions and cannot overwrite one another', (t) => {
  const { home, store } = fixture(t); const other = new SelfStore(home)
  const e = observation(store)
  store.evolve({ patch: { name: '甲' }, reason: '第一次', sources: [e.source], expectedRevision: 1 })
  assert.equal(other.profile().revision, 2)
  assert.throws(() => other.evolve({ patch: { name: '乙' }, reason: '覆盖', sources: [e.source], expectedRevision: 1 }), /冲突/)
  other.close()
})

test('reindex is reversible derived state; corrupt archive never resets silently', (t) => {
  const { home, store } = fixture(t); observation(store)
  const before = store.search('榫卯')
  store.reindex()
  assert.equal(store.search('榫卯')[0].source, before[0].source)
  const brokenHome = join(home, 'broken'); mkdirSync(join(brokenHome, 'self'), { recursive: true })
  const path = join(brokenHome, 'self', 'memory.sqlite')
  writeFileSync(path, 'not a database')
  assert.throws(() => new SelfStore(brokenHome))
  assert.equal(readFileSync(path, 'utf8'), 'not a database')
})

test('local date and yesterday use Shanghai instead of host timezone', () => {
  const instant = new Date('2026-10-24T18:30:00Z')
  assert.equal(localDate(instant), '2026-10-25')
  assert.equal(previousDate(instant), '2026-10-24')
})

test('outbox zero quotas, exact recipients and unknown attempts cannot be bypassed', (t) => {
  const { home } = fixture(t)
  assert.equal(hitWhitelist([], '张三'), false)
  assert.equal(hitWhitelist(['*'], '张三'), false)
  assert.equal(hitWhitelist(['张'], '张三'), false)
  assert.equal(hitWhitelist(['张三'], '张三'), true)
  const draft = addDraft(home, { kind: 'comment', text: '简短记录', videoId: '123', ticket: 'ticket', memorySource: 'event:one@1' }).item
  assert.throws(() => reserveDelivery(home, draft.id, localDate(), 0), /配额/)
  reserveDelivery(home, draft.id, localDate(), 1)
  assert.equal(quotaLeft(home, localDate(), 'comment', 1), 0)
  assert.throws(() => reserveDelivery(home, draft.id, localDate(), 5), /已处理/)
  assert.equal(setStatus(home, draft.id, 'unknown', '页面没有确认').ok, true)
  assert.equal(setStatus(home, draft.id, 'approved').ok, false)
  assert.throws(() => deliveryPolicy({ dailyCommentQuota: 1 }, readOutbox(home)[0]), /重试/)
  const dm = { ...draft, kind: 'dm', target: '张三' }
  assert.throws(() => deliveryPolicy({ dmEnabled: true, dmWhitelist: [] }, dm), /白名单/)
  assert.equal(deliveryPolicy({ dailyCommentQuota: 0 }, draft), 0)
})

test('damaged outbox fails closed rather than forgetting previous sends', (t) => {
  const { home } = fixture(t)
  writeFileSync(join(home, 'outbox.jsonl'), '{bad-json}\n')
  assert.throws(() => readOutbox(home))
  assert.throws(() => reserveDelivery(home, 'missing', localDate(), 5))
  assert.equal(readFileSync(join(home, 'outbox.jsonl'), 'utf8'), '{bad-json}\n')
})

test('memory tools expose actual object schemas with optional diary fields', (t) => {
  const { home } = fixture(t)
  const list = selfTools(home, () => ({ familyMembers: ['姑姑 | 小明 | 手工'] }))
  const diary = list.find((x) => x.name === 'douyin_diary_write')
  assert.deepEqual(diary.schema.required, ['experiences', 'ticket'])
  assert.equal(list.find((x) => x.name === 'douyin_self_evolve').schema.properties.patch.type, 'object')
  assert.equal(list.find((x) => x.name === 'douyin_family').fn().relatives[0].name, '姑姑')
})
