import { normalizeResumeText } from '@/profile/resumeEvidenceRules'

/**
 * 招呼语的「重复分布」：哪些长句用多了、哪些事实用多了。
 *
 * 用户确认的原则（2026-09-24）：事实不变、JD 是主变量，一定的重复可以接受，但分布要均匀，
 * 不能让人一看全在讲同一件事。原来把最近 10 条招呼语全文交给模型「请避开」——给模型看
 * 范例反而引它模仿，真机上 13 条里 11 条是同一个骨架、9 条讲同一个项目。改成由代码统计、
 * 只把「这几句用多了」「这几条事实用多了」告诉模型，并由代码检查（参考 Antislop, ICLR 2026
 * 「先统计、再压制」的思路）。
 */

/** 一个片段至少这么长才算「长句」：短于它的多是正常搭配（「期待进一步沟通」）。 */
const phraseLength = 8
/** 同一片段在这么多条招呼语里出现，就算用多了。 */
export const REPEATED_PHRASE_MIN_GREETINGS = 3
/** 同一条事实在最近 10 条里用了这么多次，就算用多了：告诉模型同样贴合时换一条。 */
export const OVERUSED_FACT_MIN_COUNT = 3
/**
 * 用到这么多次，匹配选它当优先事实也不再交给招呼语：匹配几乎每次选同一条，招呼语照着用。
 * 不用重写来拦——1.3.18 按这个数拦下重写 9 次，6 次重写后仍用同一条，白花一次模型调用。
 */
export const OVERUSED_PRIMARY_FACT_COUNT = 4
const maxAvoidPhrases = 8

/**
 * 不管近期用没用过都不该出现的说法：真机上反复出现、读起来像模板或简历腔的句式。
 * 按正则匹配，只收具体句式，不收单个词（「定位」在「产品定位」里是正常的）。
 */
export const STOCK_PHRASE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /我希望/u, label: '我希望' },
  { pattern: /入职后/u, label: '入职后' },
  { pattern: /从事.{1,12}工作/u, label: '从事……工作' },
  { pattern: /在.{2,40}上有(实际|丰富)?(项目)?(经验|经历)/u, label: '在……上有实际经验' },
  { pattern: /能拿出.{1,30}案例|我有.{1,30}的案例/u, label: '我有……的案例' },
  { pattern: /(这套|这些)(经验|方法).{0,6}(可用于|可迁移|能用于)/u, label: '这套经验可用于……' },
  { pattern: /可迁移到/u, label: '可迁移到' },
  // 默认提示词曾写「能直接拿出什么」，1.3.17 的 11 条里 6 条照抄成「我能拿出……经验」。
  { pattern: /能拿出/u, label: '我能拿出……' },
  // 1.3.18 提示词写「哪个环节是我做过的」，20 条里一半多照抄成「我做过的对应环节是……」，
  // 读起来是在替对方划小自己的范围。
  { pattern: /做过的.{0,8}环节|对应.{0,8}环节|的一环/u, label: '我做过的对应环节……' },
  // 身份句被逼着换说法时写出来的：「求职定位是AI产品经理」「我应聘AI产品经理」。
  { pattern: /求职(定位|方向)|定位是|我应聘/u, label: '求职定位是……' },
]

/**
 * 主动说自己没做过什么、经历偏哪一侧。第一条消息就替对方指出自己不合适，是在自降通过率；
 * 事实边界靠不写做不到的事来守，不靠声明。
 */
export const SELF_DEPRECATION_PATTERNS: readonly RegExp[] = [
  /不涉及/u,
  /(经历|经验|实践|背景)主要(在|是|集中在).{0,8}侧/u,
  /没有(直接)?(做过|经验|接触过?)/u,
  // 「我没有PLM、IPD或BOM项目经历」
  /没有.{0,24}(经历|经验|背景|实践)/u,
  /(并未|未曾|不曾)(做过|接触|参与|负责)/u,
  // 1.3.18 漏掉的四种说法：「仓配规则不是我做过的领域」「不在上述项目范围内」
  // 「财税系统本身我没有实践」「并非智能座舱验证」。
  /不是我(做过|接触过?|负责过?)的/u,
  /不在.{0,12}范围/u,
  /并非/u,
  /没做过/u,
  /缺乏.{0,6}(经验|经历)/u,
  /经验(不足|有限|尚浅)/u,
  /虽然(我)?(没有|不是|不太)/u,
  /(尚未|暂未|还没有?)(接触|涉及|做过)/u,
]

function stripSalutation(text: string) {
  return text.replace(/^[^，,。！!]{0,8}(老师|先生|女士|经理|总)?(您好|你好)[，,。！!\s]*/u, '')
}

