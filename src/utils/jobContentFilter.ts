const negationPrefix = '(?<![不无].{0,5})'
const productContextSuffix =
  '(?!系统|软件|工具|服务|团队|协作|场景|流程|能力|平台|数据|分析|指标|应用|产品|业务|部门|效率|自动化|智能)'

const contextualRejectPatterns: Record<string, RegExp[]> = {
  应届: [
    /(?:校招|校园招聘|面向应届|限应届|仅限应届|只要应届|接受应届|欢迎应届)/,
    /应届(?:生|毕业生)?(?:[\s\S]{0,8})(?:优先|可投|可报|培养|校招|校园招聘)/,
    /(?:202[0-9]|203[0-9])届/,
  ],
  实习: [
    /(?:实习生|实习岗|实习岗位|可实习|长期实习|暑期实习|日常实习)/,
    /实习(?:[\s\S]{0,8})(?:优先|可投|可报|转正|留用)/,
  ],
  /**
   * 「司机」是这份排除词里唯一的裸双字词，中文没有词边界，裸匹配会命中「老司机」。
   * 实际发生过：一个 30-50K 的 C 端 AI 岗位，因为公司介绍里写「创业老司机+超配团队」
   * 被整条过滤掉。而同一批里滴滴那条「骑手/司机侧运力运营」是真该挡的，所以不能
   * 简单删词，只能按上下文区分：司机作为业务对象或招聘对象时才算命中。
   */
  司机: [
    /(?<!老)司机(?:端|侧|运力|运营|管理|服务|分层|画像|群体|生态|招募|注册|接单|派单|补贴|激励|留存|抽成|app)/,
    /(?:网约车|出租车|货运|货车|代驾|外卖|配送|骑手|车队|运力)[\s\S]{0,8}(?<!老)司机/,
    /(?:招聘|招募|诚聘|急聘|直招|直招)[\s\S]{0,8}(?<!老)司机/,
  ],
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function shouldRejectJobContent(content: string, keyword: string) {
  const normalizedKeyword = keyword.trim().toLowerCase()
  if (!normalizedKeyword) return false

  const contextualPatterns = contextualRejectPatterns[normalizedKeyword]
  if (contextualPatterns) {
    return contextualPatterns.some((pattern) => pattern.test(content))
  }

  const pattern = new RegExp(
    `${negationPrefix}${escapeRegExp(normalizedKeyword)}${productContextSuffix}`,
  )
  return pattern.test(content)
}
