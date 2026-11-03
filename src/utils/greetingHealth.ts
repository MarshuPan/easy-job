import type { GreetingAnchor, GreetingAudit, GreetingReview } from '@/types/aiGreeting'
import {
  countFactUsage,
  findRepeatedPhrases,
  findStockPhrases,
  hasSelfDeprecation,
  MAX_GREETING_OVERLAP,
  maxOverlapWithRecent,
  OVERUSED_FACT_MIN_COUNT,
} from '@/utils/greetingDiversity'

export interface GreetingHealthInput {
  sentAt: number
  messages: string[]
  usedFactIds: string[]
  segmentFactIds?: string[][]
  anchor?: GreetingAnchor
  review?: GreetingReview
  audit?: GreetingAudit
}

/** 生成时每条和前面这么多条比，与生成链路看到的近期窗口一致。 */
const recentWindow = 10

function countCodes(codes: readonly string[]) {
  const counts: Record<string, number> = {}
  for (const code of codes) counts[code] = (counts[code] ?? 0) + 1
  return counts
}

const percent = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0)

/**
 * 一批招呼语的体检：事实分布是否均匀、套话和免责出现多少、和近期的雷同程度、
 * JD 摘录命中多少、篇幅。用来判断改动有没有效果，而不是一条条读完靠感觉。
 * 口径与生成时的检查一致（greetingDiversity）。
 */
export function buildGreetingHealth(input: readonly GreetingHealthInput[]) {
  const greetings = [...input].sort((left, right) => left.sentAt - right.sentAt)
  const count = greetings.length
  if (count === 0) return null

  const lengths = greetings.map((greeting) => greeting.messages.join('').length)
  const usage = countFactUsage(greetings)
  const topFacts = Object.entries(usage)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([id, used]) => ({ id, greetings: used, share: percent(used, count) }))
  // 滑动窗口内用得过多的事实：生成时模型看到的就是这个窗口。
  const overusedAtSend = greetings.filter((greeting, index) => {
    const window = countFactUsage(greetings.slice(Math.max(0, index - recentWindow), index))
    return greeting.usedFactIds.some((id) => (window[id] ?? 0) >= OVERUSED_FACT_MIN_COUNT)
  }).length
  const tooSimilar = greetings.filter(
    (greeting, index) =>
      maxOverlapWithRecent(
        greeting.messages,
        greetings.slice(Math.max(0, index - recentWindow), index).map((item) => item.messages),
      ) >= MAX_GREETING_OVERLAP,
  ).length
  const reviewed = greetings.filter((greeting) => greeting.review)
  const audited = greetings.filter((greeting) => greeting.audit)
  const audits = audited.map((greeting) => greeting.audit!)

  return {
    count,
    length: {
      average: Math.round(lengths.reduce((sum, value) => sum + value, 0) / count),
      min: Math.min(...lengths),
      max: Math.max(...lengths),
    },
    facts: {
      distinct: Object.keys(usage).length,
      top: topFacts,
      /** 用到了近 10 条里已用过 3 次以上事实的招呼语占比。 */
      overusedRate: percent(overusedAtSend, count),
    },
    /** 在 3 条及以上招呼语里出现的长句。 */
    repeatedPhrases: findRepeatedPhrases(greetings.map((greeting) => greeting.messages)),
    stockPhraseRate: percent(
      greetings.filter((greeting) => findStockPhrases(greeting.messages).length > 0).length,
      count,
    ),
    selfDeprecationRate: percent(
      greetings.filter((greeting) => hasSelfDeprecation(greeting.messages)).length,
      count,
    ),
    tooSimilarRate: percent(tooSimilar, count),
    /** 以下三项只统计带复核结果的招呼语（1.3.17 起生成的）。 */
    reviewed: reviewed.length,
    jdQuoteFoundRate: percent(
      reviewed.filter((greeting) => greeting.review!.jdQuoteFound).length,
      reviewed.length,
    ),
    rewrittenRate: percent(
      reviewed.filter((greeting) => greeting.review!.attempts > 1).length,
      reviewed.length,
    ),
    sentWithStyleIssuesRate: percent(
      reviewed.filter((greeting) => greeting.review!.styleIssues.length > 0).length,
      reviewed.length,
    ),
    /** 各项检查触发了几次重写：重写率高时看是哪一项带来的。 */
    rewriteReasons: countCodes(
      reviewed.flatMap((greeting) => greeting.review!.rewriteReasons ?? []),
    ),
    /** 重写后仍带着发出去的风格问题。 */
    styleIssues: countCodes(reviewed.flatMap((greeting) => greeting.review!.styleIssues)),
    /** 三方核对要求：JD 锚点、分段事实映射和主张边界都通过，且记录了证据版本。 */
    audited: audited.length,
    triadCompleteRate: percent(
      audits.filter(
        (audit) =>
          audit.jdQuoteFound &&
          audit.greetingUsedFactIdsValid &&
          audit.segmentFactMappingComplete &&
          audit.claimBoundaryValid &&
          audit.resumeEvidenceMatches === true,
      ).length,
      audited.length,
    ),
    jdAnchorHitRate: percent(audits.filter((audit) => audit.jdQuoteFound).length, audited.length),
    factMappingCompleteRate: percent(
      audits.filter((audit) => audit.segmentFactMappingComplete).length,
      audited.length,
    ),
    evidenceVersionMatchRate: percent(
      audits.filter((audit) => audit.resumeEvidenceMatches === true).length,
      audited.length,
    ),
    claimBoundaryPassRate: percent(
      audits.filter((audit) => audit.claimBoundaryValid).length,
      audited.length,
    ),
  }
}
