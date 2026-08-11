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

console.log('job content filter checks passed')
