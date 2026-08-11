import { resolve } from 'node:path'

import { createJiti } from 'jiti'

export function createWorkspaceTypeScriptLoader(root) {
  return createJiti(import.meta.url, {
    alias: {
      '@': resolve(root, 'src'),
    },
  })
}
