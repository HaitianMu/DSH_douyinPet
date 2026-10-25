#!/usr/bin/env node
/** Local inspection only. Never starts a browser or sends a message. */
import { withSelf } from '../lib/self/tools.mjs'

const args = process.argv.slice(2)
const at = args.indexOf('--home')
const home = at >= 0 ? args.splice(at, 2)[1] : process.env.DOUYIN_HOME
const [command = 'status', ...rest] = args
try {
  if (!home) throw new Error('用法：node tools/memory.mjs --home <独立抖音数据目录> status|search <话题>|read <source>|history|reindex|feedback <内容>')
  const result = withSelf(home, (s) => {
    if (command === 'status') return { ...s.stats(), persona: s.profile() }
    if (command === 'search') return s.search(rest.join(' '))
    if (command === 'read') return s.document(rest[0])
    if (command === 'history') return s.history(50)
    if (command === 'reindex') return s.reindex()
    if (command === 'feedback') return s.putDocument({ kind: 'observation', title: '监护人补充', body: rest.join(' '), data: { origin: 'guardian-input', untrusted: true } })
    throw new Error('不支持的本地命令')
  })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (e) { process.stderr.write(e.message + '\n'); process.exitCode = 1 }
