import type {
  ClaimPolicy,
  GreetingDraft,
  GreetingFilteringContext,
  GreetingLengthConfig,
  SelectedGreetingFact,
} from '@/types/aiGreeting'

export type GreetingQualityCode =
  | 'SCHEMA_INVALID'
  | 'MESSAGE_COUNT'
  | 'MESSAGE_EMPTY'
  | 'MESSAGE_TOO_LONG'
  | 'TOTAL_TOO_SHORT'
  | 'TOTAL_TOO_LONG'
  | 'FACT_NOT_ALLOWED'
  | 'CLAIM_MODE_MISMATCH'
  | 'THIRD_PERSON_SELF_REFERENCE'
  | 'FORBIDDEN_CLAIM'

export interface GreetingQualityIssue {
  code: GreetingQualityCode
  message: string
  messageIndex?: number
}

interface ValidateGreetingDraftArgs {
  candidateName?: string
  draft: GreetingDraft
  filtering?: GreetingFilteringContext
  selectedFacts: SelectedGreetingFact[]
  claimPolicy: ClaimPolicy
  length?: GreetingLengthConfig
}

const controlledClaimVerbs = [
  '主导',
  '负责',
  '牵头',
  '搭建',
  '落地',
  '参与',
  '使用',
  '熟悉',
  '做过',
]
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
    typeof (draft as GreetingDraft).claimMode !== 'string' ||
    typeof (draft as GreetingDraft).openingPattern !== 'string'
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
      issue(issues, 'MESSAGE_EMPTY', `第${messageIndex + 1}条消息为空`, messageIndex)
      return
    }
  })

  const stringMessages = messages.filter(
    (message): message is string => typeof message === 'string',
  )

  stringMessages.forEach((message, messageIndex) => {
    if (hasThirdPersonSelfReference(message, args.candidateName)) {
      issue(
        issues,
        'THIRD_PERSON_SELF_REFERENCE',
        `第${messageIndex + 1}条使用第三人称描述候选人本人`,
        messageIndex,
      )
    }
  })

  const allowedFactIds = new Set(args.selectedFacts.map((fact) => fact.id))
  if (
    typedDraft.usedFactIds.length === 0 ||
    typedDraft.usedFactIds.some((factId) => !allowedFactIds.has(factId))
  ) {
    issue(issues, 'FACT_NOT_ALLOWED', 'AI招呼语使用了筛选范围外的事实')
  }

  const usedFacts = args.selectedFacts.filter((fact) => typedDraft.usedFactIds.includes(fact.id))
  // claimMode 由「实际用于写作的事实」决定（契约 §4.2）。
  //
  // 这里曾经额外要求它等于匹配阶段的 claimMode，但两者的输入集合本来就不同：
  // 匹配阶段对**选中的全部事实**推导，招呼语对**实际使用的子集**推导。当匹配选出
  // direct 与 adjacent 混合的事实、而招呼语只引用了其中的 direct 事实时，前者是
  // 'adjacent'、后者是 'direct'，于是必然判为不一致——且模型只有把所有事实都写进去
  // 才可能通过，两次重试都会失败，最终表现为「已建立沟通但招呼语发不出去」。
  //
  // 安全边界由另外两条保证：usedFactIds 必须是选中事实的子集（FACT_NOT_ALLOWED），
  // 且草稿声明的 claimMode 必须精确匹配它自己用的事实。用子集写作只会让声明更保守，
  // 不会夸大候选人的经历。
  const expectedClaimMode =
    usedFacts.length > 0 && usedFacts.every((fact) => fact.evidenceType === 'direct_fact')
      ? 'direct'
      : 'adjacent'
  if (typedDraft.claimMode !== expectedClaimMode) {
    issue(issues, 'CLAIM_MODE_MISMATCH', '声明模式与事实边界不一致')
  }

  stringMessages.forEach((message, messageIndex) => {
    for (const forbiddenClaim of args.claimPolicy.forbiddenClaims) {
      if (forbiddenClaim && includesPhrase(message, forbiddenClaim)) {
        issue(issues, 'FORBIDDEN_CLAIM', `第${messageIndex + 1}条包含禁用主张`, messageIndex)
      }
    }
  })

  const allowedClaimVerbs = new Set(usedFacts.flatMap((fact) => fact.allowedClaimVerbs))
  stringMessages.forEach((message, messageIndex) => {
    for (const verb of controlledClaimVerbs) {
      if (includesPhrase(message, verb) && !allowedClaimVerbs.has(verb)) {
        issue(
          issues,
          'FORBIDDEN_CLAIM',
          `第${messageIndex + 1}条使用了事实未授权的主张动词: ${verb}`,
          messageIndex,
        )
      }
    }
  })

  if (typedDraft.claimMode === 'adjacent') {
    stringMessages.forEach((message, messageIndex) => {
      const hasAdjacentPhrase = args.claimPolicy.adjacentOnly.some(
        (phrase) => phrase && includesPhrase(message, phrase),
      )
      const claimsDirectOwnership = directOwnershipVerbs.some((verb) =>
        includesPhrase(message, verb),
      )
      if (hasAdjacentPhrase && claimsDirectOwnership) {
        issue(
          issues,
          'FORBIDDEN_CLAIM',
          `第${messageIndex + 1}条把相邻经验表述为直接经验`,
          messageIndex,
        )
      }
    })
  }

  return issues
}
