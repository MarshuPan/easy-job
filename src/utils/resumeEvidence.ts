import type { ResumeEvidence, SelectedGreetingFact } from '@/types/aiGreeting'

export function resolveSelectedGreetingFacts(
  evidence: ResumeEvidence | null,
  selectedFactIds: string[],
): SelectedGreetingFact[] {
  if (!evidence) throw new Error('后台结构化简历证据不可用')
  const ids = [...new Set(selectedFactIds)]
  if (ids.length === 0 || ids.length > 2) throw new Error('筛选事实数量必须为1到2个')
  const byId = new Map(evidence.facts.map((fact) => [fact.id, fact]))
  return ids.map((id) => {
    const fact = byId.get(id)
    if (!fact) throw new Error(`筛选事实ID无效: ${id}`)
    const { sourceQuote: _sourceQuote, ...publicFact } = fact
    return publicFact
  })
}

export function listGreetingCandidateFacts(
  evidence: ResumeEvidence | null,
): SelectedGreetingFact[] {
  if (!evidence) throw new Error('后台结构化简历证据不可用')
  return evidence.facts.map((fact) => {
    const { sourceQuote: _sourceQuote, ...publicFact } = fact
    return publicFact
  })
}
