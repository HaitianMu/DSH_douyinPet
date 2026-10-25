import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { atomicWrite } from './atomic.mjs'

export const HOME_LOCATION = 'home-location.json'
const INCOMPLETE = '.douyin-home-incomplete'
const biliPath = /(?:^|[\\/])(?:\.bili-ai|bili-duty|bilibili-duty|(?:dsh-)?bili-whale|(?:dsh-)?bili-scroll)(?:[\\/]|$)/i
const key = (path) => process.platform === 'win32' ? path.toLowerCase() : path
const contains = (parent, child) => key(parent) === key(child) || key(child).startsWith(key(parent) + sep)
const overlaps = (a, b) => contains(a, b) || contains(b, a)
async function digest(file) {
  const hash = createHash('sha256')
  for await (const block of createReadStream(file)) hash.update(block)
  return hash.digest('hex')
}

// Resolve junctions in existing ancestors, even when the destination does not exist yet.
function physicalPath(path) {
  const tail = []
  let ancestor = path
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('找不到目标目录所在的磁盘')
    tail.unshift(relative(parent, ancestor)); ancestor = parent
  }
  return resolve(realpathSync(ancestor), ...tail)
}

export function validateHomePath(value, { pluginDir } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error('请填写完整的绝对目录路径')
  const input = value.trim()
  if (!isAbsolute(input) || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(input))) throw new Error('家目录必须使用绝对路径，例如 D:\\DouyinPet')
  const path = resolve(input)
  const physical = physicalPath(path)
  if (path === parse(path).root || physical === parse(physical).root) throw new Error('请选择独立文件夹，不能直接使用磁盘根目录')
  if (biliPath.test(path) || biliPath.test(physical)) throw new Error('抖音家目录不能放在 B 站运行目录内')
  if (pluginDir && (overlaps(path, resolve(pluginDir)) || overlaps(physical, physicalPath(resolve(pluginDir))))) throw new Error('家目录必须独立于插件源码目录')
  return physical
}

export function loadHome(defaultHome, options = {}) {
  const base = validateHomePath(defaultHome, options)
  mkdirSync(base, { recursive: true })
  const locator = join(base, HOME_LOCATION)
  if (!existsSync(locator)) return base
  let location
  try { location = JSON.parse(readFileSync(locator, 'utf8')) } catch { throw new Error(`家目录位置记录损坏，请保留原文件并检查：${locator}`) }
  if (location?.version !== 1 || location?.platform !== 'douyin') throw new Error(`家目录位置记录格式错误：${locator}`)
  const home = validateHomePath(location.home, options)
  if (!existsSync(home) || !lstatSync(home).isDirectory() || existsSync(join(home, INCOMPLETE))) throw new Error(`已设置的家目录不可用，停止初始化以保留原身份：${home}`)
  return home
}

/** Copy first, commit the locator last. Never delete the source or overwrite another fish. */
export async function migrateHome({ defaultHome, from, to, pluginDir }) {
  const options = { pluginDir }
  const source = validateHomePath(from, options)
  const target = validateHomePath(to, options)
  const base = validateHomePath(defaultHome, options)
  if (key(source) === key(target)) return { home: source, previousHome: source, changed: false }
  if (overlaps(source, target) || overlaps(base, target)) throw new Error('新目录不能与当前或默认家目录互相包含')
  if (existsSync(target) && (!lstatSync(target).isDirectory() || readdirSync(target).length)) throw new Error('目标目录必须为空，不能覆盖或混入其他鱼的资料')
  if (existsSync(join(source, 'outbox.jsonl.lock'))) throw new Error('待发件箱正在写入或留有锁，请核查后再迁移')
  const locator = join(base, HOME_LOCATION)
  let lock
  try { lock = openSync(locator + '.lock', 'wx', 0o600) } catch { throw new Error('其他迁移正在进行或位置记录留有锁，请核查后再试') }
  try {
    writeFileSync(lock, String(process.pid))
    mkdirSync(target, { recursive: true })
    const marker = join(target, INCOMPLETE)
    writeFileSync(marker, '迁移尚未完成，不能作为运行目录。\n', { flag: 'wx', mode: 0o600 })
    const copyOptions = {
      recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
      filter: (file) => {
        const local = relative(source, file)
        if ([HOME_LOCATION, HOME_LOCATION + '.lock'].includes(local)) return false
        const info = lstatSync(file)
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`迁移不复制符号链接、目录联接或特殊文件：${local}`)
        return true
      },
    }
    for (const entry of readdirSync(source)) {
      if ([HOME_LOCATION, HOME_LOCATION + '.lock'].includes(entry)) continue
      await cp(join(source, entry), join(target, entry), copyOptions)
    }
    // The database and WAL travel together while the host and browser are idle.
    for (const file of ['self/memory.sqlite', 'self/memory.sqlite-wal', 'config.json', 'outbox.jsonl', 'acted.json']) {
      if (existsSync(join(source, file))) {
        const [before, after] = await Promise.all([digest(join(source, file)), digest(join(target, file))])
        if (before !== after) throw new Error(`迁移时资料发生变化，请停止其他进程后重试：${file}`)
      }
    }
    unlinkSync(marker)
    atomicWrite(locator, JSON.stringify({ version: 1, platform: 'douyin', home: target }, null, 2))
    return { home: target, previousHome: source, changed: true }
  } catch (e) {
    throw new Error(`迁移未切换，继续使用原目录。目标目录可能留有副本，请检查 ${target}：${e.message}`)
  } finally {
    try { closeSync(lock); unlinkSync(locator + '.lock') } catch { /* Cleanup must not turn a committed move into a reported failure. */ }
  }
}
