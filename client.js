/**
 * dsh-douyin-scroll —— 浏览器半端（**在「设置」里占一页**）
 * ============================================================================
 * ⭐ client bundle **不是 ESM，是自注册脚本**（dsh 的约定）：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply(ctx) }) })
 * ⭐ 怎么进「设置」（抄 dsh-meme / dsh-bili-scroll）：
 *     slots.inject('settings.section', () => slots.register({ id, order, label }, () => h(Panel)))
 *   ⇒ **别自己糊一个全屏 overlay**，跟别的插件长得不一样主人一眼就看出来了。
 *
 * ⭐ 2026-10-24：按主人要求「据 dsh-bili-scroll 的界面，改 dsh-douyin-scroll」——
 *    版面照 bili 那一页来：
 *      · 顶上一排状态徽章（今天挑了几条 / 登录 / 浏览器模式 / 谷时 / 版本）+ 「现在跑一轮」
 *      · **日常 / 偏好 / 互动 / 高级** 四个标签页，一页一摊，别把所有开关堆成一条长龙
 *      · 改文字类的（关键词 / 人设 / 博主链接）先攒着，点「保存改动」一起写
 *      · 开关和数字是点了立刻存（跟以前一样），不用再点保存
 *      · 会动账号的（自动收藏 / 评论 / 私聊 / 群）、要花钱的（视觉模型）**默认关**
 *   监护人文字指导与本项目的独立成长人格分别保存，不读取外部人设文件。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useRef = React.useRef

    const API = '/api/douyin-duty'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      const detail = await res.json().catch(() => ({}))
      throw new Error(detail.error || ('HTTP ' + res.status + why))
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    // ⭐ 加固后：改状态的 POST 必须带 x-douyin-token（同源 GET /token 换，缓存住）
    let API_TOKEN = ''
    const ensureToken = async () => {
      if (API_TOKEN) return API_TOKEN
      try { API_TOKEN = String((await jget('/token')).token || '') } catch { API_TOKEN = '' }
      return API_TOKEN
    }
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-douyin-token': await ensureToken() },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-dd-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 8px;max-width:660px;}
[data-dd-sec]{display:flex;flex-direction:column;gap:8px;}
[data-dd-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dd-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-dd-grow]{flex:1;min-width:0;}
[data-dd-label]{font-size:13px;}
[data-dd-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dd-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-dd-sw][data-on]{background:#3b82f6;}
[data-dd-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;display:block;}
[data-dd-sw][data-on] i{left:19px;}
[data-dd-sw][disabled]{opacity:.45;cursor:default;}
[data-dd-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-dd-sep]{height:1px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));margin:2px 0;}
[data-dd-tabs]{display:flex;gap:6px;flex-wrap:wrap;padding:0 0 2px;}
[data-dd-tab]{padding:6px 12px;border-radius:999px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dd-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));}
[data-dd-tab][aria-selected="true"]{background:#3b82f6;border-color:#3b82f6;color:#fff;font-weight:600;}
[data-dd-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dd-input]:focus{outline:none;border-color:#3b82f6;}
[data-dd-num]{width:88px;text-align:center;}
[data-dd-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-dd-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dd-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dd-btn][disabled]{opacity:.5;cursor:default;}
[data-dd-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));}
[data-dd-msg][data-err]{color:#e5484d;}
[data-dd-msg][data-ok]{color:#30a46c;}
[data-dd-badge]{display:inline-block;font-size:10px;padding:2px 6px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.16));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dd-pre]{white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:17px;max-height:340px;overflow:auto;
  padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.1));margin:0;}
[data-dd-portrait]{width:100%;box-sizing:border-box;padding:8px 9px;border-radius:8px;font-size:12px;line-height:18px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;resize:vertical;}
[data-dd-portrait]:focus{outline:none;border-color:#3b82f6;}
`

    // ── 小零件 ────────────────────────────────────────────────
    const Badge = ({ children }) => h('span', { 'data-dd-badge': '' }, children)

    const Btn = ({ primary, disabled, onClick, children }) => h('button', {
      'data-dd-btn': '', 'data-primary': primary ? '' : undefined, disabled,
      onClick: disabled ? undefined : onClick,
    }, children)

    const Sw = ({ on, disabled, onChange }) => h('button', {
      'data-dd-sw': '', 'data-on': on ? '' : undefined, disabled,
      onClick: () => !disabled && onChange(!on),
    }, h('i'))

    const Row = ({ label, note, children }) => h('div', { 'data-dd-row': '' },
      h('div', { 'data-dd-grow': '' },
        h('div', { 'data-dd-label': '' }, label),
        note ? h('div', { 'data-dd-note': '' }, note) : null),
      children)

    const Num = ({ value, onChange, min = 0, max = 99, w }) => h('input', {
      'data-dd-input': '', 'data-dd-num': '', type: 'number', value,
      style: w ? { width: String(w) + 'px' } : undefined,
      min, max,
      onChange: (e) => {
        const v = Number(e.target.value)
        if (Number.isNaN(v)) return
        onChange(Math.max(min, Math.min(max, v)))
      },
    })

    const Txt = ({ value, placeholder, onChange, mono, width }) => h('input', {
      'data-dd-input': '', type: 'text', value: value ?? '', placeholder,
      style: Object.assign(
        mono ? { fontFamily: 'ui-monospace,Menlo,Consolas,monospace' } : {},
        width ? { width: String(width) + 'px' } : {},
      ),
      onChange: (e) => onChange(e.target.value),
    })

    const Area = ({ value, placeholder, rows = 4, onChange, mono }) => h('textarea', {
      'data-dd-portrait': '', value: value ?? '', placeholder, rows,
      style: mono ? { fontFamily: 'ui-monospace,Menlo,Consolas,monospace' } : undefined,
      onChange: (e) => onChange(e.target.value),
    })

    // ⭐ 2026-10-24：`h(X, props, 唯一一个孩子)` 时 React 给的是**这个孩子本身**（不是数组），
    //   直接 `...children` 就会 TypeError: Spread syntax requires ...iterable —— 互动页白屏就是它。
    const KIDS = (c) => (c == null ? [] : Array.isArray(c) ? c : [c])
    const ARR = (v) => (Array.isArray(v) ? v
      : v == null ? []
        : typeof v === 'string' ? v.split(/[\/,，、;；\s]+/).filter(Boolean) : [v])

    const Sec = ({ title, children }) => h('div', { 'data-dd-sec': '' },
      h('div', { 'data-dd-h': '' }, title), ...KIDS(children))

    const Sub = ({ children }) => h('div', { 'data-dd-sub': '' }, ...KIDS(children))

    // 兜底：任何一处渲染错误都把「白屏」换成一句能看懂的红字 + 该怎么报给我
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      render() {
        if (this.state.err) {
          return h('div', { 'data-dd-page': '' },
            h('div', { 'data-dd-msg': '', 'data-err': '' }, `⚠️ 设置页渲染出错了：${this.state.err?.message || this.state.err}`),
            h('div', { 'data-dd-note': '' }, '其它功能不受影响。把这一行发给鱼鱼就能定位；点别的标签页还能用。'))
        }
        return this.props.children
      }
    }

    const TABS = [['daily', '日常'], ['taste', '偏好'], ['social', '互动'], ['memory', '记忆与成长'], ['adv', '高级']]

    function Panel() {
      const [cfg, setCfg] = useState(null)
      const [st, setSt] = useState({})
      const [msg, setMsg] = useState({ text: '', kind: '' })
      const [busy, setBusy] = useState('')
      const [tab, setTab] = useState('daily')
      const [report, setReport] = useState(null)
      const [logTail, setLogTail] = useState(null)
      const [test, setTest] = useState(null)
      const [vtest, setVtest] = useState(null)
      const [outbox, setOutbox] = useState(null)
      const [self, setSelf] = useState(null)
      const [query, setQuery] = useState('')
      const [found, setFound] = useState([])
      const [entry, setEntry] = useState(null)
      const [feedback, setFeedback] = useState('')
      const [familyDraft, setFamilyDraft] = useState('')
      const [contactsDraft, setContactsDraft] = useState('')
      const contactsDirty = useRef(false)
      const [polling, setPolling] = useState(false)
      const [homeDraft, setHomeDraft] = useState('')
      const homeDirty = useRef(false)
      // ⭐ 文字类先攒着，点「保存改动」一起写（照 bili 的习惯）
      const [draft, setDraft] = useState({ kws: '', persona: '', urls: '' })
      const [dirty, setDirty] = useState(false)
      const dirtyRef = useRef(false)
      const alive = useRef(true)

      const say = (text, kind) => setMsg({ text, kind: kind || '' })

      useEffect(() => () => { alive.current = false }, [])

      const fillDraft = useCallback((c) => {
        if (!c || dirtyRef.current) return
        setDraft({
          kws: ARR(c.keywords).join('、'),
          persona: c.personaPrompt || '',
          urls: ARR(c.userUrls).join('\n'),
        })
      }, [])

      const load = useCallback(async () => {
        try {
          const c = await jget('/config')
          setCfg(c.cfg)
          fillDraft(c.cfg)
          if (!contactsDirty.current) setContactsDraft((c.cfg.socialContacts || []).join('\n'))
          if (!homeDirty.current) setHomeDraft(c.home || '')
          const s = await jget('/status')
          setSt(s)
          try { setOutbox(await jget('/outbox')) } catch { /* 待发件箱读不到就先不显示 */ }
        } catch (e) { say('读配置失败：' + e.message, 'err') }
      }, [fillDraft])

      useEffect(() => { load() }, [load])

      const patch = useCallback(async (p, label) => {
        setCfg((c) => ({ ...(c || {}), ...p }))
        try {
          const r = await jpost('/config', p)
          if (r.cfg) { setCfg(r.cfg); fillDraft(r.cfg) }
          if (r.ok === false || r.rejected?.length) throw new Error(r.error || ('以下设置未保存：' + r.rejected.join('、') + '，请检查格式或范围'))
          if (label) say(label + '：已保存', 'ok')
          return r
        } catch (e) { say('保存失败：' + e.message, 'err'); load(); return null }
      }, [load, fillDraft])

      const patchSrc = useCallback(async (k, v) => {
        const next = { ...(cfg?.sources || {}), [k]: v }
        await patch({ sources: next })
      }, [cfg, patch])

      const edit = (k, v) => {
        setDraft((d) => ({ ...d, [k]: v }))
        setDirty(true)
        dirtyRef.current = true
      }

      const onSave = async () => {
        setBusy('save')
        try {
          const kws = String(draft.kws || '').split(/[\/,，、;；\s\n]+/).map((s) => s.trim()).filter(Boolean)
          const urls = String(draft.urls || '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
          if (!await patch({ keywords: kws, personaPrompt: String(draft.persona || ''), userUrls: urls })) return
          setDirty(false)
          dirtyRef.current = false
          say('已保存：关键词 ' + kws.length + ' 个、人设 ' + (String(draft.persona || '').trim() ? '有' : '留空') + '、博主 ' + urls.length + ' 个', 'ok')
        } catch (e) { say('保存失败：' + e.message, 'err') } finally { setBusy('') }
      }

      const onMoveHome = async () => {
        setBusy('home')
        try {
          const r = await jpost('/home', { home: homeDraft.trim() })
          homeDirty.current = false
          setHomeDraft(r.home)
          setSt((s) => ({ ...s, home: r.home }))
          setReport(null); setLogTail(null); setTest(null)
          setSelf(null); setFound([]); setEntry(null)
          await load()
          say(r.changed ? `已使用新家目录：${r.home}。旧目录保留为备份：${r.previousHome}` : '当前已经使用这个家目录', 'ok')
        } catch (e) { say(e.message, 'err') } finally { setBusy('') }
      }

      // ── 登录：开窗口 → 轮询 ──
      const onLogin = async () => {
        setBusy('login')
        try {
          const r = await jpost('/login/start', {})
          if (!r.ok) throw new Error(r.error || '登录窗口未能打开')
          say(r.hint || '浏览器窗口已打开', '')
          setPolling(true)
        } catch (e) { say('开登录窗口失败：' + e.message, 'err') } finally { setBusy('') }
      }

      const onCancelLogin = async () => {
        setBusy('login-cancel')
        try {
          await jpost('/login/cancel', {})
          setPolling(false)
          say('已结束登录等待，需要时可重新点击「登录抖音」', '')
        } catch (e) { say(e.message, 'err') } finally { setBusy('') }
      }

      useEffect(() => {
        if (!polling) return
        let cancelled = false
        let timer
        const deadline = Date.now() + 5 * 60_000
        const poll = async () => {
          if (cancelled || !alive.current) return
          if (Date.now() > deadline) {
            setPolling(false)
            say('登录等待已超时，请重新点击「登录抖音」', 'err')
            return
          }
          try {
            const r = await jget('/login/poll')
            if (cancelled || !alive.current) return
            if (r.state === 'ok') {
              setPolling(false)
              say('登录成功：' + (r.who || ''), 'ok')
              load()
              return
            }
            if (['idle', 'closed', 'expired'].includes(r.state)) {
              setPolling(false)
              say(r.error || '登录等待已结束，请重新点击「登录抖音」', 'err')
              return
            }
            if (r.error) say('登录检查：' + r.error, 'err')
          } catch (e) { if (!cancelled && alive.current) say('登录检查失败：' + e.message, 'err') }
          if (!cancelled && alive.current) timer = setTimeout(poll, 2000)
        }
        timer = setTimeout(poll, 2000)
        return () => { cancelled = true; clearTimeout(timer) }
      }, [polling, load])

      // ── 动作 ──
      const onRun = async () => {
        setBusy('run')
        try {
          const r = await jpost('/run', {})
          say(r.started ? '已开跑 —— 过几分钟回来看报告' : ('没跑起来：' + (r.error || '')), r.started ? 'ok' : 'err')
        } catch (e) { say(e.message, 'err') } finally { setBusy('') }
      }
      const onSocialRun = async (kind) => {
        setBusy(kind)
        try {
          const r = await jpost(kind === 'diary' ? '/diary/run' : '/social/run', {})
          say(r.started ? (kind === 'diary' ? '已开始写今天的日常；公开文案按发送方式进入待发件箱' : '已开始检查新来信；首次只建立基线，回复按发送方式处理') : (r.error || '暂未启动'), r.started ? 'ok' : 'err')
        } catch (e) { say(e.message, 'err') } finally { setBusy('') }
      }
      const saveContacts = async () => {
        setBusy('contacts')
        try {
          const r = await patch({ socialContacts: contactsDraft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) }, '互动名单')
          if (r) { contactsDirty.current = false; setContactsDraft(r.cfg.socialContacts.join('\n')) }
        } finally { setBusy('') }
      }

      const onTest = async () => {
        setBusy('test'); setTest(null)
        try { setTest(await jget('/test')) } catch (e) { say('自检失败：' + e.message, 'err') } finally { setBusy('') }
      }

      const onReport = async () => {
        if (report !== null) { setReport(null); return }
        setBusy('report')
        try { const r = await jget('/report'); setReport(r.ok ? r.md : '（今天还没有报告）') }
        catch (e) { say(e.message, 'err') } finally { setBusy('') }
      }

      // ── ⭐ P3：测视觉接口（主 + 各备用各打一发，只验鉴权/模型名）──
      const onVisionTest = async () => {
        setBusy('vtest'); setVtest(null)
        try { setVtest(await jget('/test-vision')) } catch (e) { say('测视觉失败：' + e.message, 'err') } finally { setBusy('') }
      }

      // ── ⭐ P4：待发件箱 ──
      const loadOutbox = async () => {
        try { setOutbox(await jget('/outbox')) } catch (e) { say('读待发件箱失败：' + e.message, 'err') }
      }
      const onApprove = async (ids) => {
        setBusy('approve')
        try {
          const r = await jpost('/outbox/approve', { ids })
          const bad = (r.results || []).filter((x) => !x.ok)
          say(bad.length
            ? `批准了 ${(r.results || []).length - bad.length} 条，失败 ${bad.length} 条：${bad.map((b) => b.msg || b.error).join('；')}`
            : `已发出 ${(r.results || []).length} 条`, bad.length ? 'err' : 'ok')
          await loadOutbox(); await load()
        } catch (e) { say(e.message, 'err') } finally { setBusy('') }
      }
      const onDiscard = async (ids) => {
        setBusy('discard')
        try { await jpost('/outbox/discard', { ids }); say('已丢弃', 'ok'); await loadOutbox() }
        catch (e) { say(e.message, 'err') } finally { setBusy('') }
      }

      const onLog = async () => {
        if (logTail !== null) { setLogTail(null); return }
        try { const r = await jget('/log'); setLogTail(r.tail || '（空）') } catch (e) { say(e.message, 'err') }
      }

      const loadMemory = async () => {
        try {
          const r = await jget('/self')
          if (!r.ok) throw new Error(r.error)
          setSelf(r)
          setFamilyDraft(ARR(cfg?.familyMembers).join('\n'))
        } catch (e) { say('读取记忆失败：' + e.message, 'err') }
      }
      const searchMemory = async () => {
        try { setFound((await jget('/self/search?q=' + encodeURIComponent(query))).results || []) }
        catch (e) { say(e.message, 'err') }
      }
      const readMemory = async (source) => {
        try { setEntry((await jget('/self/read?source=' + encodeURIComponent(source))).record) }
        catch (e) { say(e.message, 'err') }
      }
      const addFeedback = async () => {
        try {
          const r = await jpost('/self/feedback', { text: feedback })
          if (!r.ok) throw new Error(r.error)
          setFeedback(''); say('已存入独立经历库，下轮可检索并据此反思。', 'ok'); await loadMemory()
        } catch (e) { say(e.message, 'err') }
      }

      if (!cfg) {
        return h('div', { 'data-dd-page': '' },
          h('div', { 'data-dd-note': '' }, '读设置中…（一直是这句的话：刚装完没重启 dsh，或者装到了别的 profile）'))
      }

      const sw = (k) => Boolean(cfg[k])
      const steps = (obj) => (obj.steps || []).map((s) => `${s.ok ? '✓' : '✗'} ${s.name}：${s.msg}`).join('　') || obj.error || ''

      // ═══════════════════════════════ 头 ═══════════════════════════════
      const head = [
        h('div', { 'data-dd-row': '', key: 'badge' },
          h(Badge, {}, `今天已挑 ${st.pickedToday ?? 0}/${cfg.perDay ?? 0} 条`),
          h(Badge, {}, st.loginUnknown ? '登录状态待空闲时检查' : st.loggedIn ? '抖音已登录' : '抖音未登录'),
          h(Badge, {}, '浏览器 ' + (cfg.browserMode || 'auto')),
          h(Badge, {}, st.peakNow ? '现在是高峰' : '现在是谷时'),
          h(Badge, {}, 'v' + (st.version || '?')),
          h('div', { 'data-dd-grow': '' }),
          h(Btn, { primary: true, disabled: busy === 'run', onClick: onRun }, busy === 'run' ? '跑着…' : '现在跑一轮')),
        msg.text ? h('div', {
          'data-dd-msg': '', key: 'msg',
          'data-err': msg.kind === 'err' ? '' : undefined,
          'data-ok': msg.kind === 'ok' ? '' : undefined,
        }, msg.text) : null,
        // ⭐ P1：上一轮被验证/风控中止过 ⇒ 顶上挂红字，别让人以为"今天没什么可看的"
        st.lastAbort ? h('div', { 'data-dd-msg': '', 'data-err': '', key: 'abort' },
          `⚠️ 上一次运行被中止：${st.lastAbort.reason || '验证 / 风控'}　（${String(st.lastAbort.at || '').replace('T', ' ').slice(0, 16)}）`
          + '　—— 这一轮没有继续刷。去点「登录抖音」把页面处理一下，下一轮就正常了。') : null,
        h('div', { 'data-dd-tabs': '', key: 'tabs' },
          ...TABS.map(([v, label]) => h('button', {
            key: v, 'data-dd-tab': '', 'aria-selected': tab === v ? 'true' : 'false',
            onClick: () => setTab(v),
          }, label))),
        h('div', { 'data-dd-row': '', key: 'save' },
          h(Btn, { primary: dirty, disabled: !dirty || busy === 'save', onClick: onSave }, dirty ? '保存改动' : '已保存'),
          h('div', { 'data-dd-note': '' },
            dirty ? '关键词 / 评论人设 / 博主链接改完要点这里；开关和数字是点了就存。' : '开关和数字点了就存；文字类的改完点「保存改动」。')),
      ]

      // ═══════════════════════════════ 日常 ═══════════════════════════════
      const daily = [
        h(Sec, { title: '账号', key: 'acc' }, [
          h('div', { 'data-dd-row': '', key: 'row' },
            h(Btn, { primary: true, disabled: !!busy || polling, onClick: onLogin }, polling ? '等你扫码…' : '登录抖音'),
            polling ? h(Btn, { disabled: !!busy, onClick: onCancelLogin }, '结束等待') : null,
            h('div', { 'data-dd-note': '' }, st.loggedIn ? `已登录：${st.who || '（不知道是谁）'}` : '点一下会开一个浏览器窗口，在里面扫码（登完自动变绿）')),
          h('div', { 'data-dd-note': '', key: 'note' }, '登录态存在插件自己的浏览器 profile 里，跟你平常那个浏览器互不干扰，重启也在。'),
          h(Row, {
            key: 'mode', label: '浏览器窗口',
            note: 'hidden = 窗口最小化；headless = 无窗口；visible = 显示窗口。扫码期间保持可见，模式改动在结束等待后使用。',
          }, h('div', { 'data-dd-row': '' },
            ...['auto', 'hidden', 'headless', 'visible'].map((m) => h(Btn, {
              key: m, primary: (cfg.browserMode || 'auto') === m, onClick: () => patch({ browserMode: m }),
            }, m)))),
        ]),
        h(Sec, { title: '什么时候自己跑', key: 'when' }, [
          h(Row, {
            key: 'pv', label: '谷时自动跑',
            note: '工作日 9–12 / 14–18 是高峰，其余（含整个周末）都便宜；关了就只能手动跑',
          }, h(Sw, { on: sw('peakValley'), onChange: (v) => patch({ peakValley: v }) })),
          sw('peakValley') ? h(Sub, { key: 'sub' }, [
            h(Row, { key: 'noon', label: '中午谷时（12–14 点）' }, h(Sw, { on: sw('noon'), onChange: (v) => patch({ noon: v }) })),
            h(Row, { key: 'night', label: '晚上谷时（18 点–次日 9 点）' }, h(Sw, { on: sw('night'), onChange: (v) => patch({ night: v }) })),
          ]) : null,
          h(Row, { key: 'daily', label: '每日固定时间', note: '留空 = 不启用；填 08:30 这种' },
            h(Txt, { value: cfg.dailyAt || '', placeholder: 'HH:mm', width: 90, onChange: (v) => patch({ dailyAt: String(v || '').trim() }) })),
          h(Row, { key: 'ons', label: '开 dsh 时补跑', note: '今天还没跑过、且现在是谷时 ⇒ 起来 25 秒后自动补一轮' },
            h(Sw, { on: sw('onStart'), onChange: (v) => patch({ onStart: v }) })),
        ]),
        h(Sec, { title: '自检与报告', key: 'chk' }, [
          h('div', { 'data-dd-row': '', key: 'btns' },
            h(Btn, { disabled: busy === 'test', onClick: onTest }, busy === 'test' ? '测着…' : '测一下'),
            h(Btn, { onClick: onReport }, report !== null ? '收起报告' : '看今天的报告'),
            h(Btn, { onClick: onLog }, logTail !== null ? '收起日志' : '看日志')),
          test ? h('div', {
            'data-dd-msg': '', key: 'tres',
            'data-ok': test.ok ? '' : undefined, 'data-err': test.ok ? undefined : '',
          }, steps(test)) : null,
          report !== null ? h('pre', { 'data-dd-pre': '', key: 'rep' }, report) : null,
          logTail !== null ? h('pre', { 'data-dd-pre': '', key: 'log' }, logTail) : null,
          h('div', { 'data-dd-note': '', key: 'home' }, `家目录：${st.home || ''}`),
          h('div', { 'data-dd-note': '', key: 'today' }, `今天的报告：${st.report || '（还没有）'}`),
        ]),
      ]

      // ═══════════════════════════════ 偏好 ═══════════════════════════════
      const taste = [
        h(Sec, { title: '刷什么', key: 'src' }, [
          h(Row, { key: 'search', label: '关键词搜索', note: '按你填的词搜最近的作品' },
            h(Sw, { on: !!cfg.sources?.search, onChange: (v) => patchSrc('search', v) })),
          cfg.sources?.search ? h(Sub, { key: 'kw' }, [
            h('div', { 'data-dd-label': '', key: 'l' }, '关键词（一行一个，也可以用 、 , ; / 空格隔开）'),
            h(Area, {
              key: 'a', rows: 3, value: draft.kws,
              placeholder: 'AI\n编程\n摄影\n留空 = 用章程里默认那几组（AI / 编程 / 效率工具 / 摄影 / 健身）',
              onChange: (v) => edit('kws', v),
            }),
          ]) : null,
          h(Row, { key: 'following', label: '关注列表', note: '你关注的人最近发了什么' },
            h(Sw, { on: !!cfg.sources?.following, onChange: (v) => patchSrc('following', v) })),
          h(Row, { key: 'hot', label: '热榜', note: '看今天什么在火' },
            h(Sw, { on: !!cfg.sources?.hot, onChange: (v) => patchSrc('hot', v) })),
          h(Row, { key: 'users', label: '指定博主', note: '填主页链接，逐个看新作品' },
            h(Sw, { on: !!cfg.sources?.users, onChange: (v) => patchSrc('users', v) })),
          cfg.sources?.users ? h(Sub, { key: 'urls' }, [
            h('div', { 'data-dd-label': '', key: 'l' }, '博主主页（一行一个）'),
            h(Area, {
              key: 'a', rows: 3, value: draft.urls, mono: true,
              placeholder: 'https://www.douyin.com/user/MS4wLjABAAAA...',
              onChange: (v) => edit('urls', v),
            }),
          ]) : null,
          h(Row, { key: 'feed', label: '推荐流', note: '刷抖音推给你的内容（默认关）' },
            h(Sw, { on: !!cfg.sources?.feed, onChange: (v) => patchSrc('feed', v) })),
        ]),
        h(Sec, { title: '怎么判', key: 'judge' }, [
          h(Row, { key: 'perday', label: '每天最多挑几条', note: '挑满就收工 —— 宁缺毋滥' },
            h(Num, { value: cfg.perDay, min: 1, max: 20, onChange: (v) => patch({ perDay: v }) })),
          h(Row, { key: 'watch', label: '每条至少停留（秒）', note: '正常播放后取样，默认 30 秒，可调慢到 120 秒；遇到验证立即停止' },
            h(Num, { value: cfg.videoWatchSeconds ?? 30, min: 30, max: 120, onChange: (v) => patch({ videoWatchSeconds: v }) })),
          h(Row, { key: 'interval', label: '内容请求间隔（秒）', note: '默认 10 秒，可调慢到 60 秒；每次最多取 3 条，减少连续请求' },
            h(Num, { value: cfg.requestIntervalSeconds ?? 10, min: 10, max: 60, onChange: (v) => patch({ requestIntervalSeconds: v }) })),
          h(Row, { key: 'frames', label: '每条截几帧', note: '正常播放中定时截取，不拖动进度条；帧数越多，画面识别越花钱' },
            h(Num, { value: cfg.framesPerVideo, min: 1, max: 6, onChange: (v) => patch({ framesPerVideo: v }) })),
          h(Row, { key: 'ocr', label: '画面文字（OCR）', note: 'Windows 自带，零依赖。抖音没字幕，画面里的字常常就是全部信息' },
            h(Sw, { on: !!cfg.useOcr, onChange: (v) => patch({ useOcr: v }) })),
          h(Row, { key: 'vision', label: '画面理解（视觉模型）', note: '⚠️ 要花钱：填一个多模态接口让它"看图说话"' },
            h(Sw, { on: !!cfg.useVision, onChange: (v) => patch({ useVision: v }) })),
          cfg.useVision ? h(Sub, { key: 'vconf' }, [
            h('div', { 'data-dd-label': '', key: 'l1' }, '接口地址（OpenAI 兼容，会拼 /chat/completions）'),
            h(Txt, { key: 'base', value: cfg.visionApiBase, placeholder: 'https://open.bigmodel.cn/api/paas/v4', mono: true, onChange: (v) => patch({ visionApiBase: v }) }),
            h('div', { 'data-dd-label': '', key: 'l2' }, '密钥'),
            h(Txt, { key: 'key', value: cfg.visionApiKey, placeholder: 'sk-... 或平台的 key', mono: true, onChange: (v) => patch({ visionApiKey: v }) }),
            h('div', { 'data-dd-label': '', key: 'l3' }, '模型名'),
            h(Txt, { key: 'model', value: cfg.visionModel, placeholder: 'glm-4v-flash / gpt-4o-mini', mono: true, onChange: (v) => patch({ visionModel: v }) }),
            h('div', { 'data-dd-note': '', key: 'n1' }, '三样都填才会真用；主接口欠费 / 401 / 改名时，下面的备用会自动顶上。'),
            h('div', { 'data-dd-label': '', key: 'l4' }, '备用视觉（最多 2 条，每行一条：接口 | 模型 | 密钥）'),
            h(Area, {
              key: 'bk', rows: 2, mono: true,
              value: ARR(cfg.visionBackups).join('\n'),
              placeholder: 'https://open.bigmodel.cn/api/paas/v4 | glm-4v-flash | 你的key',
              onChange: (v) => patch({ visionBackups: v.split(/\r?\n/).filter(Boolean) }),
            }),
            h('div', { 'data-dd-row': '', key: 'vb' },
              h(Btn, { disabled: busy === 'vtest', onClick: onVisionTest }, busy === 'vtest' ? '测着…' : '测视觉接口')),
            vtest ? h('div', {
              'data-dd-msg': '', key: 'vres',
              'data-ok': vtest.ok ? '' : undefined, 'data-err': vtest.ok ? undefined : '',
            }, steps(vtest)) : null,
          ]) : null,
        ]),
        h(Sec, { title: '产出', key: 'out' }, [
          h(Row, { key: 'rl', label: '日报', note: '完整 = 每条有为什么值得 / 简版 = 一两行 / 不写 = 只挑不写' },
            h('select', {
              'data-dd-input': '', style: { width: '150px' }, value: cfg.reportLevel || 'full',
              onChange: (e) => patch({ reportLevel: e.target.value }),
            },
              h('option', { value: 'full' }, '完整'),
              h('option', { value: 'brief' }, '简版'),
              h('option', { value: 'off' }, '不写'))),
          h(Row, { key: 'keep', label: '截帧留几天', note: 'frames 里超过这么多天的截图会清掉，别无声长到几 GB' },
            h(Num, { value: cfg.retentionDays ?? 7, min: 1, max: 90, onChange: (v) => patch({ retentionDays: v }) })),
          h(Row, { key: 'scan', label: '每轮最多扫', note: '一轮累计最多刷多少条候选（默认 60）。到量就不再刷、直接用已经看到的写报告 —— 别让某一轮刷到一百多条' },
            h(Num, { value: cfg.scanLimit ?? 60, min: 10, max: 400, onChange: (v) => patch({ scanLimit: v }) })),
        ]),
      ]

      // ═══════════════════════════════ 互动 ═══════════════════════════════
      const social = [
        h(Sec, { title: '互关互动与来信', key: 'contacts' }, [
          h('div', { key: 'note', 'data-dd-note': '' }, '只处理你填写且能核验为互关的对象，最多20人。每行：精确昵称 | 完整抖音主页链接。首次检查仅建立消息基线，不回复历史聊天。此适配仅做过离线验证，页面无法确认对象时会停止。'),
          h(Area, { key: 'list', rows: 4, value: contactsDraft, placeholder: '好友昵称 | https://www.douyin.com/user/SEC_UID', onChange: (v) => { contactsDirty.current = true; setContactsDraft(v) } }),
          h(Btn, { key: 'save', disabled: !!busy, onClick: saveContacts }, '保存互动名单'),
          h(Row, { key: 'proactive', label: '看完视频后主动互动', note: '结合已看内容和兴趣写简短文字；每人每天最多一次，不保证每轮都要发' },
            h(Sw, { on: !!cfg.proactiveEnabled, onChange: (v) => patch({ proactiveEnabled: v }) })),
          h(Row, { key: 'proactiveQuota', label: '每天最多主动互动几次' },
            h(Num, { value: cfg.proactiveDailyQuota ?? 1, min: 0, max: 50, onChange: (v) => patch({ proactiveDailyQuota: v }) })),
          h(Row, { key: 'reply', label: '检查新来信并起草回复', note: '只回复名单内新文字消息；发送前再次检查账号、互关和对话是否已更新' },
            h(Sw, { on: !!cfg.autoReplyEnabled, onChange: (v) => patch({ autoReplyEnabled: v }) })),
          h(Row, { key: 'replyQuota', label: '每天最多回复几次' },
            h(Num, { value: cfg.replyDailyQuota ?? 5, min: 0, max: 50, onChange: (v) => patch({ replyDailyQuota: v }) })),
          h(Row, { key: 'inboxInterval', label: '消息检查间隔（分钟）', note: '每轮最多检查3人，轮流检查名单；DSH运行时生效' },
            h(Num, { value: cfg.inboxIntervalMinutes ?? 10, min: 10, max: 120, onChange: (v) => patch({ inboxIntervalMinutes: v }) })),
          h(Btn, { key: 'check', disabled: !!busy || !cfg.autoReplyEnabled || contactsDirty.current, onClick: () => onSocialRun('social') }, '立即检查消息'),
        ]),
        h(Sec, { title: '每日日常与抖音图文', key: 'diary' }, [
          h(Row, { key: 'enabled', label: '每天写日常', note: '按北京时间当天真实经历写日记；没有活动就如实记录，私人正文保存在本地' },
            h(Sw, { on: !!cfg.diaryEnabled, onChange: (v) => patch({ diaryEnabled: v }) })),
          h(Row, { key: 'at', label: '写日常时间（北京时间）', note: 'DSH需要运行；错过时间会补跑，失败至少隔30分钟再尝试' },
            h('input', { 'data-dd-input': '', type: 'time', value: cfg.diaryAt || '21:00', onChange: (e) => { if (e.target.value) patch({ diaryAt: e.target.value }) } })),
          h(Row, { key: 'publish', label: '允许发布日常到抖音', note: '仅将最多280字的公开文案生成文字图卡。发送方式选「自动发」后才自动发布；逐条审核时先进入待发件箱。不会上传私人日记或聊天。' },
            h(Sw, { on: !!cfg.diaryPublishEnabled, onChange: (v) => patch({ diaryPublishEnabled: v }) })),
          h('div', { key: 'limit', 'data-dd-note': '' }, '每日最多发布一次；结果不明时不重发。图文上传适配仅做过离线测试，真实页面结构不匹配会停止并记录原因。图卡为本地文字排版，未接入AI生图。'),
          h(Btn, { key: 'write', disabled: !!busy || !cfg.diaryEnabled, onClick: () => onSocialRun('diary') }, '现在写日常'),
        ]),
        h(Sec, { title: '评论人设', key: 'persona' }, [
          h('div', { 'data-dd-note': '', key: 'n1' },
            '写草稿、评论、以及日报里「它自己的一句话」时按这个说话。只接受本项目的简短文字指导，最多1000字。她的人格另存于独立记忆库，不读取其他项目的人设文件。'),
          h(Area, {
            key: 'area', rows: 6, value: draft.persona,
            placeholder: '例：说话短、有点冷幽默，不用 emoji；自称「我」，叫他「你」；别吹、别用感叹号堆情绪。',
            onChange: (v) => edit('persona', v),
          }),
          h('div', { 'data-dd-note': '', key: 'n2' },
            (String(draft.persona || '').trim()
              ? '这段是监护人的表达指导，她的成长人格可在「记忆与成长」中查看。'
              : '现在使用她在独立记忆库中的人格。')),
          dirty ? h('div', { 'data-dd-note': '', key: 'n3' }, '⚠️ 还没保存 —— 点上面「保存改动」。') : null,
        ]),
        h(Sec, { title: '对外发言', key: 'speak' }, [
          h('div', { 'data-dd-note': '', key: 'n0' },
            '这一轮那个 AI 只能往「待发件箱」写草稿；真发不发、发给谁、发几条，由下面这些说了算。默认全关。'),
          h(Row, { key: 'mode', label: '发送方式', note: 'review = 草稿等你逐条批准（默认）／ auto = 过白名单 + 配额就自动发' },
            h('select', {
              'data-dd-input': '', style: { width: '150px' }, value: cfg.outboxMode || 'review',
              onChange: (e) => patch({ outboxMode: e.target.value }),
            },
              h('option', { value: 'review' }, '我逐条批准'),
              h('option', { value: 'auto' }, '自动发'))),
          h(Row, { key: 'autoComment', label: '允许自动发表评论', note: '默认关闭；自动模式也需要打开此项。逐条批准仍由你决定' },
            h(Sw, { on: !!cfg.autoComment, onChange: (v) => patch({ autoComment: v }) })),
          h(Row, { key: 'at', label: '真 @（先弹下拉再点人）', note: '关着 = 正文里写 @名字（通知不到人）；开了 = 真的点到那个人' },
            h(Sw, { on: !!cfg.commentAtEnabled, onChange: (v) => patch({ commentAtEnabled: v }) })),
          cfg.commentAtEnabled ? h(Sub, { key: 'who' }, [
            h('div', { 'data-dd-label': '', key: 'l' }, '要 @ 谁（精确抖音昵称；无法唯一匹配就停止）'),
            h(Txt, { key: 't', value: cfg.mentionName, placeholder: '留空 = 不发', onChange: (v) => patch({ mentionName: v }) }),
          ]) : null,
          h(Row, { key: 'quota', label: '每天最多发几条评论', note: '发送结果不明也占用配额，避免重发；填 0 = 一条都不发' },
            h(Num, { value: cfg.dailyCommentQuota ?? 5, min: 0, max: 30, onChange: (v) => patch({ dailyCommentQuota: v }) })),
          h(Row, { key: 'dm', label: '私聊', note: '⚠️ 仅分享视频卡片，不发送草稿正文；需要精确白名单与审核，空名单不发' },
            h(Sw, { on: !!cfg.dmEnabled, onChange: (v) => patch({ dmEnabled: v }) })),
          cfg.dmEnabled ? h(Sub, { key: 'dms' }, [
            h('div', { 'data-dd-label': '', key: 'l' }, '只给这些人发（逗号 / 顿号 / 空格分隔）'),
            h(Txt, {
              key: 'wl', value: ARR(cfg.dmWhitelist).join('、'), placeholder: '好友昵称',
              onChange: (v) => patch({ dmWhitelist: v.split(/[\/,，、;；\s]+/).filter(Boolean) }),
            }),
            h(Row, { key: 'q', label: '私聊每天最多' },
              h(Num, { value: cfg.dmDailyQuota ?? 1, min: 0, max: 20, onChange: (v) => patch({ dmDailyQuota: v }) })),
          ]) : null,
          h(Row, { key: 'grp', label: '群消息', note: '仅分享视频卡片；需要精确白名单与审核，空名单不发' },
            h(Sw, { on: !!cfg.groupEnabled, onChange: (v) => patch({ groupEnabled: v }) })),
          cfg.groupEnabled ? h(Sub, { key: 'grps' }, [
            h('div', { 'data-dd-label': '', key: 'l' }, '只发到这些群（逗号 / 顿号 / 空格分隔）'),
            h(Txt, {
              key: 'wl', value: ARR(cfg.groupWhitelist).join('、'), placeholder: '群名',
              onChange: (v) => patch({ groupWhitelist: v.split(/[\/,，、;；\s]+/).filter(Boolean) }),
            }),
            h(Row, { key: 'q', label: '群每天最多' },
              h(Num, { value: cfg.groupDailyQuota ?? 1, min: 0, max: 20, onChange: (v) => patch({ groupDailyQuota: v }) })),
          ]) : null,
          h('div', { 'data-dd-sep': '', key: 'sep' }),
          h('div', { 'data-dd-row': '', key: 'ob' },
            h(Btn, { onClick: loadOutbox }, '刷新待发件箱'),
            h('div', { 'data-dd-note': '' }, outbox
              ? `待批 ${outbox.pending || 0} 条 · 今天评论已发 ${outbox.sentToday || 0}/${outbox.quota?.comment ?? 5} 条 · 模式 ${outbox.mode || 'review'}`
              : '（点一下读待发件箱）')),
          ARR(outbox?.items).length ? h(Sub, { key: 'items' },
            ...ARR(outbox?.items).map((o) => h('div', { 'data-dd-row': '', key: o.id },
              h('div', { 'data-dd-grow': '' },
                h('div', { 'data-dd-label': '' },
                  `${({ comment: '评论', dm: '视频私聊', group: '群分享', message: '主动互动', reply: '来信回复', diary: '日常图文' })[o.kind] || o.kind}${o.target ? ' → ' + o.target : ''}${o.diaryDay ? ' · ' + o.diaryDay : ''} · ${o.status || ''}`),
                h('div', { 'data-dd-note': '' }, o.text || ''),
                o.note ? h('div', { 'data-dd-note': '' }, '说明：' + o.note) : null),
              o.status === 'pending' ? h('div', { 'data-dd-row': '' },
                h(Btn, { primary: true, disabled: busy === 'approve', onClick: () => onApprove([o.id]) }, '批准并发出'),
                h(Btn, { disabled: busy === 'discard', onClick: () => onDiscard([o.id]) }, '丢弃')) : null))) : null,
        ]),
      ]

      // ═══════════════════════════════ 高级 ═══════════════════════════════
      const adv = [
        h(Sec, { title: '跑一轮用的东西', key: 'env' }, [
          h(Row, { key: 'prof', label: 'headless profile 名', note: '跑一轮时用哪个 dsh profile（一般不用改）' },
            h(Txt, { value: cfg.headlessProfile || 'headless', width: 150, onChange: (v) => patch({ headlessProfile: String(v || '').trim() || 'headless' }) })),
          h(Row, { key: 'bin', label: 'dsh 路径（留空=自己找）', note: '桌面版上万一提示"跑不起来"，把 dsh 的完整路径填这儿' },
            h(Txt, { value: cfg.dshBin || '', mono: true, placeholder: 'C:\\...\\dsh.cmd', onChange: (v) => patch({ dshBin: v }) })),
          h(Row, { key: 'lv', label: '日志详细程度', note: 'normal = 记关键步骤；debug = 连每步细节都记（排查用）' },
            h('select', {
              'data-dd-input': '', style: { width: '120px' }, value: cfg.logLevel || 'normal',
              onChange: (e) => patch({ logLevel: e.target.value }),
            }, h('option', { value: 'normal' }, 'normal'), h('option', { value: 'debug' }, 'debug'))),
        ]),
        h(Sec, { title: '它的地盘', key: 'home' }, [
          h('div', { 'data-dd-note': '', key: 'h1' }, `家目录：${st.home || ''}`),
          h('div', { 'data-dd-label': '', key: 'home-label' }, '新家目录（绝对路径）'),
          h(Txt, { key: 'home-input', value: homeDraft, mono: true, placeholder: 'D:\\抖音大肥鱼', onChange: (v) => { homeDirty.current = true; setHomeDraft(v) } }),
          h('div', { 'data-dd-note': '', key: 'home-note' }, '填写不存在或完全为空的独立目录。迁移配置、记忆、日报和登录态后立即生效，旧目录保留为备份。先保存改动，等本轮结束并关闭抖音专用浏览器后操作。'),
          h(Btn, { key: 'home-move', primary: true, disabled: !!busy || dirty || polling || !homeDraft.trim() || homeDraft.trim() === st.home, onClick: onMoveHome }, busy === 'home' ? '正在迁移…' : '迁移并使用'),
          h('div', { 'data-dd-note': '', key: 'h2' }, 'config.json（配置）/ duty.md（自定义章程）/ self/memory.sqlite（独立记忆与人格）/ picks.json / seen.json / out/ / frames/ / duty.log / browser/'),
          h('div', { 'data-dd-note': '', key: 'h3' }, '日志超过 2MB 会自动滚到 duty.log.1。'),
          h('div', { 'data-dd-row': '', key: 'h4' },
            h(Btn, { onClick: onLog }, logTail !== null ? '收起日志' : '看日志'),
            h(Btn, { disabled: busy === 'test', onClick: onTest }, '测一下')),
          logTail !== null ? h('pre', { 'data-dd-pre': '', key: 'log' }, logTail) : null,
        ]),
      ]

      const memory = [
        h(Sec, { title: '独立的抖音大肥鱼', key: 'identity' }, [
          h('div', { 'data-dd-note': '', key: 'note' }, '日记与经历长期归档，RAG按需检索；她自己维护最多8行/1000字的小提示表。所有数据与B站版独立。'),
          h(Btn, { key: 'refresh', onClick: loadMemory }, '读取人格与记忆'),
          self ? h('pre', { key: 'profile', 'data-dd-pre': '' }, JSON.stringify(self.persona, null, 2)) : null,
          self ? h('div', { key: 'count', 'data-dd-note': '' }, '归档 ' + self.stats.documents + ' 条 / 历史版本 ' + self.stats.versions + ' 条；' + (self.stats.diaryDue ? self.stats.diaryDay + ' 的日记待下轮补写' : '昨日日记已归档')) : null,
        ]),
        h(Sec, { title: '她给自己的小提示表', key: 'working' }, [
          ...ARR(self?.stats?.table).map((row) => h('div', { key: row.key, 'data-dd-note': '' }, row.key + '：' + row.text + (row.stale ? '（已过期，等待重新整理）' : ''))),
          !ARR(self?.stats?.table).length ? h('div', { key: 'empty', 'data-dd-note': '' }, '有具体经历后，她会按需整理。') : null,
        ]),
        h(Sec, { title: '检索日记和经历', key: 'search' }, [
          h(Txt, { key: 'q', value: query, placeholder: '例如：手工、上次聊过的电影', onChange: setQuery }),
          h(Btn, { key: 'go', onClick: searchMemory }, '按话题检索'),
          ...ARR(found.length ? found : self?.recent).map((row) => h(Btn, { key: row.source, onClick: () => readMemory(row.source) }, row.day + ' · ' + row.title)),
          entry ? h('pre', { key: 'entry', 'data-dd-pre': '' }, JSON.stringify(entry, null, 2)) : null,
        ]),
        h(Sec, { title: '成长轨迹', key: 'history' }, ARR(self?.history).map((row) =>
          h('div', { key: row.revision, 'data-dd-note': '' }, '版本 ' + row.revision + ' · ' + row.reason + ' · ' + row.sources.join('、')))),
        h(Sec, { title: '补充经历或反馈', key: 'feedback' }, [
          h(Area, { key: 'text', rows: 3, value: feedback, placeholder: '告诉她一件真实发生的事，或记录亲戚明确表达的喜好。', onChange: setFeedback }),
          h(Btn, { key: 'save', onClick: addFeedback }, '保存到经历库'),
        ]),
        h(Sec, { title: '监护人和亲戚', key: 'family' }, [
          h('div', { key: 'guardian', 'data-dd-note': '' }, '监护人：' + (cfg.guardianName || '监护人') + '。亲戚可以提意见，权限和发送规则由你配置。'),
          h('div', { key: 'format', 'data-dd-note': '' }, '先点「读取人格与记忆」加载名单；每行：称谓 | 抖音昵称 | 喜好。加入亲戚后，分享仍需在互动页设置相应白名单。'),
          h(Area, { key: 'family', rows: 4, value: familyDraft, placeholder: '姑姑 | 抖音昵称 | 电影、手工', onChange: setFamilyDraft }),
          h(Btn, { key: 'save', onClick: () => patch({ familyMembers: familyDraft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) }, '亲戚名单') }, '保存亲戚名单'),
        ]),
      ]
      const body = tab === 'daily' ? daily : tab === 'taste' ? taste : tab === 'social' ? social : tab === 'memory' ? memory : adv
      return h(Boundary, null, h('div', { 'data-dd-page': '' }, ...KIDS(head), ...KIDS(body)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-douyin-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-douyin-scroll: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-scroll', order: 31, label: '刷抖音' },
          () => h(Panel),
        ))
      },
    }
  },
})
