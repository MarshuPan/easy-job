import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const backgroundSource = await readFile(
  new URL('../src/message/background.ts', import.meta.url),
  'utf8',
)
const recordsSource = await readFile(
  new URL('../src/pages/zhipin/components/DeliveryRecords.vue', import.meta.url),
  'utf8',
)
const recordsStyles = await readFile(
  new URL('../src/pages/zhipin/components/DeliveryRecords.css', import.meta.url),
  'utf8',
)
const pendingGreetingSource = await readFile(
  new URL('../src/composables/useWebSocket/pendingGreeting.ts', import.meta.url),
  'utf8',
)

const openChatStart = backgroundSource.indexOf('async openChatTab(url: string)')
assert.notEqual(openChatStart, -1, 'openChatTab should exist')
// 以「下一个方法」而不是某个具名方法收尾：原来锚在 request() 上，那个桥被删掉之后
// 这里就再也切不出方法体了，检查本身变成了噪声。
const openChatEnd = backgroundSource.indexOf('\n  async ', openChatStart + 1)
assert.notEqual(openChatEnd, -1, 'openChatTab should be followed by another method')
const openChatTab = backgroundSource.slice(openChatStart, openChatEnd)

assert.match(
  openChatTab,
  /active:\s*true/,
  'chat tab should be activated so the page can consume queued greetings',
)
assert.match(
  openChatTab,
  /waitForTabLoaded/,
  'openChatTab should wait for the chat page to finish loading',
)
assert.match(
  openChatTab,
  /browser\.tabs\.reload/,
  'reused target chat tab should be refreshed to reinject main-world',
)

assert.doesNotMatch(
  pendingGreetingSource,
  /当前聊天页不是目标HR|getGeekChatIdFromUrl|chatId !== item\.toName/,
  'queued greetings should not depend on BOSS preserving target id in the chat page URL',
)
assert.match(
  pendingGreetingSource,
  /isGeekChatUrl\(location\.href\)/,
  'queued greetings should only require a real chat page before checking the send channel',
)

assert.match(
  recordsSource,
  /<style\s+src="\.\/DeliveryRecords\.css"\s+scoped><\/style>/,
  'delivery record styles should remain linked from the component',
)
assert.match(
  recordsStyles,
  /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
  'delivery detail summary should keep its six fields in a stable three-column grid',
)
assert.doesNotMatch(
  recordsStyles,
  /grid-template-columns:\s*repeat\(\d+,\s*minmax\(150px,\s*1fr\)\)/,
  'delivery detail area should not force horizontal overflow on narrow panels',
)

console.log('greeting chat delivery checks passed')