const clauseBoundary = /[，,。；;！!？?、：:\n（）()“”"「」]/u

/**
 * 开场的身份句不计入重复：同一个人每次都是同一个身份，稳定是正常的。1.3.18 把它算进去，
 * 模型为了避开「我是有8年工作经验的AI产品经理」，写出了「我应聘AI产品经理」
 * 「求职定位是AI产品经理」这类别扭说法。
 */
function withoutIdentitySentence(body: string) {
  const end = body.search(/[。！!？?\n]/u)
  return end < 0 ? '' : body.slice(end + 1)
}

/**
 * 一条招呼语的分句（去掉称呼、开场身份句和空白）。重复按分句统计：跨标点拼出来的片段
 * （「……销售线索；我也参与」）不是一句话，交给模型也说不清要避开什么。
 */
function clausesOf(messages: readonly string[]) {
  return withoutIdentitySentence(stripSalutation(messages.join('\n')).replace(/[^\S\n]+/gu, ''))
    .split(clauseBoundary)
    .filter((clause) => clause.length >= phraseLength)
}

/** 比较用的键：只折叠大小写，长度不变，下标能对回原文。 */
const keyOf = (text: string) => text.toLowerCase()

function gramsOf(text: string) {
  const grams = new Set<string>()
  const key = keyOf(text)
  for (let index = 0; index + phraseLength <= key.length; index += 1) {
    grams.add(key.slice(index, index + phraseLength))
  }
  return grams
}

function greetingGrams(messages: readonly string[]) {
  const grams = new Set<string>()
  for (const clause of clausesOf(messages)) for (const gram of gramsOf(clause)) grams.add(gram)
  return grams
}

/**
 * 最近招呼语里被多条共用的长句，返回原文。先数每个 8 字片段出现在几条里，再在每个分句里
 * 把相邻的高频片段连起来，这样给模型的是「约100个账号单月带来约3万条销售线索」，
 * 而不是一堆碎片。
 */
export function findRepeatedPhrases(
  greetings: ReadonlyArray<readonly string[]>,
  minGreetings = REPEATED_PHRASE_MIN_GREETINGS,
) {
  if (greetings.length < minGreetings) return []
  const counts = new Map<string, number>()
  for (const greeting of greetings) {
    for (const gram of greetingGrams(greeting)) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  const countOf = (gram: string) => counts.get(gram) ?? 0
  const phrases = new Map<string, { phrase: string; greetings: number }>()
  for (const greeting of greetings) {
    for (const clause of clausesOf(greeting)) {
      const key = keyOf(clause)
      let start = -1
      let support = Infinity
      for (let index = 0; index + phraseLength <= key.length + 1; index += 1) {
        const count =
          index + phraseLength <= key.length ? countOf(key.slice(index, index + phraseLength)) : 0
        if (count >= minGreetings) {
          if (start < 0) start = index
          support = Math.min(support, count)
          continue
        }
        if (start >= 0) {
          const phrase = clause.slice(start, index - 1 + phraseLength)
          const existing = phrases.get(keyOf(phrase))
          if (!existing || existing.greetings < support) {
            phrases.set(keyOf(phrase), { phrase, greetings: support })
          }
          start = -1
          support = Infinity
        }
      }
    }
  }
  // 长句优先，被更长句子包含的片段不再单列。
  const ordered = [...phrases.values()].sort(
    (left, right) => right.phrase.length - left.phrase.length || right.greetings - left.greetings,
  )
  const result: Array<{ phrase: string; greetings: number }> = []
  for (const item of ordered) {
    if (result.some((kept) => keyOf(kept.phrase).includes(keyOf(item.phrase)))) continue
    result.push(item)
  }
  return result.slice(0, maxAvoidPhrases)
}

/** 每条事实在最近招呼语里被引用的次数。 */
export function countFactUsage(greetings: ReadonlyArray<{ usedFactIds: readonly string[] }>) {
  const usage: Record<string, number> = {}
  for (const greeting of greetings) {
    for (const id of new Set(greeting.usedFactIds)) usage[id] = (usage[id] ?? 0) + 1
  }
  return usage
}

/** 草稿里命中的「近期用多了」的长句。忽略大小写和空白。 */
export function findReusedPhrases(messages: readonly string[], avoidPhrases: readonly string[]) {
  const body = keyOf(messages.join('').replace(/\s+/gu, ''))
  return avoidPhrases.filter((phrase) => {
    const key = keyOf(phrase.replace(/\s+/gu, ''))
    return key.length >= phraseLength && body.includes(key)
  })
}

export function findStockPhrases(messages: readonly string[]) {
  const text = messages.join('')
  return STOCK_PHRASE_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label)
}

export function hasSelfDeprecation(messages: readonly string[]) {
  const text = messages.join('')
  return SELF_DEPRECATION_PATTERNS.some((pattern) => pattern.test(text))
}

/** JD 摘录是否真的出自这份 JD；至少 6 个字，防止只摘一个「负责」就算锚定。 */
export const MIN_JD_QUOTE_LENGTH = 6

/** 标点和空白不算差异：模型摘录时常把换行、分号换成逗号。字要一个不差。 */
const quoteKey = (text: string) => normalizeResumeText(text).replace(/[\p{P}\p{S}\s]+/gu, '')

export function jdQuoteAppears(jobDescription: string, quote: string) {
  const key = quoteKey(quote)
  return key.length >= MIN_JD_QUOTE_LENGTH && quoteKey(jobDescription).includes(key)
}

/**
 * 草稿和最近某一条招呼语的最大重合度：草稿的 8 字片段里，有多少出现在同一条旧招呼语中。
 * 同一条事实的数字句（约 15 字）只占 220 字招呼语的 5% 左右；到 30% 就是整段照搬了。
 */
export const MAX_GREETING_OVERLAP = 0.3

export function maxOverlapWithRecent(
  messages: readonly string[],
  recent: ReadonlyArray<readonly string[]>,
) {
  const draftGrams = greetingGrams(messages)
  if (draftGrams.size === 0) return 0
  let max = 0
  for (const previous of recent) {
    const previousGrams = greetingGrams(previous)
    let shared = 0
    for (const gram of draftGrams) if (previousGrams.has(gram)) shared += 1
    max = Math.max(max, shared / draftGrams.size)
  }
  return max
}

export interface GreetingDiversityContext {
  /** 只列被引用过的事实；没出现的就是最近没用过。 */
  recentFactUses: Record<string, number>
  avoidPhrases: string[]
}

export function buildGreetingDiversityContext(
  recent: ReadonlyArray<{ messages: readonly string[]; usedFactIds: readonly string[] }>,
): GreetingDiversityContext {
  return {
    recentFactUses: countFactUsage(recent),
    avoidPhrases: findRepeatedPhrases(recent.map((greeting) => greeting.messages)).map(
      (item) => item.phrase,
    ),
  }
}
