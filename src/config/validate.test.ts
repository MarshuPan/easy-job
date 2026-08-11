import { describe, expect, it } from 'vitest'

import {
  CONFIG_LIMITS,
  createDefaultConfigBundle,
  createDefaultStoredConfigState,
} from './defaults'
import { ConfigValidationError } from './types'
import {
  assertConfigImportSize,
  collectConfigBundleIssues,
  validateConfigBundle,
  validateStoredConfigState,
} from './validate'

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    name: '默认模型',
    protocol: 'openai-responses',
    url: 'https://api.example.test/v1/responses',
    apiKey: '',
    model: 'test-model',
    reasoningEffort: 'max',
    timeoutSeconds: 180,
    responsesBackground: 'auto',
    generation: {
      temperature: null,
      topP: null,
      presencePenalty: null,
      frequencyPenalty: null,
    },
    ...overrides,
  }
}

function expectIssue(value: unknown, path: string) {
  expect(collectConfigBundleIssues(value).some((issue) => issue.path === path)).toBe(true)
}

describe('ConfigBundleV1 validation', () => {
  it('accepts the complete public defaults', () => {
    const bundle = createDefaultConfigBundle({ exportedAt: new Date(0).toISOString() })
    expect(validateConfigBundle(bundle)).toEqual(bundle)
  })

  it.each(['http://127.0.0.1:8787/v1/chat/completions', 'https://api.example.test/v1/responses'])(
    'accepts user-selected HTTP(S) URL %s',
    (url) => {
      const bundle = createDefaultConfigBundle()
      bundle.models = [model({ url }) as never]
      expect(() => validateConfigBundle(bundle)).not.toThrow()
    },
  )

  it.each(['ftp://api.example.test/model', 'api.example.test/v1/responses'])(
    'rejects non-HTTP complete URL %s',
    (url) => {
      const bundle = createDefaultConfigBundle()
      bundle.models = [model({ url }) as never]
      expectIssue(bundle, '$.models[0].url')
    },
  )

  it('rejects duplicate model IDs and dangling task model references', () => {
    const bundle = createDefaultConfigBundle()
    bundle.models = [model() as never, model({ name: '重复模型' }) as never]
    bundle.tasks.aiFiltering.modelId = 'missing-model'
    expectIssue(bundle, '$.models[1].id')
    expectIssue(bundle, '$.tasks.aiFiltering.modelId')
  })

  it('rejects an inverted greeting character range', () => {
    const bundle = createDefaultConfigBundle()
    bundle.tasks.aiGreeting.minTotalCharacters = 181
    bundle.tasks.aiGreeting.maxTotalCharacters = 180
    expectIssue(bundle, '$.tasks.aiGreeting')
  })

  it('rejects source weights that do not sum to 100', () => {
    const bundle = createDefaultConfigBundle()
    bundle.settings.jobRules.sourceWeights = { search: 50, expectations: 40 }
    expectIssue(bundle, '$.settings.jobRules.sourceWeights')
  })

  it('does not accept removed businessDistricts in V1', () => {
    const bundle = createDefaultConfigBundle() as unknown as Record<string, any>
    bundle.settings.jobRules.search.businessDistricts = ['浦东新区']
    expectIssue(bundle, '$.settings.jobRules.search.businessDistricts')
  })

  it('validates resume source quotes and bucket fact references', () => {
    const bundle = createDefaultConfigBundle()
    bundle.profile.resume = {
      markdown: '真实简历内容',
      sourceHash: `sha256:${'0'.repeat(64)}`,
      evidenceVersion: 1,
      evidence: {
        facts: [
          {
            id: 'fact-1',
            sourceQuote: '不存在的摘录',
            action: '完成',
            object: '项目',
            ownership: 'owned',
            domains: [],
            skills: [],
            evidenceType: 'direct_fact',
            allowedClaimVerbs: [],
            confidence: 'high',
          },
        ],
        buckets: [{ id: 'bucket-1', signals: [], factIds: ['missing-fact'] }],
        claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
      },
    }
    expectIssue(bundle, '$.profile.resume.evidence.facts[0].sourceQuote')
    expectIssue(bundle, '$.profile.resume.evidence.buckets[0].factIds')
  })

  it('enforces model, array, prompt, resume and import resource limits', () => {
    const tooManyModels = createDefaultConfigBundle()
    tooManyModels.models = Array.from({ length: CONFIG_LIMITS.modelCount + 1 }, (_, index) =>
      model({ id: `model-${index}` }),
    ) as never[]
    expectIssue(tooManyModels, '$.models')

    const tooMuchText = createDefaultConfigBundle()
    tooMuchText.tasks.aiGreeting.prompt = 'x'.repeat(CONFIG_LIMITS.promptCharacters + 1)
    tooMuchText.profile.displayName = 'x'.repeat(CONFIG_LIMITS.displayNameCharacters + 1)
    tooMuchText.profile.resume.markdown = 'x'.repeat(CONFIG_LIMITS.resumeCharacters + 1)
    expectIssue(tooMuchText, '$.tasks.aiGreeting.prompt')
    expectIssue(tooMuchText, '$.profile.displayName')
    expectIssue(tooMuchText, '$.profile.resume.markdown')

    expect(() => assertConfigImportSize(CONFIG_LIMITS.importFileBytes)).not.toThrow()
    expect(() => assertConfigImportSize(CONFIG_LIMITS.importFileBytes + 1)).toThrow(
      ConfigValidationError,
    )
  })

  it('validates every stored account key including the first entry', () => {
    const state = createDefaultStoredConfigState()
    state.accountSettings[''] = createDefaultConfigBundle().settings
    expect(() => validateStoredConfigState(state)).toThrow(ConfigValidationError)
  })
})
