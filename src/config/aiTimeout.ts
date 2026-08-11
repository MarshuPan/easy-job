import type { AiModelConfig } from '@/config/types'
import type { AiTaskType } from '@/utils/backgroundAiProtocol'

export type ConfiguredAiTaskType = AiTaskType | 'resumeExtraction' | 'modelTest'

export const RESUME_EXTRACTION_MIN_TIMEOUT_SECONDS = 600

export function resolveConfiguredAiTaskTimeoutSeconds(
  model: Pick<AiModelConfig, 'protocol' | 'reasoningEffort' | 'timeoutSeconds'>,
  task?: ConfiguredAiTaskType,
) {
  const configuredTimeout = model.timeoutSeconds
  if (task === 'resumeExtraction') {
    return Math.max(configuredTimeout, RESUME_EXTRACTION_MIN_TIMEOUT_SECONDS)
  }
  return configuredTimeout
}
