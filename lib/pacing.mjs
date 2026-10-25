import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, fileLock } from './atomic.mjs'

export const BATCH_LIMIT = 3
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const seconds = (value, fallback, min, max) => {
  const n = Number(value)
  return Math.max(min, Math.min(Number.isFinite(n) ? Math.round(n) : fallback, max))
}
export const browseSettings = (cfg = {}) => ({
  videoWatchSeconds: seconds(cfg.videoWatchSeconds ?? 30, 30, 30, 120),
  requestIntervalSeconds: seconds(cfg.requestIntervalSeconds ?? 10, 10, 10, 60),
})
export const batchSize = (n) => Math.max(1, Math.min(Math.floor(Number(n)) || BATCH_LIMIT, BATCH_LIMIT))

/** Persist actual start times so host and MCP requests share the same cooldown.
 * The file lock covers only the small synchronous update, never the wait.
 * Recheck after waiting: a delayed caller must not consume an outdated time slot.
 */
export class BrowsePacer {
  constructor({ dir = '', now = Date.now, wait = sleep } = {}) {
    this.file = dir ? join(dir, 'browse-pacing.json') : ''
    this.now = now
    this.wait = wait
    this.nextAt = 0
  }

  update(fn) {
    const run = () => {
      let state = { nextAt: this.nextAt }
      if (this.file) {
        try { state = JSON.parse(readFileSync(this.file, 'utf8')) }
        catch (e) { if (e.code !== 'ENOENT') throw new Error('浏览间隔记录无法读取，请检查：' + this.file) }
      }
      if (!Number.isFinite(state?.nextAt) || state.nextAt < 0) throw new Error('浏览间隔记录损坏')
      const result = fn(state)
      if (this.file) atomicWrite(this.file, JSON.stringify(state))
      this.nextAt = state.nextAt
      return result
    }
    // Failure stops the operation; never silently bypass pacing on a write error.
    return this.file ? fileLock(this.file, run) : run()
  }

  async take(gapMs) {
    for (;;) {
      const remaining = this.update((state) => {
        const now = this.now()
        if (state.nextAt > now) return state.nextAt - now
        state.nextAt = now + gapMs
        return 0
      })
      if (!remaining) return
      await this.wait(Math.min(remaining, 2000))
    }
  }

  defer(gapMs) {
    this.update((state) => { state.nextAt = Math.max(state.nextAt, this.now() + gapMs) })
  }
}
