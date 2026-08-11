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
  ownership: 'led' | 'owned' | 'contributed' | 'used' | 'learned'
  metrics?: ResumeMetric[]
  domains: string[]
  skills: string[]
  evidenceType: EvidenceType
  allowedClaimVerbs: string[]
  confidence: 'high' | 'medium' | 'low'
}

export interface EvidenceBucket {
  id: string
  signals: Array<{ value: string; weight: number }>
  factIds: string[]
}

export interface ClaimPolicy {
  adjacentOnly: string[]
  forbiddenClaims: string[]
}

export interface ResumeEvidence {
  name?: string
  target?: Record<string, unknown>
  facts: ResumeFact[]
  buckets: EvidenceBucket[]
  claimPolicy: ClaimPolicy
}

export type SelectedGreetingFact = Omit<ResumeFact, 'sourceQuote'>

export interface RecentGreetingSummary {
  sentAt: number
  usedFactIds: string[]
  openingPattern: string
  messages: string[]
  fingerprint: string
}

export interface GreetingDraft {
  messages: string[]
  usedFactIds: string[]
  claimMode: ClaimMode
  openingPattern: string
}

export interface AiGreetingMeta {
  usedFactIds: string[]
  claimMode: ClaimMode
  openingPattern: string
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
