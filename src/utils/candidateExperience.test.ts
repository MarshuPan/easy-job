import { describe, expect, it } from 'vitest'

import { extractCandidateExperience } from './candidateExperience'

describe('candidate experience summary', () => {
  it('extracts only explicitly stated work duration', () => {
    expect(extractCandidateExperience('## 基本信息\n- 工作年限: 8年')).toBe('8年工作经验')
    expect(extractCandidateExperience('拥有 10 年以上 AI 产品工作经验')).toBe('10年以上工作经验')
    expect(extractCandidateExperience('工作经验：六年，负责平台产品')).toBe('六年工作经验')
  })

  it('does not infer duration from unrelated dates or job requirements', () => {
    expect(extractCandidateExperience('2020-2024 某公司 产品经理')).toBeNull()
    expect(extractCandidateExperience('负责平台产品与 Agent 工作流')).toBeNull()
  })
})
