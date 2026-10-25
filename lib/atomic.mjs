import { openSync, closeSync, unlinkSync, writeFileSync, renameSync, fsyncSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/** Cross-process guard. A crashed writer leaves a lock for explicit inspection, never silent takeover. */
export function fileLock(file, fn) {
  const lock = `${file}.lock`
  const until = Date.now() + 2000
  let fd
  while (fd === undefined) {
    try { fd = openSync(lock, 'wx', 0o600) } catch (e) {
      if (e.code !== 'EEXIST' || Date.now() >= until) throw new Error(`数据正在写入或存在未清理的锁：${lock}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try { writeFileSync(fd, String(process.pid)); return fn() } finally { closeSync(fd); unlinkSync(lock) }
}
export function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(tmp, 'wx', 0o600); writeFileSync(fd, content, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(tmp, file)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(tmp) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
}
