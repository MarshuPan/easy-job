import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('public verifier explicitly builds with generated private modules absent', async () => {
  const source = await readFile(join(root, 'scripts/verify-public-config-paths.mjs'), 'utf8')
  assert.match(source, /buildWithoutGeneratedPrivateModules/)
  assert.match(source, /src\/private\/generated\.ts/)
  assert.match(source, /src\/private\/generated\.background\.ts/)
  assert.match(source, /await rename\(path, backup\)/)
})
