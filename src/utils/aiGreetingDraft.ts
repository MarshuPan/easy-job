import type {
  ClaimMode,
  FilteringDecision,
  GreetingAnchor,
  GreetingAudit,
  GreetingDraft,
  GreetingReview,
  MatchLevel,
  ResumeFact,
} from '@/types/aiGreeting'
import { GreetError } from '@/types/deliverError'
import { parseGptJson } from '@/utils/parse'

export function deriveClaimModeFromFacts(
  facts: Array<Pick<ResumeFact, 'evidenceType'>>,
): ClaimMode {
  return facts.length > 0 && facts.every((fact) => fact.evidenceType === 'direct_fact')
    ? 'direct'
    : 'adjacent'
}

const matchLevels = new Set<MatchLevel>(['strong', 'good', 'maybe', 'weak', 'reject'])

function deriveMatchLevel(score: number): MatchLevel {
  if (score >= 85) return 'strong'
  if (score >= 70) return 'good'
  if (score >= 55) return 'maybe'
  if (score >= 40) return 'weak'
  return 'reject'
}

function normalizeFactIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const trimmed = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return [...new Set(trimmed)]
}

export function parseFilteringDecisionContent(content: string, minScore: number) {
  const parsed = parseGptJson<
    Partial<FilteringDecision> & { claimMode?: unknown; pass?: boolean | string }
  >(content)
  const score = Number(parsed?.matchPercent)
  if (!Number.isFinite(score)) return null
  const matchPercent = Math.max(0, Math.min(100, Math.round(score)))
  const selectedFactIds = normalizeFactIds(parsed?.selectedFactIds)
  const passed = matchPercent >= minScore
  if (passed && selectedFactIds.length === 0) return null
  const level = matchLevels.has(parsed?.level as MatchLevel)
    ? (parsed?.level as MatchLevel)
    : deriveMatchLevel(matchPercent)
  const modelPass =
    typeof parsed?.pass === 'boolean'
      ? parsed.pass
      : typeof parsed?.pass === 'string'
        ? parsed.pass.toLowerCase() === 'true'
        : undefined
  return {
    passed,
    modelPass,
    decision: {
      matchPercent,
      level,
      reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
      risk: typeof parsed?.risk === 'string' ? parsed.risk : undefined,
      selectedFactIds,
      ...(parsed?.claimMode === 'adjacent' || parsed?.claimMode === 'direct'
        ? { claimMode: parsed.claimMode }
        : {}),
    } satisfies FilteringDecision,
  }
}

function parseAnchor(value: unknown): GreetingAnchor | null {
  if (typeof value !== 'object' || value == null) return null
  const { need, jdQuote } = value as Record<string, unknown>
  if (typeof need !== 'string' || typeof jdQuote !== 'string') return null
  if (need.trim().length === 0 || jdQuote.trim().length === 0) return null
  // The anchor is evidence used to compare the JD with the sent greeting.
  // Keep the model's complete text; display layers can shorten it when needed.
  return { need: need.trim(), jdQuote: jdQuote.trim() }
}

function parseSegmentFactIds(value: unknown, messageCount: number) {
  if (!Array.isArray(value) || value.length !== messageCount) return null
  const segments = value.map((segment) => {
    if (!Array.isArray(segment)) return null
    const ids = normalizeFactIds(segment)
    return ids.length === segment.length ? ids : null
  })
  if (segments.some((segment) => segment == null)) return null
  return segments as string[][]
}

function parseReview(value: unknown): GreetingReview | undefined {
  if (typeof value !== 'object' || value == null) return undefined
  const { jdQuoteFound, styleIssues, attempts, rewriteReasons } = value as Record<string, unknown>
  if (
    typeof jdQuoteFound !== 'boolean' ||
    !Array.isArray(styleIssues) ||
    !styleIssues.every((item) => typeof item === 'string') ||
    !Number.isInteger(attempts)
  ) {
    return undefined
  }
  const reasons =
    Array.isArray(rewriteReasons) && rewriteReasons.every((item) => typeof item === 'string')
      ? rewriteReasons
      : []
  return {
    jdQuoteFound,
    styleIssues,
    attempts: attempts as number,
    ...(reasons.length > 0 ? { rewriteReasons: reasons } : {}),
  }
}

