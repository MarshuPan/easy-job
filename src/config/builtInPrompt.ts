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
  'a2548dd7', // 开头顺序不再写死领域
  'dd47ea06', // 不再自报姓名年限，JD 核心职责开头，篇幅随总字数伸缩（1.3.7 起发出）
  '6f77e584', // 身份、项目、能力、价值、收尾五段；按求职定位写身份，收尾不提问（1.3.9）
  'f7e633df', // 能力举例去掉 AI 专属说法，不同行业的用户同样适用（1.3.10–1.3.12）
  'b33e47ec', // 陈述不许愿，禁「我希望/定位/交集」，项目按场景选，禁流程套话（1.3.13–1.3.16）
  '39bc2e92', // 围绕 anchor.need 写，禁用词清单改由代码检查，参考 recentFactUses（1.3.17）
  'c696e8b6', // （1.3.18）价值部分不再写「能直接拿出什么」（被照抄成「我能拿出……」），用具体做法或结果收尾
  'f43674ff', // 身份直接说做什么、不提求职；价值说能解决什么，不再写「哪个环节是我做过的」
  'd66f1720', // 按 JD 和表达需要引用真实经历，不固定项目或能力数量
])

/** 值是某个历史内置版本（用户没改过）就升级到当前默认；用户自己写的原样保留。 */
export function migrateBuiltInGreetingPrompt(value: string, current: string) {
  if (typeof value !== 'string' || value.trim() === '') return current
  return BUILT_IN_AI_GREETING_PROMPT_FINGERPRINTS.includes(fingerprintBuiltInPrompt(value))
    ? current
    : value
}
