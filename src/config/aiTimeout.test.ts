import { describe, expect, it } from 'vitest'

import type { AiModelConfig } from '@/config/types'

import {
  RESUME_EXTRACTION_MIN_TIMEOUT_SECONDS,
  resolveConfiguredAiTaskTimeoutSeconds,
} from './aiTimeout'

function model(overrides: Partial<AiModelConfig> = {}): AiModelConfig {
  return {
    id: 'model-1',
    name: 'AI 模型',
    protocol: 'openai-responses',
    url: 'https://example.test/v1/responses',
    apiKey: '',
    model: 'gpt-test',
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

describe('configured AI timeouts', () => {
  it.each([
    ['openai-responses', 'max'],
    ['openai-responses', ''],
    ['openai-chat-completions', 'max'],
    ['openai-chat-completions', ''],
    ['anthropic-messages', 'max'],
    ['anthropic-messages', ''],
  ] as const)(
    'uses the resume extraction minimum for %s with reasoning effort %s',
    (protocol, reasoningEffort) => {
      expect(
        resolveConfiguredAiTaskTimeoutSeconds(
          model({ protocol, reasoningEffort }),
          'resumeExtraction',
        ),
      ).toBe(RESUME_EXTRACTION_MIN_TIMEOUT_SECONDS)
    },
  )

  it('keeps the configured timeout for model tests and ordinary AI tasks', () => {
    expect(resolveConfiguredAiTaskTimeoutSeconds(model(), 'modelTest')).toBe(180)
    expect(resolveConfiguredAiTaskTimeoutSeconds(model(), 'aiFiltering')).toBe(180)
  })

  it('keeps a longer user configuration for resume extraction', () => {
    expect(
      resolveConfiguredAiTaskTimeoutSeconds(model({ timeoutSeconds: 900 }), 'resumeExtraction'),
    ).toBe(900)
  })
})
