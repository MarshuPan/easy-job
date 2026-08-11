import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = process.cwd()
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
const tests = [
  'src/utils/backgroundAi.test.ts',
  'src/utils/backgroundAiConfigured.test.ts',
  'src/message/background.test.ts',
]
const result = spawnSync(process.execPath, [vitest, 'run', ...tests], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
