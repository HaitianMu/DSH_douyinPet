import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { DEFAULT_CFG } from '../lib/state.mjs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// A small React host exercises the actual self-registering settings bundle.
// Effects never run, so rendering cannot contact a browser or a real account.
function panel({ tab = 'social', cfg = DEFAULT_CFG, outbox = null, busy = '' } = {}) {
  const calls = []; const nodes = []; let entry, render, hook = 0
  const seeds = new Map([[0, cfg], [1, { home: 'C:\synthetic-home', loginUnknown: true }], [3, busy], [4, tab], [9, outbox]])
  const values = []
  const React = {
    Component: class { constructor(props) { this.props = props } },
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }
    },
    useState(initial) {
      const index = hook++
      values[index] = seeds.has(index) ? seeds.get(index) : typeof initial === 'function' ? initial() : initial
      return [values[index], (next) => { values[index] = typeof next === 'function' ? next(values[index]) : next }]
    },
    useEffect() {}, useCallback: (fn) => fn, useRef: (current) => ({ current }),
  }
  const document = { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } }
  const slots = { inject: (name, fn) => { assert.equal(name, 'settings.section'); fn() }, register: (spec, fn) => { assert.equal(spec.label, '刷抖音'); render = fn } }
  const fetch = async (path, options) => {
    calls.push({ path, options })
    const data = path.endsWith('/token') ? { token: 'synthetic-token' }
      : path.endsWith('/config') ? { ok: true, cfg }
        : path.endsWith('/outbox') ? { items: [] }
          : path.endsWith('/status') ? {} : { started: true }
    return { ok: true, json: async () => data }
  }
  runInNewContext(source, { window: { __ModuleLoader__: { load: (spec) => { entry = spec.factory((name) => { assert.equal(name, 'react'); return React }) } } }, document, fetch })
  entry.apply({ slots, effect() {} })
  const visit = (node) => {
    if (node == null || typeof node === 'boolean') return ''
    if (Array.isArray(node)) return node.map(visit).join('')
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    assert.ok(node.type, 'Rendered children must be valid elements or text')
    if (typeof node.type === 'function') return visit(node.type.prototype?.render ? new node.type(node.props).render() : node.type(node.props))
    const text = visit(node.props.children)
    nodes.push({ ...node, text }); return text
  }
  const text = visit(render())
  return { text, calls, nodes, values }
}

test('settings pages render without network work, including single draft children', () => {
  for (const tab of ['daily', 'taste', 'social', 'memory', 'adv']) {
    const p = panel({ tab })
    assert.match(p.text, /登录状态待空闲时检查/)
    assert.equal(p.calls.length, 0)
  }
  for (const [kind, label] of [['message', '主动互动'], ['reply', '来信回复'], ['diary', '日常图文']]) {
    const p = panel({ outbox: { items: [{ id: 'synthetic', kind, text: '合成公开文字', status: 'pending' }] } })
    assert.ok(p.text.includes(label)); assert.ok(p.text.includes('合成公开文字'))
    assert.equal(p.nodes.filter((n) => n.type === 'button' && n.text === '批准并发出').length, 1)
    assert.equal(p.calls.length, 0)
  }
})

test('social controls expose explicit opt-ins and block immediate tasks while disabled', () => {
  const p = panel()
  for (const label of ['互关互动与来信', '保存互动名单', '看完视频后主动互动', '检查新来信并起草回复', '每天写日常', '允许发布日常到抖音', '自动发']) assert.ok(p.text.includes(label), label)
  for (const label of ['立即检查消息', '现在写日常']) assert.equal(p.nodes.find((n) => n.type === 'button' && n.text === label).props.disabled, true)
  assert.equal(p.nodes.find((n) => n.type === 'select' && n.props.value === 'review').props.value, 'review')
})

test('enabled manual social tasks and send-mode changes use protected host routes', async () => {
  const cfg = { ...DEFAULT_CFG, autoReplyEnabled: true, diaryEnabled: true }
  for (const [label, endpoint] of [['立即检查消息', '/social/run'], ['现在写日常', '/diary/run']]) {
    const p = panel({ cfg }); const button = p.nodes.find((n) => n.type === 'button' && n.text === label)
    assert.equal(button.props.disabled, false); await button.props.onClick()
    const request = p.calls.find((c) => c.path.endsWith(endpoint))
    assert.equal(request.options.method, 'POST')
    assert.equal(request.options.headers['x-douyin-token'], 'synthetic-token')
  }
  const p = panel({ cfg })
  await p.nodes.find((n) => n.type === 'select' && n.props.value === 'review').props.onChange({ target: { value: 'auto' } })
  const request = p.calls.find((c) => c.path.endsWith('/config') && c.options?.method === 'POST')
  assert.equal(JSON.parse(request.options.body).outboxMode, 'auto')
  assert.equal(request.options.headers['x-douyin-token'], 'synthetic-token')
})
