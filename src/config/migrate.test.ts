import { describe, expect, it } from 'vitest'

import { defaultFormData } from '@/stores/conf/info'
import { jsonClone } from '@/utils/deepmerge'

import { createDefaultAiTasks, createDefaultDeliverySettings } from './defaults'
import {
  migrateLegacyFormDataToSettings,
  migrateLegacyModels,
  settingsToLegacyFormData,
} from './migrate'

describe('legacy configuration migration', () => {
  it('uses the product-manager search preset when a first-run form has no search fields', () => {
    const result = migrateLegacyFormDataToSettings({})
    const defaults = createDefaultDeliverySettings()

    expect(result.jobRules.search).toEqual(defaults.jobRules.search)
  })

  it('preserves false, zero, empty string and empty arrays', () => {
    const legacy = jsonClone(defaultFormData)
    legacy.jobSources.searchEnabled = false
    legacy.jobSources.recommendEnabled = false
    legacy.jobContent.value = ['外包']
    legacy.jobSources.expectationsInitialized = true
    legacy.deliveryLimit = { search: 0, group: 100 }
    legacy.searchConditions = {
      directions: [],
      city: '',
      businessDistricts: ['旧工作区域'],
      salary: '',
      experience: [],
      degree: [],
      jobType: [],
    }
    legacy.amap.straightDistance = 0
    legacy.customGreeting.value = ''

    const result = migrateLegacyFormDataToSettings(legacy, {
      legacySearchUrl:
        'https://www.zhipin.com/web/geek/job?query=%E6%97%A7%E5%B2%97%E4%BD%8D&city=101020100',
      legacyJobTitles: ['不应覆盖'],
    })

    expect(result.jobRules.sources).toMatchObject({
      searchEnabled: false,
      recommendEnabled: false,
      expectationsInitialized: true,
    })
    expect(result.jobRules.sourceWeights).toEqual({ search: 0, expectations: 100 })
    expect(result.jobRules.search).toEqual({
      directions: [],
      city: '',
      salary: '',
      experience: [],
      degree: [],
      jobType: [],
    })
    expect(result.commute.straightDistanceKm).toBe(0)
    expect(result.delivery.customGreeting.value).toBe('')
    expect(result.jobRules.search).not.toHaveProperty('businessDistricts')
  })

  it('uses legacy URL and job titles only when structured search fields are absent', () => {
    const result = migrateLegacyFormDataToSettings(
      { jobTitle: { value: ['AI 产品经理'] } },
      {
        legacySearchUrl:
          'https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E4%BA%A7%E5%93%81&city=101020100&salary=406',
      },
    )
    expect(result.jobRules.search.directions).toEqual(['AI 产品经理', '数据产品'])
    expect(result.jobRules.search.city).toBe('101020100')
    expect(result.jobRules.search.salary).toBe('406')
  })

  it('round-trips every active runtime field without exposing AI prompts or model IDs', () => {
    const legacy = jsonClone(defaultFormData)
    legacy.jobContent.value = ['外包']
    legacy.jobSources.expectationsInitialized = true
    legacy.jobSources.enabledExpectIds = ['expect-1']
    legacy.aiFiltering = { enable: true, score: 80, model: 'secret-model', prompt: 'secret' }
    const settings = migrateLegacyFormDataToSettings(legacy)
    const tasks = createDefaultAiTasks()
    tasks.aiFiltering.enabled = true
    tasks.aiFiltering.score = 80
    tasks.aiFiltering.modelId = 'secret-model'

    const restored = settingsToLegacyFormData(settings, tasks, 'account-1')

    expect(restored.jobContent.value).toEqual(['外包'])
    expect(restored.jobSources).toEqual(legacy.jobSources)
    expect(restored.aiFiltering).toMatchObject({ enable: true, score: 80, prompt: '' })
    expect(restored.aiFiltering).not.toHaveProperty('model')
    expect(restored.userId).toBe('account-1')
  })

  it('converts old OpenAI models to explicit protocols and preserves max effort', () => {
    const models = migrateLegacyModels([
      {
        key: 'primary',
        name: '主模型',
        data: {
          url: 'http://localhost:8787/v1/responses',
          model: 'test-reasoning-model',
          api_key: 'local-key',
          advanced: { reasoning_effort: 'max', temperature: 0.2 },
          other: { timeout: 300, background: true },
        },
      },
    ])
    expect(models).toEqual([
      expect.objectContaining({
        id: 'primary',
        protocol: 'openai-responses',
        reasoningEffort: 'max',
        responsesBackground: 'on',
        timeoutSeconds: 300,
        generation: expect.objectContaining({ temperature: 0.2 }),
      }),
    ])
  })
})
