import { CONTROLLED_CLAIM_VERBS } from '@/profile/resumeEvidenceRules'
import type {
  ClaimPolicy,
  GreetingDraft,
  GreetingLengthConfig,
  SelectedGreetingFact,
} from '@/types/aiGreeting'
import {
  findReusedPhrases,
  findStockPhrases,
  hasSelfDeprecation,
  jdQuoteAppears,
  MAX_GREETING_OVERLAP,
  maxOverlapWithRecent,
} from '@/utils/greetingDiversity'

export type GreetingQualityCode =
  | 'SCHEMA_INVALID'
  | 'MESSAGE_COUNT'
  | 'MESSAGE_EMPTY'
  | 'FACT_NOT_ALLOWED'
  | 'THIRD_PERSON_SELF_REFERENCE'
  | 'FORBIDDEN_CLAIM'
  | 'JD_QUOTE_NOT_FOUND'
  | 'SELF_DEPRECATION'
  | 'STOCK_PHRASE'
  | 'REUSED_PHRASE'
  | 'TOO_SIMILAR'
  | 'SEGMENT_FACT_MAPPING'

/**
 * 风格问题：会带着问题重写一次，重写后还在也照发，并记进体检。
 * 其余问题涉及结构或事实边界，重写后还在就不发。风格问题不值得为它丢掉一个岗位——
 * 列表每刷新一次都很珍贵，岗位凭据半小时就过期。
 */
export const STYLE_ISSUE_CODES: ReadonlySet<GreetingQualityCode> = new Set([
  'JD_QUOTE_NOT_FOUND',
  'SELF_DEPRECATION',
  'STOCK_PHRASE',
  'REUSED_PHRASE',
  'TOO_SIMILAR',
])

export const STYLE_ISSUE_LABELS: Readonly<Record<string, string>> = {
  JD_QUOTE_NOT_FOUND: 'JD 摘录对不上',
  SELF_DEPRECATION: '主动免责',
  STOCK_PHRASE: '套话',
  REUSED_PHRASE: '重复近期句子',
  TOO_SIMILAR: '与近期招呼语雷同',
}

export interface GreetingQualityIssue {
  code: GreetingQualityCode
  message: string
  messageIndex?: number
}

interface ValidateGreetingDraftArgs {
  candidateName?: string
  draft: GreetingDraft
  selectedFacts: SelectedGreetingFact[]
  claimPolicy: ClaimPolicy
  length?: GreetingLengthConfig
  /** 岗位名、JD 正文、标签拼成的文本，用来核对 anchor.jdQuote。为空时不核对。 */
  jobText?: string
  /** 近期被多条招呼语共用的长句。 */
  avoidPhrases?: readonly string[]
  /** 近期招呼语正文，用来判断整段是否照搬。 */
  recentMessages?: ReadonlyArray<readonly string[]>
}

const directOwnershipVerbs = ['主导', '负责', '牵头', '搭建', '做过', '落地过']

function includesPhrase(value: string, phrase: string) {
  return value.toLocaleLowerCase().includes(phrase.toLocaleLowerCase())
}

const thirdPersonCandidateSubject =
  /(?:该?候选人|他|她)[^。！？\n]{0,16}(?:是|曾|目前|担任|负责|主导|牵头|参与|拥有|具备|熟悉|使用|希望|期待|能够|可以)/

function hasThirdPersonSelfReference(value: string, candidateName?: string) {
  if (thirdPersonCandidateSubject.test(value)) return true
  const name = candidateName?.trim()
  if (!name) return false
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const namedSubject = new RegExp(
    `(?:^|[。！？\\n，,；;])\\s*${escapedName}[^。！？\\n]{0,12}(?:曾|目前|担任|负责|主导|牵头|参与|拥有|具备|熟悉|使用|希望|期待|能够|可以)`,
  )
  return namedSubject.test(value)
}

function issue(
  issues: GreetingQualityIssue[],
  code: GreetingQualityCode,
  message: string,
  messageIndex?: number,
) {
  issues.push({ code, message, messageIndex })
}

