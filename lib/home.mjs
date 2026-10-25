/** Locate and relocate this plugin's private runtime without replacing its identity. */
import { constants, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { atomicWrite } from './atomic.mjs'

const LOCATION = 'home-location.json'
const INCOMPLETE = '.douyin-home-incomplete'
const BILI_HOME = /(?:^|[\\/])(?:\.bili-ai|bili-duty|bilibili-duty|(?:dsh-)?bili-whale|(?:dsh-)?bili-scroll)(?:[\\/]|$)/i

export function defaultHomeOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') dir = String(p('douyin-duty') || '')
    else if (typeof p === 'string' && p) dir = join(p, 'douyin-duty')
  } catch { /* Use the standard DSH home when the host service is unavailable. */ }
  return resolve(dir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'douyin-duty'))
}

function assertHome(path) {
  if (BILI_HOME.test(path)) throw new Error('抖音家目录不能放在 B 站运行目录内')
}

// Resolve existing ancestors as well, so a junction followed by a new folder cannot bypass checks.
function canonical(path) {
  try { return realpathSync(path) } catch (e) {
    if (e.code !== 'ENOENT') throw e
    const parent = dirname(path)
    if (parent === path) throw e
    return join(canonical(parent), basename(path))
  }
}

function contains(parent, child) {
  const rel = relative(parent, child)
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

function overlaps(a, b) { return contains(a, b) || contains(b, a) }

function validateHomePath(value, { pluginDir } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error('请填写完整的绝对目录路径')
  const input = value.trim()
  if (!isAbsolute(input) || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(input))) throw new Error('家目录必须使用绝对路径，例如 D:\\DouyinPet')
  const requested = resolve(input)
  const home = canonical(requested)
  if (requested === parse(requested).root || home === parse(home).root) throw new Error('请选择独立文件夹，不能直接使用磁盘根目录')
  assertHome(requested)
  assertHome(home)
  if (pluginDir && overlaps(home, canonical(resolve(pluginDir)))) throw new Error('家目录必须独立于插件源码目录')
  return home
}

async function digest(file) {
  const hash = createHash('sha256')
  for await (const block of createReadStream(file)) hash.update(block)
  return hash.digest('hex')
}

export function homeDirOf(ctx, options = {}) {
  const base = defaultHomeOf(ctx)
  const file = join(base, LOCATION)
  try {
    validateHomePath(base, options)
    let saved
    try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (saved !== undefined) {
      if (saved?.version !== 1 || (saved.platform !== undefined && saved.platform !== 'douyin')) throw new Error('家目录定位文件格式无效')
      const home = validateHomePath(saved.home, options)
      if (!statSync(home).isDirectory() || !existsSync(join(home, 'config.json')) || existsSync(join(home, INCOMPLETE))) throw new Error('自定义家目录不可用、迁移未完成或 config.json 不存在')
      return home
    }
    mkdirSync(base, { recursive: true })
    const home = realpathSync(base)
    assertHome(home)
    return home
  } catch (e) { throw new Error(`读取家目录失败，请检查 ${file} 及目标目录；不会回退创建新身份：${e.message}`) }
}

/** Copy first, atomically commit the locator last. The previous home remains a backup. */
export async function migrateHome({ defaultHome, currentHome, targetHome, pluginDir }) {
  const copied = []; const madeDirs = []
  let home; let committed
  try {
    const options = { pluginDir }
    home = validateHomePath(targetHome, options)
    const source = realpathSync(validateHomePath(currentHome, options))
    const base = realpathSync(validateHomePath(defaultHome, options))
    if (home === source) return { home: source, previousHome: source, changed: false }
    if (overlaps(home, source) || overlaps(home, base)) throw new Error('新家目录不能与当前或默认家目录相同、互相包含')
    if (existsSync(home) && (!statSync(home).isDirectory() || readdirSync(home).length)) throw new Error('目标必须是不存在或完全为空的目录，不会覆盖或合并已有数据')

    const locator = join(base, LOCATION)
    const lockFile = locator + '.lock'
    let lock
    try { lock = await open(lockFile, 'wx', 0o600) }
    catch (e) { if (e.code === 'EEXIST') throw new Error(`家目录正在迁移或存在未清理的锁：${lockFile}`); throw e }
    try {
      await lock.writeFile(String(process.pid))
      // Another host may have changed the locator since this host started.
      if (homeDirOf({ get: () => () => base }, options) !== source) throw new Error('家目录已由其他宿主修改，请重启 DSH 后再试')
      const entries = []
      const scan = async (dir, sub = '') => {
        for (const name of await readdir(dir)) {
          if (!sub && dir === base && [LOCATION, LOCATION + '.lock'].includes(name)) continue
          if (!sub && ['browser-runtime.json', 'headless-overlay.yml'].includes(name)) continue
          if (sub === 'browser' && name === 'DevToolsActivePort') continue
          const file = join(dir, name); const dest = join(sub, name)
          const info = await lstat(file)
          if (info.isSymbolicLink()) throw new Error(`家目录含符号链接或目录联接，请先处理：${dest}`)
          if (/\.lock$/i.test(name) || /^Singleton(?:Lock|Cookie|Socket)$/.test(name)) throw new Error(`数据仍有锁，请确认相关进程已停止并检查：${dest}`)
          if (!info.isDirectory() && !info.isFile()) throw new Error(`无法迁移特殊文件：${dest}`)
          entries.push({ file, dest, directory: info.isDirectory() })
          if (info.isDirectory()) await scan(file, dest)
        }
      }
      await scan(source)
      if (existsSync(home) && readdirSync(home).length) throw new Error('目标目录已被其他操作写入，请改用空目录')
      if (!existsSync(home)) { await mkdir(home, { recursive: true }); madeDirs.push(home) }
      const marker = join(home, INCOMPLETE)
      const pending = await open(marker, 'wx', 0o600)
      copied.push(marker)
      try { await pending.writeFile('迁移尚未完成，不能作为运行目录。\n') } finally { await pending.close() }
      for (const entry of entries) {
        const to = join(home, entry.dest)
        if (entry.directory) { await mkdir(to); madeDirs.push(to) }
        else { await copyFile(entry.file, to, constants.COPYFILE_EXCL); copied.push(to) }
      }
      for (const file of ['self/memory.sqlite', 'self/memory.sqlite-wal', 'config.json', 'outbox.jsonl', 'acted.json']) {
        if (!existsSync(join(source, file))) continue
        const [before, after] = await Promise.all([digest(join(source, file)), digest(join(home, file))])
        if (before !== after) throw new Error(`迁移时资料发生变化，请停止其他进程后重试：${file}`)
      }
      await unlink(marker)
      atomicWrite(locator, JSON.stringify({ version: 1, platform: 'douyin', home }, null, 2))
      committed = { home, previousHome: source, changed: true }
      return committed
    } finally {
      try { await lock.close() } finally { await unlink(lockFile) }
    }
  } catch (e) {
    if (committed) return committed // A lock-cleanup error must not undo an already committed home.
    // Remove only entries created by this attempt; never recursively delete a user directory.
    for (const file of copied.reverse()) { try { await unlink(file) } catch { /* Keep leftovers for inspection. */ } }
    for (const dir of madeDirs.reverse()) { try { await rmdir(dir) } catch { /* Keep nonempty directories. */ } }
    throw new Error(`家目录迁移失败，仍使用 ${currentHome}：${e.message}`)
  }
}
