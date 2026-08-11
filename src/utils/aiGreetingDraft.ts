import type {
  ClaimMode,
  FilteringDecision,
  GreetingDraft,
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
  return [...new Set(trimmed)].slice(0, 2)
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

export function parseGreetingDraft(content: string, messageCount = 3): GreetingDraft {
  const parsed = parseGptJson<Partial<GreetingDraft>>(content)
  const messages = Array.isArray(parsed?.messages)
    ? parsed.messages.map((item) => (typeof item === 'string' ? item.trim() : ''))
    : []
  if (messages.length !== messageCount || messages.some((item) => item.length === 0)) {
    throw new GreetError(`AI招呼语必须包含${messageCount}条消息`)
  }

  const usedFactIds = normalizeFactIds(parsed?.usedFactIds)
  if (
    usedFactIds.length === 0 ||
    (parsed?.claimMode !== 'adjacent' && parsed?.claimMode !== 'direct') ||
    typeof parsed?.openingPattern !== 'string' ||
    parsed.openingPattern.trim().length === 0
  ) {
    throw new GreetError('AI招呼语元数据不完整')
  }

  return {
    messages,
    usedFactIds,
    claimMode: parsed.claimMode,
    openingPattern: parsed.openingPattern.trim().slice(0, 40),
  }
}
