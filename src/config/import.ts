import { hashResumeMarkdown } from '@/profile/resumeHash'
import deepmerge, { isPlainObject, jsonClone } from '@/utils/deepmerge'

import { canonicalizeAiConfiguration } from './aiConfiguration'
import { createDefaultConfigBundle } from './defaults'
import {
  CONFIG_FORMAT,
  CONFIG_SCHEMA_VERSION,
  ConfigValidationError,
  type ConfigBundleV1,
  type ConfigValidationIssue,
} from './types'
import { collectConfigBundleIssues, validateConfigBundle } from './validate'

function resumeIssue(issue: ConfigValidationIssue) {
  return (
    issue.path === '$.profile.resume' ||
    issue.path === '$.profile.resume.sourceHash' ||
    issue.path.startsWith('$.profile.resume.evidence')
  )
}

function assertEnabledJobSource(bundle: ConfigBundleV1) {
  const sources = bundle.settings.jobRules.sources
  const hasSearchSource =
    sources.searchEnabled && bundle.settings.jobRules.search.directions.length > 0
  if (hasSearchSource || sources.recommendEnabled || sources.enabledExpectations.length > 0) {
    return
  }
  throw new ConfigValidationError([
    {
      path: '$.settings.jobRules.sources',
      message: '$.settings.jobRules.sources: 导入配置至少需要开启一个岗位来源',
    },
  ])
}

export { hashResumeMarkdown } from '@/profile/resumeHash'

export function migrateConfigBundleToCurrent(value: unknown): ConfigBundleV1 {
  if (!isPlainObject(value)) {
    throw new ConfigValidationError([{ path: '$', message: '$: 配置必须是对象' }])
  }
  if (value.format !== CONFIG_FORMAT) {
    throw new ConfigValidationError([{ path: '$.format', message: '$.format: 配置格式不匹配' }])
  }
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigValidationError([
      {
        path: '$.schemaVersion',
        message: `$.schemaVersion: 暂不支持版本 ${String(value.schemaVersion)}`,
      },
    ])
  }

  return canonicalizeAiConfiguration(
    deepmerge(createDefaultConfigBundle(), value) as ConfigBundleV1,
  )
}

export async function prepareImportedConfigBundle(value: unknown): Promise<{
  bundle: ConfigBundleV1
  resumeEvidenceDiscarded: boolean
}> {
  const bundle = migrateConfigBundleToCurrent(value)
  assertEnabledJobSource(bundle)
  const issues = collectConfigBundleIssues(bundle)
  const nonResumeIssues = issues.filter((issue) => !resumeIssue(issue))
  if (nonResumeIssues.length > 0) throw new ConfigValidationError(nonResumeIssues)

  let resumeEvidenceDiscarded = issues.length > 0
  const resume = bundle.profile.resume
  if (!resume.markdown) {
    resume.sourceHash = null
    resume.evidence = null
  } else {
    const actualHash = await hashResumeMarkdown(resume.markdown)
    if (resume.sourceHash !== actualHash || issues.length > 0) {
      resume.sourceHash = null
      resume.evidence = null
      resumeEvidenceDiscarded = true
    }
  }

  return { bundle: validateConfigBundle(bundle), resumeEvidenceDiscarded }
}

export function parseConfigJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ConfigValidationError([{ path: '$', message: '$: JSON 语法错误' }])
  }
}

export function cloneConfigForTransfer(bundle: ConfigBundleV1) {
  return jsonClone(bundle)
}
