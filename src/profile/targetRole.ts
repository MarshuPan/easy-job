/**
 * 求职定位：候选人以什么身份求职（如「产品经理，侧重 B 端 SaaS」）。
 *
 * 搜索关键词是用来找岗位的，不等于身份；简历事实是从经历里拆出来的，也不含这一句。
 * 没有它，招呼语不知道「我是谁」，开头没有身份，用词也会跟着每份 JD 漂。
 */
export const TARGET_ROLE_MAX_CHARACTERS = 60

const resumeIntentLine =
  /^\s*(?:[-*]\s*)?(?:\*\*)?(?:求职意向|期望职位|期望岗位|目标岗位|期望)(?:\*\*)?\s*[：:]\s*(.+)$/mu

/** 简历里「期望：产品经理 ｜ 上海 ｜ 30–40K」这一行的岗位部分。 */
export function targetRoleFromResume(markdown: string | undefined) {
  const line = markdown?.match(resumeIntentLine)?.[1]
  const role = line
    ?.split(/[｜|/，,；;]/u)[0]
    ?.replace(/\*+/gu, '')
    .trim()
  return role ? role.slice(0, TARGET_ROLE_MAX_CHARACTERS) : ''
}

/**
 * 生效的求职定位。用户填的优先；没填时按这个岗位所属的 BOSS 求职期望——一个人可以同时挂
 * 「产品经理」和「运营」两个期望，从哪个期望下抓到的岗位就用哪个身份，不能一律取第一个。
 * 岗位不属于任何期望（搜索来的）时，取第一个启用的期望，再退到简历里的意向行。
 */
export function resolveTargetRole(args: {
  targetRole?: string
  jobExpectationIds?: readonly string[]
  expectations?: ReadonlyArray<{ id?: string; positionName?: string }>
  resumeMarkdown?: string
}) {
  const configured = args.targetRole?.trim()
  if (configured) return configured
  const expectations = (args.expectations ?? []).filter((item) => item.positionName?.trim())
  const jobIds = new Set(args.jobExpectationIds ?? [])
  const own = expectations.find((item) => item.id != null && jobIds.has(String(item.id)))
  const expectation = own ?? expectations[0]
  if (expectation?.positionName) return expectation.positionName.trim()
  return targetRoleFromResume(args.resumeMarkdown)
}
