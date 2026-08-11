import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const testFiles = ['src/stores/log.test.ts', 'src/pages/zhipin/components/DeliveryRecords.test.ts']

const result = spawnSync(process.execPath, [vitest, 'run', ...testFiles], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

console.log('delivery record persistence behavior checks passed')
