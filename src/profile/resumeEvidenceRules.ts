/**
 * 简历事实的几条硬规则。配置读取、导入、提取和招呼语检查都要用，放在一个不依赖 AI 调用
 * 的轻模块里，避免配置层为了几个常量把后台模型代码一起引进来。
 */

/**
 * 描述「这件事是不是我做的」的受控动词。事实只能从这里授权，招呼语出现这些词时必须
 * 有对应事实的授权。
 */
export const CONTROLLED_CLAIM_VERBS = [
  '主导',
  '负责',
  '牵头',
  '搭建',
  '落地',
  '参与',
  '使用',
  '熟悉',
  '做过',
] as const

const fullWidthPunctuation: Record<string, string> = {
  '，': ',',
  '。': '.',
  '；': ';',
  '：': ':',
  '（': '(',
  '）': ')',
  '！': '!',
  '？': '?',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '、': ',',
}

/**
 * 比较摘录和原文前的归一化：去掉空白和 Markdown 标记，全角标点换成半角。
 *
 * 模型摘录时常把 `**加粗**` 的星号、换行或全角逗号顺手改掉。逐字比较会因此判定「原文里
 * 找不到」，而这些差异不改变内容本身。
 */
export function normalizeResumeText(value: string) {
  return value
    .replace(/[\s*_`#>|~]+/gu, '')
    .replace(/[，。；：（）！？“”‘’、]/gu, (char) => fullWidthPunctuation[char] ?? char)
    .toLowerCase()
}

/** 摘录是否确实出自这份简历。这是整套事实里唯一能机械核对的防编造手段。 */
export function quoteAppearsInResume(markdown: string, quote: string) {
  const normalizedQuote = normalizeResumeText(quote)
  return normalizedQuote.length > 0 && normalizeResumeText(markdown).includes(normalizedQuote)
}

const chineseDigits: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 「两」「四」「十二」「二十五」这类写法换成阿拉伯数字；更大的单位（百、千、万）保持原样。 */
function chineseNumeralToArabic(run: string) {
  if (!run.includes('十')) {
    return run
      .split('')
      .map((char) => chineseDigits[char])
      .join('')
  }
  const [tens, ones] = run.split('十')
  if (tens.length > 1 || ones.length > 1) return run
  return String((tens ? chineseDigits[tens] : 1) * 10 + (ones ? chineseDigits[ones] : 0))
}

/** 文本里出现的全部数字，按整数/小数取整段，避免 100 被当成 1000 的一部分。 */
function numbersIn(value: string) {
  const arabic = value.replace(/[零一二两三四五六七八九十]+/gu, chineseNumeralToArabic)
  return arabic.match(/\d+(?:\.\d+)?/gu) ?? []
}

/**
 * 只留下能在摘录里找到的数字。
 *
 * 招呼语要求「事实里优先带数字」，数字因此是最容易被写进开场白、也最需要保证不是编的
 * 那部分。摘录已经核对过出自简历，数字再核对出自摘录，整条链就是可追溯的。
 *
 * 比的是数字本身，不是整段写法：真实简历上，模型把「两条」写成「2 条」、把「约 100 账号」
 * 写成「约 100 个」，数字都是原文的，逐字比较会把它们误丢。真正要拦的是摘录里没有的数，
 * 比如把「Web 后台/小程序/H5/App」自己数成「4 类」。
 */
export function verifiedMetrics<T extends { value: string }>(
  quote: string,
  metrics: readonly T[] | undefined,
): T[] {
  if (!metrics?.length) return []
  const quoteNumbers = new Set(numbersIn(quote))
  return metrics.filter((metric) => {
    const valueNumbers = numbersIn(metric.value)
    // 没有可比的数字（如「千万级」）时退回整段比较。
    if (valueNumbers.length === 0) {
      const value = normalizeResumeText(metric.value)
      return value.length > 0 && normalizeResumeText(quote).includes(value)
    }
    return valueNumbers.every((number) => quoteNumbers.has(number))
  })
}

/**
 * 证据版本 3 删掉的字段。归属程度、置信度、领域和技能和证据类型、授权动词说的是同一件事，
 * 代码从不读取；buckets 一直是固定为空的兼容字段。
 *
 * 校验对字段是严格的，老用户存储和旧导出文件里还有这些字段，读取和导入前要先清掉，
 * 否则会被判成未知字段、整份配置读不出来。
 */
const REMOVED_EVIDENCE_KEYS = ['buckets']
const REMOVED_FACT_KEYS = ['ownership', 'confidence', 'domains', 'skills']

export function pruneRemovedEvidenceFields(evidence: unknown) {
  if (evidence == null || typeof evidence !== 'object' || Array.isArray(evidence)) return
  const record = evidence as Record<string, unknown>
  for (const key of REMOVED_EVIDENCE_KEYS) delete record[key]
  if (!Array.isArray(record.facts)) return
  for (const fact of record.facts) {
    if (fact == null || typeof fact !== 'object' || Array.isArray(fact)) continue
    for (const key of REMOVED_FACT_KEYS) delete (fact as Record<string, unknown>)[key]
  }
}
