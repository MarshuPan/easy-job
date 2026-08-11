import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import ts from 'typescript'

const source = await readFile(
  new URL('../src/utils/greetingSalutation.ts', import.meta.url),
  'utf8',
)
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
})
const salutation = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
)

assert.equal(salutation.formatBossTeacherSalutation('周女士'), '周老师')
assert.equal(salutation.formatBossTeacherSalutation('李先生'), '李老师')
assert.equal(salutation.formatBossTeacherSalutation('欧阳先生'), '欧阳老师')
assert.equal(salutation.formatBossTeacherSalutation('肖璐亭'), '肖老师')
assert.equal(salutation.formatBossTeacherSalutation('阿先生'), '老师')
assert.equal(salutation.formatBossTeacherSalutation('净先生'), '老师')
assert.equal(salutation.formatBossTeacherSalutation('HR'), '老师')

assert.deepEqual(
  salutation.normalizeGreetingSalutation(
    ['您好，周女士，我是林小舟。看到岗位在做 AI 角色与社区增长。', '第二条', '第三条'],
    '周女士',
    '林小舟',
  ),
  ['周老师您好，我是林小舟。看到岗位在做 AI 角色与社区增长。', '第二条', '第三条'],
)

assert.deepEqual(
  salutation.normalizeGreetingSalutation(
    ['肖老师您好。关注到岗位涉及 Agent 工作流。', '第二条', '第三条'],
    '肖璐亭',
    '林小舟',
  ),
  ['肖老师您好。关注到岗位涉及 Agent 工作流。', '第二条', '第三条'],
)

assert.deepEqual(
  salutation.normalizeGreetingSalutation(
    ['您好，我是林小舟。看到岗位涉及 Agent 工作流。', '第二条', '第三条'],
    '李南珠',
    '林小舟',
  ),
  ['李老师您好，我是林小舟。看到岗位涉及 Agent 工作流。', '第二条', '第三条'],
)

assert.deepEqual(
  salutation.normalizeGreetingSalutation(
    ['程丽老师您好，我是林小舟，之前做过 AI 原生应用 0-1。', '第二条', '第三条'],
    '程丽',
    '林小舟',
  ),
  ['程老师您好，我是林小舟。之前做过 AI 原生应用 0-1。', '第二条', '第三条'],
)

assert.deepEqual(
  salutation.normalizeGreetingSalutation(
    ['你好，HR，我是林小舟。看了岗位描述，比较贴近我做过的 Agent 落地。', '第二条', '第三条'],
    '',
    '林小舟',
  ),
  ['老师您好，我是林小舟。看了岗位描述，比较贴近我做过的 Agent 落地。', '第二条', '第三条'],
)

assert.deepEqual(
  salutation.normalizeGreetingSalutation(
    ['阿老师您好，我是林小舟。看了岗位描述，比较贴近我做过的 Agent 落地。', '第二条', '第三条'],
    '阿先生',
    '林小舟',
  ),
  ['老师您好，我是林小舟。看了岗位描述，比较贴近我做过的 Agent 落地。', '第二条', '第三条'],
)

assert.deepEqual(
  salutation.normalizeGreetingSalutation(
    ['净老师您好，我是林小舟。看了岗位描述，比较贴近我做过的 Agent 落地。', '第二条', '第三条'],
    '净先生',
    '林小舟',
  ),
  ['老师您好，我是林小舟。看了岗位描述，比较贴近我做过的 Agent 落地。', '第二条', '第三条'],
)

assert.deepEqual(
  salutation.normalizeGreetingSalutation(
    [
      '巫老师您好，我是林小舟。老师您好，我是林小舟，看到内容生态和 Agent 内容运营方向。',
      '第二条',
      '第三条',
    ],
    '巫先生',
    '林小舟',
  ),
  ['巫老师您好，我是林小舟。看到内容生态和 Agent 内容运营方向。', '第二条', '第三条'],
)

console.log('greeting salutation checks passed')
