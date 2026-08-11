import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../src/composables/useApplying/index.ts', import.meta.url),
  'utf8',
)
const start = source.indexOf('const pipeline: Pipeline = [')
const end = source.indexOf('return {', start)
assert.notEqual(start, -1, 'pipeline definition should exist')
assert.notEqual(end, -1, 'createHandle return should exist after pipeline')

const pipeline = source.slice(start, end)

for (const deterministic of [
  'h.communicated()',
  'h.SameCompanyFilter()',
  'h.SameHrFilter()',
  'h.goldHunterFilter()',
  'h.companySizeRange()',
  'h.jobContent()',
  'h.jobFriendStatus()',
  'h.activityFilter()',
  'h.amap()',
]) {
  assert.equal(
    pipeline.includes(deterministic),
    true,
    `${deterministic} should enforce its configured runtime rule`,
  )
}

assert.equal(pipeline.includes('h.aiFiltering()'), true, 'aiFiltering should decide match score')
assert.equal(
  pipeline.indexOf('h.goldHunterFilter()') < pipeline.indexOf('args.data.getCard()'),
  true,
  'list-level filters should run before job detail loading',
)
for (const listLevel of ['h.companySizeRange()']) {
  assert.equal(
    pipeline.indexOf(listLevel) < pipeline.indexOf('args.data.getCard()'),
    true,
    `${listLevel} should run before job detail loading`,
  )
}
assert.equal(
  pipeline.indexOf('h.jobContent()') < pipeline.indexOf('h.aiFiltering()'),
  true,
  'configured JD exclusions should run before the AI score',
)
assert.equal(pipeline.match(/h\.aiFiltering\(\)/g)?.length, 1, 'AI filtering should run once')

// 这五个过滤器已经从产品里移除：面板上没有入口，白名单式的关键词穷举不完还会误杀，
// 岗位方向的判断交给 JD 与简历的实时匹配。重新接回流水线要先想清楚这几点。
for (const removed of [
  'h.jobTitle()',
  'h.company()',
  'h.salaryRange()',
  'h.hrPosition()',
  'h.jobAddress()',
]) {
  assert.equal(pipeline.includes(removed), false, `${removed} was removed from the product`)
}

console.log('runtime filter pipeline checks passed')
