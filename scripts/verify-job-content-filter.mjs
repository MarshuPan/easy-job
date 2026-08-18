import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import ts from 'typescript'

const source = await readFile(new URL('../src/utils/jobContentFilter.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
})
const filter = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
)

const validAiPmJd =
  '任职要求：1、本科及以上学历；2、1年或以上产品经理经验，应届生如特别优秀可不限经验；3、对 AI 产品有强烈好奇心。'

assert.equal(filter.shouldRejectJobContent(validAiPmJd.toLowerCase(), '应届'), false)
assert.equal(
  filter.shouldRejectJobContent('应届生优先，接受无经验培养'.toLowerCase(), '应届'),
  true,
)
assert.equal(
  filter.shouldRejectJobContent('2026届校园招聘，AI产品经理方向'.toLowerCase(), '应届'),
  true,
)
assert.equal(filter.shouldRejectJobContent('长期实习，可转正'.toLowerCase(), '实习'), true)
assert.equal(
  filter.shouldRejectJobContent('负责 AI 产品系统设计和策略迭代'.toLowerCase(), '销售岗'),
  false,
)
assert.equal(
  filter.shouldRejectJobContent('这是一个销售岗位，需要电话沟通客户'.toLowerCase(), '销售岗位'),
  true,
)

// 「司机」上下文规则。两条断言都取自真实日志（2026-08-18 运行）：
// 睿觅那条是误伤，滴滴那条是真命中，两者必须区分开。
const startupJd =
  '核心团队来自腾讯、字节等一线大厂，人效比极高，文化极度扁平务实，是典型的“创业老司机+超配团队”。'
const riderOpsJd =
  '是骑手管理产品岗位（涉及骑手运力，权益激励）。熟悉骑手/司机侧运力运营方法论，有分层运营经验。'

assert.equal(filter.shouldRejectJobContent(startupJd.toLowerCase(), '司机'), false)
assert.equal(filter.shouldRejectJobContent(riderOpsJd.toLowerCase(), '司机'), true)
assert.equal(filter.shouldRejectJobContent('负责司机端App的产品设计'.toLowerCase(), '司机'), true)
assert.equal(filter.shouldRejectJobContent('网约车司机招募与留存'.toLowerCase(), '司机'), true)
assert.equal(filter.shouldRejectJobContent('招聘专职司机，需C1驾照'.toLowerCase(), '司机'), true)
assert.equal(
  filter.shouldRejectJobContent('他是个技术老司机，带过大团队'.toLowerCase(), '司机'),
  false,
)
assert.equal(
  filter.shouldRejectJobContent('负责 AI 产品的策略迭代与数据分析'.toLowerCase(), '司机'),
  false,
)
// 下面两条各自只能被一条规则守住，用来隔离验证：
// 「运营老司机」若没有否定环视会命中 司机+运营；「司机侧」若没进后缀表则无人接管
// （周围没有骑手/网约车等业态词，兜底规则用不上）。
assert.equal(
  filter.shouldRejectJobContent('团队里都是老司机运营出身，擅长增长'.toLowerCase(), '司机'),
  false,
)
assert.equal(
  filter.shouldRejectJobContent('负责司机侧的产品体验与迭代'.toLowerCase(), '司机'),
  true,
)
assert.equal(filter.shouldRejectJobContent('急聘长途司机若干名'.toLowerCase(), '司机'), true)
// 这两条只有「业态词 + 距离窗口」那条兜底规则能接住：司机后面没有后缀词，
// 前面的业态词也隔着几个字，pattern 1 和招聘规则都用不上。
assert.equal(filter.shouldRejectJobContent('负责运力平台上的司机'.toLowerCase(), '司机'), true)
assert.equal(filter.shouldRejectJobContent('外卖配送场景下的司机'.toLowerCase(), '司机'), true)

console.log('job content filter checks passed')
