/** Outbox: atomic updates, strict recovery and at-most-once attempts. */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite, fileLock } from './atomic.mjs'
import { localDate } from './self/store.mjs'

export const OUTBOX_KINDS = ['comment', 'dm', 'group']
const fileOf = (home) => join(home, 'outbox.jsonl')
export function readOutbox(home) {
  const file = fileOf(home)
  if (!existsSync(file)) return []
  const list = readFileSync(file, 'utf8').split(/\r?\n/).filter((s) => s.trim()).map((line) => {
    const item = JSON.parse(line)
    if (!item || typeof item.id !== 'string' || !OUTBOX_KINDS.includes(item.kind)) throw new Error('待发件箱格式损坏，请检查原文件；不会跳过记录重新发送')
    return item
  })
  if (new Set(list.map((o) => o.id)).size !== list.length) throw new Error('待发件箱存在重复ID')
  return list
}
function mutate(home, fn) {
  return fileLock(fileOf(home), () => {
    const list = readOutbox(home)
    const result = fn(list)
    atomicWrite(fileOf(home), list.map((o) => JSON.stringify(o)).join('\n') + '\n')
    return result
  })
}
export function addDraft(home, { kind, target = '', videoId = '', text = '', why = '', by = 'model', ticket = '', memorySource = '' }) {
  try {
    if (!OUTBOX_KINDS.includes(kind)) throw new Error('未知草稿类型')
    if (typeof text !== 'string' || !text.trim() || text.length > 300) throw new Error('正文需要1–300字')
    const item = { id: 'ob_' + randomUUID(), at: new Date().toISOString(), kind, target: String(target).trim().slice(0, 80), videoId: String(videoId), text: text.trim(), why: String(why).slice(0, 200), by, ticket, memorySource, status: 'pending', note: '' }
    return mutate(home, (list) => { list.push(item); return { ok: true, item } })
  } catch (e) { return { ok: false, error: e.message } }
}
export function setStatus(home, id, status, note = '') {
  try {
    return mutate(home, (list) => {
      const item = list.find((o) => o.id === id)
      if (!item) throw new Error('没有这条草稿')
      const transitions = { pending: ['approved', 'rejected', 'failed'], approved: ['rejected', 'failed'], sending: ['sent', 'unknown', 'failed'], failed: ['rejected'] }
      if (status !== item.status && !transitions[item.status]?.includes(status)) throw new Error('不能重新发送已处理的草稿')
      item.status = status; item.note = String(note).slice(0, 200); item.touchedAt = new Date().toISOString()
      if (status === 'sent') item.sentAt = item.touchedAt
      return { ok: true, item }
    })
  } catch (e) { return { ok: false, error: e.message } }
}
function countedToday(item, day, kind) {
  const time = item.sentAt || item.attemptedAt || item.at
  return (!kind || item.kind === kind) && ['sent', 'sending', 'unknown', 'failed'].includes(item.status) &&
    (item.status !== 'failed' || item.attemptedAt) && Number.isFinite(Date.parse(time)) && localDate(new Date(time)) === day
}
/** Reserve BEFORE browser I/O. Unknown/interrupted attempts consume quota and cannot be retried. */
export function reserveDelivery(home, id, day, quota) {
  return mutate(home, (list) => {
    const item = list.find((o) => o.id === id)
    if (!item || !['pending', 'approved'].includes(item.status)) throw new Error('草稿已处理或正在发送')
    const count = list.filter((o) => countedToday(o, day, item.kind)).length
    if (count >= Math.max(0, Number(quota) || 0)) throw new Error('今日配额已用完')
    item.status = 'sending'; item.attemptedAt = new Date().toISOString(); item.note = '已预占发送；若进程中断请人工核实，禁止自动重试'
    return { ...item }
  })
}
export function listOutbox(home, { status = '', day = '', limit = 50 } = {}) {
  return readOutbox(home).filter((o) => (!status || o.status === status) && (!day || localDate(new Date(o.at)) === day)).slice(-Math.max(1, Math.min(Number(limit) || 50, 200))).reverse()
}
export function sentToday(home, day, kind) { return readOutbox(home).filter((o) => o.status === 'sent' && countedToday(o, day, kind)).length }
export function hitWhitelist(whitelist, target) {
  const value = String(target || '').trim()
  return !!value && value !== '*' && Array.isArray(whitelist) && whitelist.some((w) => typeof w === 'string' && w.trim() === value)
}
export function quotaLeft(home, day, kind, quota) {
  return Math.max(0, Math.max(0, Math.min(Number(quota) || 0, 50)) - readOutbox(home).filter((o) => countedToday(o, day, kind)).length)
}
