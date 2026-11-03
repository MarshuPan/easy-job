import { describe, expect, it } from 'vitest'

import {
  buildGreetingDiversityContext,
  countFactUsage,
  findRepeatedPhrases,
  findReusedPhrases,
  findStockPhrases,
  hasSelfDeprecation,
  jdQuoteAppears,
  MAX_GREETING_OVERLAP,
  maxOverlapWithRecent,
} from './greetingDiversity'

const metricClause = '约200家门店单季带来约5万笔复购订单'

function greeting(boss: string, middle: string) {
  return [`${boss}老师您好，我做了6年会员运营。`, `${middle}。`, '期待进一步沟通。']
}

describe('greeting diversity statistics', () => {
  it('reports a sentence shared by several recent greetings in its original wording', () => {
    const recent = [
      greeting('王', `我搭建过会员积分体系，${metricClause}`),
      greeting('李', `我重做过会员等级权益，${metricClause}`),
      greeting('赵', `我设计过储值卡活动，${metricClause}`),
      greeting('钱', '我负责过社群团购的选品和定价'),
    ]

    const phrases = findRepeatedPhrases(recent).map((item) => item.phrase)

    // 原文原样返回，不是归一化后的小写加半角标点；也不跨标点拼出半句。
    expect(phrases).toContain(metricClause)
    // 开场身份句每次一样是正常的，不计入：逼着换说法只会换出「求职定位是……」。
    expect(phrases).not.toContain('我做了6年会员运营')
    expect(phrases.some((phrase) => phrase.includes('老师'))).toBe(false)
    expect(phrases.some((phrase) => phrase.includes('期待'))).toBe(false)
    expect(phrases.some((phrase) => /[，。；]/u.test(phrase))).toBe(false)
  })

  it('does not flag a sentence that only two greetings share', () => {
    const recent = [
      greeting('王', `我搭建过会员积分体系，${metricClause}`),
      greeting('李', `我重做过会员等级权益，${metricClause}`),
      greeting('赵', '我负责过社群团购的选品和定价'),
    ]
    expect(findRepeatedPhrases(recent).map((item) => item.phrase)).not.toContain(metricClause)
  })

  it('counts each fact once per greeting', () => {
    expect(
      countFactUsage([
        { usedFactIds: ['fact-a', 'fact-b'] },
        { usedFactIds: ['fact-a', 'fact-a'] },
        { usedFactIds: ['fact-c'] },
      ]),
    ).toEqual({ 'fact-a': 2, 'fact-b': 1, 'fact-c': 1 })
  })

  it('builds the context the model sees without any recent greeting text beyond the phrases', () => {
    const recent = [
      {
        messages: greeting('王', `我搭建过会员积分体系，${metricClause}`),
        usedFactIds: ['fact-a'],
      },
      {
        messages: greeting('李', `我重做过会员等级权益，${metricClause}`),
        usedFactIds: ['fact-a'],
      },
      { messages: greeting('赵', `我设计过储值卡活动，${metricClause}`), usedFactIds: ['fact-b'] },
    ]
    const context = buildGreetingDiversityContext(recent)
    expect(context.recentFactUses).toEqual({ 'fact-a': 2, 'fact-b': 1 })
    expect(context.avoidPhrases).toContain(metricClause)
    expect(JSON.stringify(context)).not.toContain('王老师')
  })

  it('finds avoided phrases in a draft regardless of spacing and letter case', () => {
    const draft = ['老师您好。', '我负责的 CRM 会员体系里，约200家门店单季带来约5万笔 复购订单。']
    expect(findReusedPhrases(draft, [metricClause, '我负责的crm会员体系'])).toEqual([
      metricClause,
      '我负责的crm会员体系',
    ])
    expect(findReusedPhrases(['老师您好，我负责过社群团购。'], [metricClause])).toEqual([])
  })

  it('names template phrasing that real batches kept producing', () => {
    expect(findStockPhrases(['我希望进一步了解团队目标'])).toEqual(['我希望'])
    expect(findStockPhrases(['我从事会员运营工作'])).toEqual(['从事……工作'])
    expect(findStockPhrases(['我在私域增长上有实际经验'])).toEqual(['在……上有实际经验'])
    expect(findStockPhrases(['这套经验可用于门店复购'])).toContain('这套经验可用于……')
    expect(findStockPhrases(['我能拿出会员体系的搭建经验'])).toEqual(['我能拿出……'])
    // 1.3.18 的两处照抄：提示词里的「哪个环节是我做过的」，和被逼着换说法的身份句。
    expect(findStockPhrases(['我做过的对应环节是会员积分体系'])).toEqual(['我做过的对应环节……'])
    expect(findStockPhrases(['我的求职定位是会员运营'])).toEqual(['求职定位是……'])
    expect(findStockPhrases(['我应聘会员运营，有6年经验'])).toEqual(['求职定位是……'])
    // 只收具体句式，不误伤正常用词。
    expect(findStockPhrases(['我负责过会员产品定位和权益设计，希望的指标是复购率'])).toEqual([])
  })

  it('catches volunteering what I have not done', () => {
    expect(hasSelfDeprecation(['我的经历主要在线上运营侧。'])).toBe(true)
    expect(hasSelfDeprecation(['我的实践在交易软件侧，不涉及线下门店施工。'])).toBe(true)
    expect(hasSelfDeprecation(['虽然我没有做过跨境业务，但……'])).toBe(true)
    // 1.3.17 真机漏掉的一句。
    expect(hasSelfDeprecation(['我没有PLM、IPD或BOM项目经历。'])).toBe(true)
    expect(hasSelfDeprecation(['我并未负责过线下门店。'])).toBe(true)
    // 1.3.18 漏掉的四种说法。
    expect(hasSelfDeprecation(['仓储规则不是我做过的领域。'])).toBe(true)
    expect(hasSelfDeprecation(['线下门店施工不在上述项目范围内。'])).toBe(true)
    expect(hasSelfDeprecation(['跨境支付本身我没有实践。'])).toBe(true)
    expect(hasSelfDeprecation(['我的场景是线上社群，并非线下门店。'])).toBe(true)
    expect(hasSelfDeprecation(['我负责过线上和线下两侧的会员打通。'])).toBe(false)
  })

  it('checks the JD quote against the job text, ignoring punctuation and spacing', () => {
    const jd = '岗位职责：\n1. 负责会员体系搭建与复购提升；\n2. 与门店团队协作推进活动落地。'
    expect(jdQuoteAppears(jd, '负责会员体系搭建与复购提升')).toBe(true)
    expect(jdQuoteAppears(jd, '负责会员体系搭建，与复购提升')).toBe(true)
    // 改写过的、拼接的、太短的都不算摘录。
    expect(jdQuoteAppears(jd, '负责会员增长与复购')).toBe(false)
    expect(jdQuoteAppears(jd, '负责')).toBe(false)
  })

  it('measures how much of a draft repeats a single recent greeting', () => {
    const previous = greeting('王', `我搭建过会员积分体系，${metricClause}`)
    const copied = greeting('李', `我搭建过会员积分体系，${metricClause}`)
    const fresh = greeting('赵', '我负责过社群团购的选品和定价，季度GMV翻了一倍')
    expect(maxOverlapWithRecent(copied, [previous])).toBeGreaterThanOrEqual(MAX_GREETING_OVERLAP)
    expect(maxOverlapWithRecent(fresh, [previous])).toBeLessThan(MAX_GREETING_OVERLAP)
    expect(maxOverlapWithRecent(fresh, [])).toBe(0)
  })
})
