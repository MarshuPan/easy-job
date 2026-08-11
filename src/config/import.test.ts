import { describe, expect, it } from 'vitest'

import { createDefaultConfigBundle } from './defaults'
import { prepareImportedConfigBundle } from './import'
import { ConfigValidationError } from './types'

describe('prepareImportedConfigBundle', () => {
  it('rejects search as the only enabled source when it has no job directions', async () => {
    const bundle = createDefaultConfigBundle()
    bundle.settings.jobRules.sources = {
      searchEnabled: true,
      recommendEnabled: false,
      expectationsInitialized: true,
      enabledExpectations: [],
    }
    bundle.settings.jobRules.search.directions = []

    await expect(prepareImportedConfigBundle(bundle)).rejects.toMatchObject({
      name: 'ConfigValidationError',
      issues: [
        expect.objectContaining({
          path: '$.settings.jobRules.sources',
        }),
      ],
    } satisfies Partial<ConfigValidationError>)
  })

  it('accepts an enabled search source when at least one job direction is configured', async () => {
    const bundle = createDefaultConfigBundle()
    bundle.settings.jobRules.sources.recommendEnabled = false
    bundle.settings.jobRules.search.directions = ['AI 产品经理']

    await expect(prepareImportedConfigBundle(bundle)).resolves.toMatchObject({
      bundle: {
        settings: {
          jobRules: {
            sources: { searchEnabled: true },
            search: { directions: ['AI 产品经理'] },
          },
        },
      },
    })
  })

  it('accepts another enabled source even when search has no job directions', async () => {
    const bundle = createDefaultConfigBundle()
    bundle.settings.jobRules.search.directions = []

    await expect(prepareImportedConfigBundle(bundle)).resolves.toMatchObject({
      bundle: {
        settings: {
          jobRules: {
            sources: { recommendEnabled: true },
          },
        },
      },
    })
  })
})
