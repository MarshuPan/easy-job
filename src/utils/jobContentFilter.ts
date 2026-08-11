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
