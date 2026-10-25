import { hitWhitelist } from './outbox.mjs'
export function deliveryPolicy(cfg, item) {
  if (!['pending', 'approved'].includes(item.status)) throw new Error('只有待审草稿可以发送，已发送或结果不明的条目不能重试')
  if (!/^\d{1,30}$/.test(String(item.videoId))) throw new Error('缺少有效视频ID')
  if (!item.ticket || !item.memorySource) throw new Error('草稿没有人格和画面来源，请重新生成')
  if (item.kind === 'comment') {
    if (String(item.target || '') !== String(cfg.mentionName || '')) throw new Error('评论目标与当前设置不一致，请重新生成')
    if (cfg.commentAtEnabled && !String(item.target || '').trim()) throw new Error('真 @ 需要明确的评论目标')
    return Math.max(0, Number(cfg.dailyCommentQuota ?? 5))
  }
  if (!['dm', 'group'].includes(item.kind)) throw new Error('未知草稿类型')
  if (cfg[`${item.kind}Enabled`] !== true) throw new Error('此类分享未开启')
  if (!hitWhitelist(cfg[`${item.kind}Whitelist`], item.target)) throw new Error('收件人不在精确白名单中')
  return Math.max(0, Number(cfg[`${item.kind}DailyQuota`] ?? 1))
}
