import { RESUME_EVIDENCE_VERSION } from '@/profile/resumeExtraction'
import { hashResumeMarkdown } from '@/profile/resumeHash'
import type { ResumeEvidence } from '@/types/aiGreeting'
import { isPlainObject, jsonClone } from '@/utils/deepmerge'

import { canonicalizeAiConfiguration } from './aiConfiguration'
import {
  DEFAULT_AI_FILTERING_PROMPT,
  DEFAULT_AI_GREETING_PROMPT,
  createDefaultConfigBundle,
} from './defaults'
import {
  migrateLegacyAiTasks,
  migrateLegacyFormDataToSettings,
  migrateLegacyModels,
} from './migrate'
import { ConfigValidationError, type ConfigBundleV1 } from './types'
import { migrateAiGreetingUserPrompt, migrateLegacyUserPrompt } from './userPrompt'
import { validateConfigBundle } from './validate'

export interface PrivateConfigMigrationInput {
  personalConfig: unknown
  resumeMarkdown: string
  resumeEvidence: unknown
  appVersion: string
  exportedAt?: string
}

function requireRecord(value: unknown, path: string) {
  if (!isPlainObject(value)) {
    throw new ConfigValidationError([{ path, message: `${path}: 必须是对象` }])
  }
  return value
}

function resolveTaskModels(bundle: ConfigBundleV1) {
  const modelIds = new Set(bundle.models.map((model) => model.id))
  const filteringModelId = bundle.tasks.aiFiltering.modelId
  const greetingModelId = bundle.tasks.aiGreeting.modelId
  const fallbackModelId =
    (filteringModelId && modelIds.has(filteringModelId) && filteringModelId) ||
    (greetingModelId && modelIds.has(greetingModelId) && greetingModelId) ||
    bundle.models[0]?.id ||
    null

  bundle.tasks.resumeExtraction.modelId = fallbackModelId
  if (!filteringModelId || !modelIds.has(filteringModelId)) {
    bundle.tasks.aiFiltering.modelId = fallbackModelId
  }
  if (!greetingModelId || !modelIds.has(greetingModelId)) {
    bundle.tasks.aiGreeting.modelId = fallbackModelId
  }
}

export async function migratePrivateConfigV1(
  input: PrivateConfigMigrationInput,
): Promise<ConfigBundleV1> {
  const personalConfig = requireRecord(input.personalConfig, '$.personalConfig')
  const legacyFormData = requireRecord(personalConfig.formData, '$.personalConfig.formData')
  const resumeEvidence = requireRecord(
    input.resumeEvidence,
    '$.resumeEvidence',
  ) as unknown as ResumeEvidence

  if (typeof input.resumeMarkdown !== 'string' || input.resumeMarkdown.trim() === '') {
    throw new ConfigValidationError([
      { path: '$.resumeMarkdown', message: '$.resumeMarkdown: 不能为空' },
    ])
  }
  if (typeof input.appVersion !== 'string' || input.appVersion.trim() === '') {
    throw new ConfigValidationError([{ path: '$.appVersion', message: '$.appVersion: 不能为空' }])
  }

  const bundle = createDefaultConfigBundle({
    appVersion: input.appVersion,
    exportedAt: input.exportedAt,
  })
  bundle.models = migrateLegacyModels(personalConfig.models)
  bundle.tasks = migrateLegacyAiTasks(legacyFormData)
  bundle.tasks.aiFiltering.prompt = migrateLegacyUserPrompt(
    requireRecord(legacyFormData.aiFiltering, '$.personalConfig.formData.aiFiltering').prompt,
    DEFAULT_AI_FILTERING_PROMPT,
  )
  bundle.tasks.aiGreeting.prompt = migrateAiGreetingUserPrompt(
    requireRecord(legacyFormData.aiGreeting, '$.personalConfig.formData.aiGreeting').prompt,
    DEFAULT_AI_GREETING_PROMPT,
  )
  resolveTaskModels(bundle)
  bundle.settings = migrateLegacyFormDataToSettings(legacyFormData, {
    legacySearchUrl:
      typeof personalConfig.searchUrl === 'string' ? personalConfig.searchUrl : undefined,
    legacyJobTitles: Array.isArray(
      requireRecord(legacyFormData.jobTitle, '$.personalConfig.formData.jobTitle').value,
    )
      ? (
          requireRecord(legacyFormData.jobTitle, '$.personalConfig.formData.jobTitle')
            .value as unknown[]
        ).filter((value): value is string => typeof value === 'string')
      : [],
  })
  bundle.profile = {
    displayName: typeof resumeEvidence.name === 'string' ? resumeEvidence.name.trim() : '',
    resume: {
      markdown: input.resumeMarkdown,
      sourceHash: await hashResumeMarkdown(input.resumeMarkdown),
      evidenceVersion: RESUME_EVIDENCE_VERSION,
      evidence: jsonClone(resumeEvidence),
    },
  }

  return validateConfigBundle(canonicalizeAiConfiguration(bundle))
}
