import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import ts from 'typescript'

const source = await readFile(new URL('../src/utils/zhipinRoute.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
})
const route = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
)

assert.equal(route.isGeekChatUrl('https://www.zhipin.com/web/geek/jobs?salary=406'), false)
assert.equal(route.isGeekChatUrl('https://www.zhipin.com/web/geek/job-recommend'), false)
assert.equal(route.isGeekChatUrl('https://www.zhipin.com/web/geek/chat'), true)
assert.equal(route.isGeekChatUrl('https://www.zhipin.com/web/geek/chat?id=9ffc~'), true)
assert.equal(
  route.buildGeekChatUrl('9ffc1385bce727eb1XV-2Nq5GVQ~'),
  'https://www.zhipin.com/web/geek/chat?id=9ffc1385bce727eb1XV-2Nq5GVQ~',
)
assert.equal(route.buildGeekChatUrl(''), 'https://www.zhipin.com/web/geek/chat')
assert.equal(
  route.getGeekChatIdFromUrl(
    'https://www.zhipin.com/web/geek/chat?id=9ffc1385bce727eb1XV-2Nq5GVQ~',
  ),
  '9ffc1385bce727eb1XV-2Nq5GVQ~',
)
assert.equal(
  route.isSameGeekChatUrl(
    'https://www.zhipin.com/web/geek/chat?id=9ffc1385bce727eb1XV-2Nq5GVQ%7E',
    'https://www.zhipin.com/web/geek/chat?id=9ffc1385bce727eb1XV-2Nq5GVQ~',
  ),
  true,
)

console.log('greeting route checks passed')
