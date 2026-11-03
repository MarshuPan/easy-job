import { describe, expect, it } from 'vitest'

import {
  pruneRemovedEvidenceFields,
  quoteAppearsInResume,
  verifiedMetrics,
} from './resumeEvidenceRules'

describe('resume evidence rules', () => {
  it('tolerates formatting differences but not different content', () => {
    const markdown = '## 工作经历\n- **负责 Agent 平台**，覆盖\n  100 个账号（2023 年）'

    expect(quoteAppearsInResume(markdown, '负责 Agent 平台,覆盖 100 个账号(2023 年)')).toBe(true)
    expect(quoteAppearsInResume(markdown, '负责Agent平台，覆盖100个账号')).toBe(true)
    expect(quoteAppearsInResume(markdown, '主导 Agent 平台')).toBe(false)
    expect(quoteAppearsInResume(markdown, '覆盖 1000 个账号')).toBe(false)
    expect(quoteAppearsInResume(markdown, '  ** ')).toBe(false)
  })

  it('keeps only metrics whose value appears in the quote', () => {
    expect(
      verifiedMetrics('日活 12 万，转化提升 30%', [
        { name: '日活', value: '12万' },
        { name: '转化', value: '30%' },
        { name: '营收', value: '5000 万' },
      ]).map((metric) => metric.name),
    ).toEqual(['日活', '转化'])
    expect(verifiedMetrics('没有数字', undefined)).toEqual([])
  })

  it('compares the numbers themselves, not the wording around them', () => {
    // 取自真实简历的五个数字：前四个是原文的数，只是模型换了写法；最后一个是模型自己数的。
    const kept = (quote: string, value: string) =>
      verifiedMetrics(quote, [{ name: 'm', value }]).length === 1

    expect(kept('虚构案例：从 0 创建两套测试目录。', '2 条')).toBe(true)
    expect(kept('约 100 账号矩阵化运营', '约 100 个')).toBe(true)
    expect(kept('Web 后台/小程序/H5/App 四端交付', '4 端')).toBe(true)
    expect(kept('虚构仓库登记 310–470 个演示物料', '310–470 个')).toBe(true)
    expect(kept('Web 后台/小程序/H5/App 多端独立交付', '4 类')).toBe(false)
    // 整段比较数字：100 不能借 1000 过关。
    expect(kept('覆盖 1000 个账号', '100 个')).toBe(false)
    expect(kept('团队二十五人', '25 人')).toBe(true)
    // 没有可比数字时退回整段比较。
    expect(kept('千万级流水', '千万级')).toBe(true)
  })

  it('prunes removed fields without touching current ones', () => {
    const evidence = {
      facts: [{ id: 'f1', ownership: 'owned', confidence: 'high', domains: [], skills: [] }],
      buckets: [],
      claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
    }
    pruneRemovedEvidenceFields(evidence)
    expect(evidence).toEqual({
      facts: [{ id: 'f1' }],
      claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
    })
    expect(() => pruneRemovedEvidenceFields(null)).not.toThrow()
  })
})
