export const SOCIAL_KINDS = ['message', 'reply', 'diary']

export function contactsOf(cfg) {
  const rows = Array.isArray(cfg.socialContacts) ? cfg.socialContacts : []
  if (rows.length > 20) throw new Error('互动名单最多20人')
  return rows.map((row) => {
    if (typeof row !== 'string') throw new Error('互动名单必须是文字列表')
    const parts = row.split('|').map((v) => v.trim())
    if (parts.length !== 2 || !parts[0] || parts[0] === '*' || parts[0].length > 80) throw new Error('互动名单格式：精确昵称 | 抖音主页链接')
    let url
    try { url = new URL(parts[1]) } catch { throw new Error('互动名单需要完整的抖音主页链接') }
    const m = url.pathname.match(/^\/user\/([A-Za-z0-9_-]{1,200})\/?$/)
    if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || !m || url.username || url.password || url.port) throw new Error('互动名单只能使用 https://www.douyin.com/user/… 主页')
    return { name: parts[0], secUid: m[1], url: `https://www.douyin.com/user/${m[1]}` }
  }).filter((row, i, all) => {
    if (all.some((other, j) => j !== i && (other.name === row.name || other.secUid === row.secUid))) throw new Error('互动名单中昵称和主页必须唯一')
    return true
  })
}

export function socialPolicy(cfg, item) {
  if (!SOCIAL_KINDS.includes(item.kind) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 300) throw new Error('文字草稿格式错误')
  if (!item.ticket || !item.memorySource || !/^\d{1,30}$/.test(item.accountUid || '')) throw new Error('缺少人格、原始来源或登录账号记录，请重新生成')
  if (item.kind === 'diary') {
    if (!cfg.diaryEnabled || !cfg.diaryPublishEnabled) throw new Error('每日生活或抖音发布开关未开启')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.diaryDay) || item.target || item.text.length > 280) throw new Error('日常发布草稿格式错误')
    return 1
  }
  const enabled = item.kind === 'reply' ? cfg.autoReplyEnabled : cfg.proactiveEnabled
  if (!enabled) throw new Error('此类文字互动未开启')
  const contact = contactsOf(cfg).find((c) => c.secUid === item.peerSecUid && c.name === item.target)
  if (!contact) throw new Error('对象不在当前互动名单中，或昵称已变化')
  if (item.kind === 'reply' && !item.replyTo) throw new Error('回复必须对应真实收到的消息')
  if (item.kind === 'message' && !/^\d{1,30}$/.test(item.videoId)) throw new Error('主动互动必须有已观看的视频')
  return Math.max(0, Math.min(50, Number(item.kind === 'reply' ? cfg.replyDailyQuota : cfg.proactiveDailyQuota) || 0))
}

/** Sources are checked again immediately before delivery, including edited diaries. */
export function validateSocialSource(store, item) {
  const doc = store.document(item.memorySource, { current: true })
  if (item.kind === 'diary') {
    if (doc.kind !== 'diary' || doc.day !== item.diaryDay || doc.data.publicText !== item.text) throw new Error('公开日常已修订，请重新生成发布草稿')
  } else if (item.kind === 'reply') {
    if (doc.data.origin !== 'douyin_inbox' || doc.data.accountUid !== item.accountUid || doc.data.peer?.secUid !== item.peerSecUid || doc.data.peer?.name !== item.target || doc.data.replyTo !== item.replyTo || !doc.data.replyText) throw new Error('回复与收到的消息来源不一致')
  } else if (doc.data.origin !== 'douyin_frames' || doc.data.videoId !== item.videoId) throw new Error('主动互动缺少实际画面来源')
  return doc
}