function parseAudit(value: unknown): GreetingAudit | undefined {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const stringList = (item: unknown) =>
    Array.isArray(item) && item.every((entry) => typeof entry === 'string') ? item : null
  const matchSelectedFactIds = stringList(source.matchSelectedFactIds)
  const greetingUsedFactIds = stringList(source.greetingUsedFactIds)
  const greetingFactIdsInMatch = stringList(source.greetingFactIdsInMatch)
  const claimIssueCodes = stringList(source.claimIssueCodes)
  const qualityIssueCodes = stringList(source.qualityIssueCodes)
  const segmentAudits = Array.isArray(source.segmentAudits)
    ? source.segmentAudits.flatMap((item) => {
        if (typeof item !== 'object' || item == null || Array.isArray(item)) return []
        const segment = item as Record<string, unknown>
        const factIds = stringList(segment.factIds)
        const segmentClaimIssueCodes = stringList(segment.claimIssueCodes)
        if (
          !Number.isInteger(segment.messageIndex) ||
          (segment.messageIndex as number) < 1 ||
          factIds == null ||
          typeof segment.factIdsValid !== 'boolean' ||
          typeof segment.claimBoundaryValid !== 'boolean' ||
          segmentClaimIssueCodes == null
        ) {
          return []
        }
        return [
          {
            messageIndex: segment.messageIndex as number,
            factIds,
            factIdsValid: segment.factIdsValid,
            claimBoundaryValid: segment.claimBoundaryValid,
            claimIssueCodes: segmentClaimIssueCodes,
          },
        ]
      })
    : null
  if (
    typeof source.matchEnabled !== 'boolean' ||
    typeof source.matchSelectedFactIdsValid !== 'boolean' ||
    typeof source.greetingUsedFactIdsValid !== 'boolean' ||
    typeof source.jdQuoteFound !== 'boolean' ||
    (source.claimMode !== 'adjacent' && source.claimMode !== 'direct') ||
    typeof source.claimBoundaryValid !== 'boolean' ||
    matchSelectedFactIds == null ||
    greetingUsedFactIds == null ||
    greetingFactIdsInMatch == null ||
    claimIssueCodes == null ||
    qualityIssueCodes == null ||
    typeof source.segmentFactMappingComplete !== 'boolean' ||
    segmentAudits == null
  ) {
    return undefined
  }
  const matchPercent =
    typeof source.matchPercent === 'number' && Number.isFinite(source.matchPercent)
      ? source.matchPercent
      : undefined
  const matchThreshold =
    typeof source.matchThreshold === 'number' && Number.isFinite(source.matchThreshold)
      ? source.matchThreshold
      : undefined
  const resumeEvidenceVersion =
    Number.isInteger(source.resumeEvidenceVersion) && (source.resumeEvidenceVersion as number) > 0
      ? (source.resumeEvidenceVersion as number)
      : undefined
  const resumeSourceHash =
    typeof source.resumeSourceHash === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(source.resumeSourceHash)
      ? source.resumeSourceHash
      : undefined
  return {
    matchEnabled: source.matchEnabled,
    ...(matchPercent == null ? {} : { matchPercent }),
    ...(matchThreshold == null ? {} : { matchThreshold }),
    matchSelectedFactIds,
    matchSelectedFactIdsValid: source.matchSelectedFactIdsValid,
    greetingUsedFactIds,
    greetingUsedFactIdsValid: source.greetingUsedFactIdsValid,
    greetingFactIdsInMatch,
    ...(typeof source.maxFacts === 'number' ? { maxFacts: source.maxFacts } : {}),
    ...(typeof source.factCountWithinLimit === 'boolean'
      ? { factCountWithinLimit: source.factCountWithinLimit }
      : {}),
    segmentFactMappingComplete: source.segmentFactMappingComplete,
    segmentAudits,
    jdQuoteFound: source.jdQuoteFound,
    claimMode: source.claimMode,
    claimBoundaryValid: source.claimBoundaryValid,
    claimIssueCodes,
    qualityIssueCodes,
    ...(resumeEvidenceVersion == null ? {} : { resumeEvidenceVersion }),
    ...(resumeSourceHash == null ? {} : { resumeSourceHash }),
    ...(typeof source.resumeEvidenceMatches === 'boolean'
      ? { resumeEvidenceMatches: source.resumeEvidenceMatches }
      : {}),
  }
}

export function parseGreetingDraft(content: string, messageCount = 3): GreetingDraft {
  const parsed = parseGptJson<Record<string, unknown>>(content)
  const messages = Array.isArray(parsed?.messages)
    ? parsed.messages.map((item) => (typeof item === 'string' ? item.trim() : ''))
    : []
  if (messages.length !== messageCount || messages.some((item) => item.length === 0)) {
    throw new GreetError(`AI招呼语必须包含${messageCount}条消息`)
  }

  const usedFactIds = normalizeFactIds(parsed?.usedFactIds)
  const anchor = parseAnchor(parsed?.anchor)
  const segmentFactIds = parseSegmentFactIds(parsed?.segmentFactIds, messageCount)
  const mappedFactIds = new Set(segmentFactIds?.flat() ?? [])
  if (
    usedFactIds.length === 0 ||
    anchor == null ||
    segmentFactIds == null ||
    mappedFactIds.size !== usedFactIds.length ||
    usedFactIds.some((id) => !mappedFactIds.has(id)) ||
    [...mappedFactIds].some((id) => !usedFactIds.includes(id))
  ) {
    throw new GreetError('AI招呼语元数据不完整')
  }

  const review = parseReview(parsed?.review)
  const audit = parseAudit(parsed?.audit)
  const promptFingerprint =
    typeof parsed?.promptFingerprint === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(parsed.promptFingerprint)
      ? parsed.promptFingerprint
      : undefined
  const resumeEvidenceVersion =
    Number.isInteger(parsed?.resumeEvidenceVersion) && (parsed?.resumeEvidenceVersion as number) > 0
      ? (parsed?.resumeEvidenceVersion as number)
      : undefined
  const resumeSourceHash =
    typeof parsed?.resumeSourceHash === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(parsed.resumeSourceHash)
      ? parsed.resumeSourceHash
      : undefined
  return {
    anchor,
    messages,
    usedFactIds,
    segmentFactIds,
    ...(resumeEvidenceVersion == null ? {} : { resumeEvidenceVersion }),
    ...(resumeSourceHash == null ? {} : { resumeSourceHash }),
    ...(review ? { review } : {}),
    ...(audit ? { audit } : {}),
    ...(promptFingerprint ? { promptFingerprint } : {}),
  }
}
