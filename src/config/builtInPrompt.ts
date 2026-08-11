/**
 * 内置提示词的「用户改过没有」判定。
 *
 * 提示词在首次安装时就写进存储，之后配置读取是「默认值打底、已存值覆盖」——已存的永远
 * 赢。对用户自己写的提示词这是对的，但对没改过的就意味着冻结在安装那一版：后续对提示词
 * 的每一次改进，老用户一条都收不到。
 *
 * 所以升级前要先回答一个问题：存下来的这份，是用户写的，还是某一版的内置默认？
 * 原来的做法是把每个历史版本的全文都留在代码里做等值比较，5 份合计 3.6KB，而且提示词
 * 改得越勤留得越多。这里改成记指纹：值和某个历史内置版本一致就说明没改过，可以安全升级。
 *
 * 指纹前去掉所有空白，这样 prettier 重排格式不会把一份没改过的提示词误判成用户自定义。
 */
export function fingerprintBuiltInPrompt(value: string) {
  const normalized = value.replace(/\s+/g, '')
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 历史上发布过的招呼语提示词指纹，含当前这一版。
 *
 * 改 DEFAULT_AI_GREETING_PROMPT 时必须把新指纹追加进来。忘了加的后果是静默的：测试照样
 * 绿，但所有停留在上一版、又没自己改过提示词的用户从此收不到任何提示词更新。
 * defaults.test.ts 里有一条绊线守着当前默认值必须在表内，改了提示词那条会先红。
 */
export const BUILT_IN_AI_GREETING_PROMPT_FINGERPRINTS = Object.freeze([
  'c3f25040', // 初版
  'dc3ccc29', // 拆消息角色
  'd7cd7847', // 语义分段 + 固定称呼
  'ddaeec27', // 语义分段
  'a97fba60', // 系统规则分层
  '06700356', // 固定开头顺序
  'a2548dd7', // 当前：开头顺序不再写死领域
])

/** 值是某个历史内置版本（用户没改过）就升级到当前默认；用户自己写的原样保留。 */
export function migrateBuiltInGreetingPrompt(value: string, current: string) {
  if (typeof value !== 'string' || value.trim() === '') return current
  return BUILT_IN_AI_GREETING_PROMPT_FINGERPRINTS.includes(fingerprintBuiltInPrompt(value))
    ? current
    : value
}