export function validateGreetingDraft(args: ValidateGreetingDraftArgs): GreetingQualityIssue[] {
  const draft = args?.draft as unknown
  if (
    typeof draft !== 'object' ||
    draft == null ||
    !Array.isArray((draft as GreetingDraft).messages) ||
    !Array.isArray((draft as GreetingDraft).usedFactIds) ||
    typeof (draft as GreetingDraft).anchor !== 'object' ||
    (draft as GreetingDraft).anchor == null
  ) {
    return [{ code: 'SCHEMA_INVALID', message: 'AI招呼语草稿结构不合法' }]
  }

  const typedDraft = draft as GreetingDraft
  const issues: GreetingQualityIssue[] = []
  const messages = typedDraft.messages as unknown[]
  const length = args.length ?? {
    messageCount: 3,
    minTotalCharacters: 120,
    maxTotalCharacters: 180,
  }

  if (messages.length !== length.messageCount) {
    issue(issues, 'MESSAGE_COUNT', `AI招呼语必须包含${length.messageCount}条消息`)
  }

  messages.forEach((message, messageIndex) => {
    if (typeof message !== 'string' || message.trim().length === 0) {
      issue(issues, 'MESSAGE_EMPTY', `第${messageIndex + 1}条消息为空`, messageIndex + 1)
      return
    }
  })

  const stringMessages = messages.filter(
    (message): message is string => typeof message === 'string',
  )
  const stringMessagesWithIndex = messages.flatMap((message, messageIndex) =>
    typeof message === 'string' ? [{ message, messageIndex }] : [],
  )

  stringMessagesWithIndex.forEach(({ message, messageIndex }) => {
    if (hasThirdPersonSelfReference(message, args.candidateName)) {
      issue(
        issues,
        'THIRD_PERSON_SELF_REFERENCE',
        `第${messageIndex + 1}条使用第三人称描述候选人本人`,
        messageIndex + 1,
      )
    }
  })

  const allowedFactIds = new Set(args.selectedFacts.map((fact) => fact.id))
  if (
    typedDraft.usedFactIds.length === 0 ||
    new Set(typedDraft.usedFactIds).size !== typedDraft.usedFactIds.length ||
    typedDraft.usedFactIds.some((factId) => !allowedFactIds.has(factId))
  ) {
    issue(issues, 'FACT_NOT_ALLOWED', 'AI招呼语使用了筛选范围外的事实')
  }

  const segmentFactIds = typedDraft.segmentFactIds
  const segmentMappingValid =
    Array.isArray(segmentFactIds) &&
    segmentFactIds.length === messages.length &&
    segmentFactIds.every(
      (ids) =>
        Array.isArray(ids) &&
        new Set(ids).size === ids.length &&
        ids.every((factId) => allowedFactIds.has(factId)),
    )
  const mappedFactIds = new Set(segmentMappingValid ? segmentFactIds.flat() : [])
  if (
    !segmentMappingValid ||
    mappedFactIds.size !== typedDraft.usedFactIds.length ||
    typedDraft.usedFactIds.some((factId) => !mappedFactIds.has(factId))
  ) {
    issue(issues, 'SEGMENT_FACT_MAPPING', '招呼语分段事实映射必须覆盖且仅覆盖正文实际引用的事实')
  }

  const usedFacts = args.selectedFacts.filter((fact) => typedDraft.usedFactIds.includes(fact.id))
  // 措辞越界由下面的受控动词检查和相邻经验检查负责，依据是事实本身，不看模型自报什么。

  stringMessagesWithIndex.forEach(({ message, messageIndex }) => {
    for (const forbiddenClaim of args.claimPolicy.forbiddenClaims) {
      if (forbiddenClaim && includesPhrase(message, forbiddenClaim)) {
        issue(issues, 'FORBIDDEN_CLAIM', `第${messageIndex + 1}条包含禁用主张`, messageIndex + 1)
      }
    }
  })

  const allowedClaimVerbs = new Set(usedFacts.flatMap((fact) => fact.allowedClaimVerbs))
  stringMessagesWithIndex.forEach(({ message, messageIndex }) => {
    for (const verb of CONTROLLED_CLAIM_VERBS) {
      if (includesPhrase(message, verb) && !allowedClaimVerbs.has(verb)) {
        issue(
          issues,
          'FORBIDDEN_CLAIM',
          `第${messageIndex + 1}条使用了事实未授权的主张动词: ${verb}`,
          messageIndex + 1,
        )
      }
    }
  })

  // 仅相邻的主题不论本次引用了什么事实，都不能被说成直接负责过。
  //
  // 按分句查，不按整条消息查：招呼语第一句就要点出 JD 的核心职责，JD 里的「RAG」「模型评测」
  // 和自己事实里的「负责过」经常落在同一条消息的不同分句里。那是在说岗位要什么、我做过什么，
  // 不是把相邻经验说成亲手做过；同一分句里同时出现才是。
  stringMessagesWithIndex.forEach(({ message, messageIndex }) => {
    const claimsAdjacentAsDirect = message
      .split(/[，,。；;！!？?\n]/u)
      .some(
        (clause) =>
          args.claimPolicy.adjacentOnly.some(
            (phrase) => phrase && includesPhrase(clause, phrase),
          ) && directOwnershipVerbs.some((verb) => includesPhrase(clause, verb)),
      )
    if (claimsAdjacentAsDirect) {
      issue(
        issues,
        'FORBIDDEN_CLAIM',
        `第${messageIndex + 1}条把相邻经验表述为直接经验`,
        messageIndex + 1,
      )
    }
  })

  checkStyle(issues, typedDraft, stringMessages, args)

  return issues
}

function checkStyle(
  issues: GreetingQualityIssue[],
  draft: GreetingDraft,
  messages: string[],
  args: ValidateGreetingDraftArgs,
) {
  if (args.jobText?.trim() && !jdQuoteAppears(args.jobText, draft.anchor.jdQuote)) {
    issue(
      issues,
      'JD_QUOTE_NOT_FOUND',
      'anchor.jdQuote 在岗位原文中找不到，需逐字摘录 JD 里的一句或一个短语，并据此调整正文',
    )
  }
  if (hasSelfDeprecation(messages)) {
    issue(
      issues,
      'SELF_DEPRECATION',
      '不要主动说明自己没做过什么、经历偏哪一侧；只写做过的、能回应需求的事',
    )
  }
  const stock = findStockPhrases(messages)
  if (stock.length > 0) {
    issue(issues, 'STOCK_PHRASE', `去掉模板化说法：${stock.join('、')}`)
  }
  const reused = findReusedPhrases(messages, args.avoidPhrases ?? [])
  if (reused.length > 0) {
    issue(
      issues,
      'REUSED_PHRASE',
      `以下句子最近已在多条招呼语里用过，换角度讲或改用另一条事实：${reused.join('；')}`,
    )
  }
  if (maxOverlapWithRecent(messages, args.recentMessages ?? []) >= MAX_GREETING_OVERLAP) {
    issue(issues, 'TOO_SIMILAR', '与最近某条招呼语大段相同，换一个项目或切入角度重写')
  }
}
