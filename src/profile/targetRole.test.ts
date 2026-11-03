import { describe, expect, it } from 'vitest'

import { resolveTargetRole, targetRoleFromResume } from './targetRole'

const expectations = [
  { id: 'exp-pm', positionName: '产品经理' },
  { id: 'exp-ops', positionName: '用户运营' },
]

describe('target role', () => {
  it('prefers what the user wrote', () => {
    expect(
      resolveTargetRole({
        targetRole: '  产品经理，侧重 B 端 SaaS ',
        jobExpectationIds: ['exp-ops'],
        expectations,
        resumeMarkdown: '期望：产品经理',
      }),
    ).toBe('产品经理，侧重 B 端 SaaS')
  })

  it('uses the BOSS expectation the job was found under', () => {
    // 同时挂两个期望的人，从「用户运营」期望下抓到的岗位，身份就是用户运营，不能一律取第一个。
    expect(resolveTargetRole({ jobExpectationIds: ['exp-ops'], expectations })).toBe('用户运营')
    expect(resolveTargetRole({ jobExpectationIds: ['exp-pm'], expectations })).toBe('产品经理')
  })

  it('falls back to the first expectation, then the resume intent line, for search jobs', () => {
    expect(resolveTargetRole({ jobExpectationIds: [], expectations })).toBe('产品经理')
    expect(
      resolveTargetRole({
        expectations: [{ id: 'blank', positionName: ' ' }],
        resumeMarkdown: '# 简历\n期望：Java 后端 ｜ 杭州 ｜ 30–40K',
      }),
    ).toBe('Java 后端')
    expect(resolveTargetRole({})).toBe('')
  })

  it('reads common resume intent formats', () => {
    expect(targetRoleFromResume('- **求职意向**：高级产品经理 / 上海')).toBe('高级产品经理')
    expect(targetRoleFromResume('期望职位: 数据分析师|北京')).toBe('数据分析师')
    expect(targetRoleFromResume('负责期望管理相关工作')).toBe('')
  })
})
