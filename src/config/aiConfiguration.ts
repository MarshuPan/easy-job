import { isPlainObject, jsonClone } from '@/utils/deepmerge'

import { DEFAULT_AI_FILTERING_PROMPT } from './defaults'
import { applyGreetingTarget, greetingTargetFromTask } from './greetingLength'
import type { AiModelConfig, AiTaskConfig } from './types'

const taskModelPriority = ['aiFiltering', 'aiGreeting', 'resumeExtraction'] as const

export interface AiConfiguration {
  models: AiModelConfig[]
  tasks: AiTaskConfig
}

export function createBlankAiModel(): AiModelConfig {
  return {
    id: `model-${crypto.randomUUID()}`,
    name: 'AI 模型',
    protocol: 'openai-responses',
    url: '',
    apiKey: '',
    model: '',
    reasoningEffort: '',
    timeoutSeconds: 180,
    responsesBackground: 'auto',
    generation: {
      temperature: null,
      topP: null,
      presencePenalty: null,
      frequencyPenalty: null,
    },
  }
}

function resolvePrimaryModel(models: AiModelConfig[], tasks: AiTaskConfig) {
  for (const taskName of taskModelPriority) {
    const modelId = tasks[taskName].modelId
    if (!modelId) continue
    const model = models.find((item) => item.id === modelId)
    if (model) return model
  }
  return models[0]
}

export function canonicalizeAiConfiguration<T extends AiConfiguration>(value: T): T {
  const result = jsonClone(value)
  if (
    !Array.isArray(result.models) ||
    !isPlainObject(result.tasks) ||
    !isPlainObject(result.tasks.resumeExtraction) ||
    !isPlainObject(result.tasks.aiFiltering) ||
    !isPlainObject(result.tasks.aiGreeting)
  ) {
    return result
  }
  const primaryModel = resolvePrimaryModel(result.models, result.tasks)
  result.models = primaryModel ? [primaryModel] : []

  const modelId = primaryModel?.id ?? null
  result.tasks.resumeExtraction.modelId = modelId
  result.tasks.aiFiltering.modelId = modelId
  result.tasks.aiGreeting.modelId = modelId
  result.tasks.aiFiltering.prompt = DEFAULT_AI_FILTERING_PROMPT
  applyGreetingTarget(result.tasks.aiGreeting, greetingTargetFromTask(result.tasks.aiGreeting))

  return result
}
