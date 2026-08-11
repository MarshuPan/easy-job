import { describe, expect, it } from 'vitest'

import { DEFAULT_AI_FILTERING_PROMPT, DEFAULT_AI_GREETING_PROMPT } from './defaults'
import { LEGACY_DEFAULT_AI_GREETING_PROMPT_MESSAGE_ROLES } from './legacyGreetingPrompts.fixture'
import { migratePrivateConfigV1 } from './privateMigration'

const resumeMarkdown = '负责企业服务平台建设，并完成跨团队交付。'

function legacyInput() {
  return {
    personalConfig: {
      searchUrl:
        'https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E4%BA%A7%E5%93%81&city=101020100&salary=406',
      formData: {
        jobTitle: {
          enable: true,
          include: true,
          value: ['AI 产品经理'],
          options: [],
        },
        aiFiltering: {
          enable: true,
          model: 'primary',
          score: 60,
          prompt: '旧模板 {{ resumeEvidence }}',
        },
        aiGreeting: {
          enable: true,
          model: 'primary',
          prompt: '旧模板 {{ selectedFacts }}',
        },
        deliveryLimit: { search: 70, group: 30 },
      },
      models: [
        {
          key: 'primary',
          name: '主模型',
          data: {
            mode: 'openai',
            url: 'http://127.0.0.1:8787/v1/responses',
            model: 'test-model',
            api_key: 'local-key',
            advanced: { reasoning_effort: 'max', temperature: 0.2 },
            other: { timeout: 300, background: true },
          },
        },
      ],
    },
    resumeMarkdown,
    resumeEvidence: {
      name: '候选人',
      facts: [
        {
          id: 'fact-1',
          sourceQuote: '负责企业服务平台建设',
          action: '负责',
          object: '企业服务平台建设',
          ownership: 'owned',
          domains: ['企业服务'],
          skills: ['平台规划'],
          evidenceType: 'direct_fact',
          allowedClaimVerbs: ['负责'],
          confidence: 'high',
        },
      ],
      buckets: [],
      claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
    },
    appVersion: '0.7.0',
    exportedAt: new Date(0).toISOString(),
  }
}

describe('private configuration V1 migration', () => {
  it('creates a complete portable bundle without carrying legacy template placeholders', async () => {
    const bundle = await migratePrivateConfigV1(legacyInput())

    expect(bundle).toMatchObject({
      format: 'agent-delivery-assistant-config',
      schemaVersion: 1,
      appVersion: '0.7.0',
      profile: { displayName: '候选人' },
      tasks: {
        resumeExtraction: { modelId: 'primary' },
        aiFiltering: { enabled: true, modelId: 'primary', score: 60 },
        aiGreeting: {
          enabled: true,
          modelId: 'primary',
          messageCount: 3,
          minTotalCharacters: 125,
          maxTotalCharacters: 175,
        },
      },
    })
    expect(bundle.models[0]).toMatchObject({
      id: 'primary',
      protocol: 'openai-responses',
      reasoningEffort: 'max',
      timeoutSeconds: 300,
      responsesBackground: 'on',
    })
    expect(bundle.settings.jobRules.search).toMatchObject({
      directions: ['AI 产品经理', '数据产品'],
      city: '101020100',
      salary: '406',
    })
    expect(bundle.settings.jobRules.search).not.toHaveProperty('businessDistricts')
    expect(bundle.tasks.aiFiltering.prompt).toBe(DEFAULT_AI_FILTERING_PROMPT)
    expect(bundle.tasks.aiGreeting.prompt).toBe(DEFAULT_AI_GREETING_PROMPT)
    expect(bundle.profile.resume.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(bundle.profile.resume.evidence?.facts).toHaveLength(1)
  })

  it('preserves a legacy prompt that is already a plain user preference', async () => {
    const input = legacyInput()
    input.personalConfig.formData.aiGreeting.prompt = '语气专业自然，避免重复第一人称。'

    const bundle = await migratePrivateConfigV1(input)

    expect(bundle.tasks.aiGreeting.prompt).toBe('语气专业自然，避免重复第一人称。')
  })

  it('upgrades a historical built-in greeting prompt in a private configuration', async () => {
    const input = legacyInput()
    input.personalConfig.formData.aiGreeting.prompt =
      LEGACY_DEFAULT_AI_GREETING_PROMPT_MESSAGE_ROLES

    const bundle = await migratePrivateConfigV1(input)

    expect(bundle.tasks.aiGreeting.prompt).toBe(DEFAULT_AI_GREETING_PROMPT)
  })
})
