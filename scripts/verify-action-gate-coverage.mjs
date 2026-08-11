import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 每一类动作都必须有真实的调用点。
 *
 * 只在限额表里定义一类动作，看起来是有覆盖的，实际上一个请求都没被它管过——
 * navigate 就这样在闸门里躺了一版。这种「假覆盖」比压根没定义更容易骗过自己，
 * 而单测查不出来：它只能证明限额表里有这一项。
 */

const root = new URL('../src/', import.meta.url)

async function collectSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    if (entry.isDirectory()) {
      files.push(...(await collectSources(child)))
      continue
    }
    if (!/\.(ts|vue)$/.test(entry.name)) continue
    if (/\.test\.ts$/.test(entry.name)) continue
    files.push(child)
  }
  return files
}

const gateSource = await readFile(new URL('utils/actionGate.ts', root), 'utf8')
const kindLine = gateSource.match(/export type BossActionKind =([^\n]+)/)
assert.notEqual(kindLine, null, 'BossActionKind should be declared on one line')
const kinds = [...kindLine[1].matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1])
assert.ok(kinds.length > 0, 'BossActionKind should list at least one kind')

const sources = await collectSources(root)
const callSites = new Map(kinds.map((kind) => [kind, []]))
for (const file of sources) {
  if (file.pathname.endsWith('utils/actionGate.ts')) continue
  if (file.pathname.endsWith('utils/actionGateStore.ts')) continue
  const text = await readFile(file, 'utf8')
  for (const kind of kinds) {
    if (text.includes(`acquireBossAction('${kind}'`)) {
      callSites.get(kind).push(path.relative(process.cwd(), file.pathname))
    }
  }
}

const uncovered = kinds.filter((kind) => callSites.get(kind).length === 0)
assert.deepEqual(
  uncovered,
  [],
  `这些动作类型定义了限额却没有任何调用点，等于没有防护：${uncovered.join(', ')}`,
)

for (const kind of kinds) {
  const bucket = gateSource.includes(`${kind}: { burst:`)
  assert.ok(bucket, `${kind} 有调用点却没有限额，会直接落到总量桶上`)
}

console.log(`action gate coverage checks passed (${kinds.length} kinds)`)
