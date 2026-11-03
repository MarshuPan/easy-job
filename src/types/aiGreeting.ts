export type MatchLevel = 'strong' | 'good' | 'maybe' | 'weak' | 'reject'
export type ClaimMode = 'adjacent' | 'direct'
export type EvidenceType = 'direct_fact' | 'self_claim' | 'derived_capability' | 'adjacent_only'

export interface FilteringDecision {
  matchPercent: number
  level: MatchLevel
  reason: string
  risk?: string
  selectedFactIds: string[]
}

export interface GreetingFilteringContext extends FilteringDecision {
  claimMode: ClaimMode
}

export interface ResumeMetric {
  name: string
  value: string
  period?: string
}

export interface ResumeFact {
  id: string
  sourceQuote: string
  company?: string
  role?: string
  start?: string
  end?: string
  action: string
  object: string
  metrics?: ResumeMetric[]
  evidenceType: EvidenceType
  allowedClaimVerbs: string[]
}

export interface ClaimPolicy {
  adjacentOnly: string[]
  forbiddenClaims: string[]
}

export interface ResumeEvidence {
  name?: string
  target?: Record<string, unknown>
  facts: ResumeFact[]
  claimPolicy: ClaimPolicy
}

export type SelectedGreetingFact = Omit<ResumeFact, 'sourceQuote'>

export interface RecentGreetingSummary {
  sentAt: number
  usedFactIds: string[]
  messages: string[]
  fingerprint: string
}

/**
 * 这条招呼语对准的 JD 需求：先写出这份 JD 最核心的一个需求，并原文摘一句作依据，
 * 身份、项目和价值都围绕它来写。JD 是招呼语里唯一每次都不一样的输入，
 * 不先对准它，模型就会退回到一套和岗位无关的固定自我介绍。
 */
export interface GreetingAnchor {
  need: string
  jdQuote: string
}

/** 代码对最终稿的复核结果，存进记录供体检统计。 */
export interface GreetingReview {
  /** jdQuote 是否确实出自这份 JD。 */
  jdQuoteFound: boolean
  /** 重试后仍未解决、但不涉及事实边界而放行的风格问题。 */
  styleIssues: string[]
  /** 生成了几次才得到这一稿。 */
  attempts: number
  /** 触发重写的问题：看重写率是哪项检查带来的。 */
  rewriteReasons?: string[]
}

/** 每个发送分段实际引用的事实，供 JD / 话术 / 简历事实逐段核对。 */
export interface GreetingSegmentAudit {
  messageIndex: number
  factIds: string[]
  factIdsValid: boolean
  claimBoundaryValid: boolean
  claimIssueCodes: string[]
}

/**
 * 招呼语生成后的结构化审计结果。只保存 ID、分数和校验状态，不保存简历原文或完整 JD，
 * 便于把回复效果和岗位匹配、事实引用、主张边界放在同一条记录里复盘。
 */
export interface GreetingAudit {
  matchEnabled: boolean
  matchPercent?: number
  matchThreshold?: number
  matchSelectedFactIds: string[]
  matchSelectedFactIdsValid: boolean
  greetingUsedFactIds: string[]
  greetingUsedFactIdsValid: boolean
  greetingFactIdsInMatch: string[]
  /** 仅兼容旧版审计，不再作为当前通过条件。 */
  maxFacts?: number
  factCountWithinLimit?: boolean
  segmentFactMappingComplete: boolean
  segmentAudits: GreetingSegmentAudit[]
  jdQuoteFound: boolean
  claimMode: ClaimMode
  claimBoundaryValid: boolean
  claimIssueCodes: string[]
  qualityIssueCodes: string[]
  resumeEvidenceVersion?: number
  resumeSourceHash?: string
  resumeEvidenceMatches?: boolean
}

/**
 * 招呼语草稿不带 claimMode：措辞能不能说成「做过」，由事实本身的 evidenceType 和
 * allowedClaimVerbs 决定，质量检查直接按这两项查；让模型再自报一遍只会多一个出错点。
 */
export interface GreetingDraft {
  promptFingerprint?: string
  anchor: GreetingAnchor
  messages: string[]
  usedFactIds: string[]
  /** 与 messages 一一对应，完整列出每段实际引用的事实 ID。 */
  segmentFactIds: string[][]
  resumeEvidenceVersion?: number
  resumeSourceHash?: string
  review?: GreetingReview
  audit?: GreetingAudit
}

export interface AiGreetingMeta {
  promptFingerprint?: string
  usedFactIds: string[]
  segmentFactIds?: string[][]
  resumeEvidenceVersion?: number
  resumeSourceHash?: string
  anchor?: GreetingAnchor
  review?: GreetingReview
  audit?: GreetingAudit
  fingerprint: string
}

export interface GreetingRegenerationContext {
  draft?: GreetingDraft
  issues: Array<{ code: string; message: string; messageIndex?: number }>
}

export interface GreetingLengthConfig {
  messageCount: number
  minTotalCharacters: number
  maxTotalCharacters: number
}
