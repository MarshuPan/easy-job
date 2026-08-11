import type { ResumeEvidence } from '@/types/aiGreeting'
import { isPlainObject } from '@/utils/deepmerge'

import {
  CONFIG_LIMITS,
  DEFAULT_AI_FILTERING_SCORE,
  createDefaultDeliverySettings,
} from './defaults'
import {
  CONFIG_FORMAT,
  CONFIG_SCHEMA_VERSION,
  CONFIG_SETTINGS_SCOPE,
  ConfigValidationError,
  type ConfigBundleV1,
  type ConfigValidationIssue,
  type StoredConfigStateV1,
} from './types'

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const sourceHashPattern = /^sha256:[a-f0-9]{64}$/
const protocols = new Set(['openai-chat-completions', 'openai-responses', 'anthropic-messages'])
const backgroundModes = new Set(['auto', 'on', 'off'])
const ownershipValues = new Set(['led', 'owned', 'contributed', 'used', 'learned'])
const evidenceTypes = new Set(['direct_fact', 'self_claim', 'derived_capability', 'adjacent_only'])
const confidenceValues = new Set(['high', 'medium', 'low'])

type RecordValue = Record<string, unknown>

function childPath(path: string, key: string | number) {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`
}

function addIssue(issues: ConfigValidationIssue[], path: string, message: string) {
  issues.push({ path, message: `${path}: ${message}` })
}

function asRecord(value: unknown, path: string, issues: ConfigValidationIssue[]): RecordValue {
  if (!isPlainObject(value)) {
    addIssue(issues, path, '必须是对象')
    return {}
  }
  return value
}

function exactKeys(
  value: RecordValue,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  issues: ConfigValidationIssue[],
) {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      addIssue(issues, childPath(path, key), '缺少必填字段')
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addIssue(issues, childPath(path, key), '未知字段')
  }
}

function expectString(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  options: { min?: number; max?: number; pattern?: RegExp } = {},
) {
  if (typeof value !== 'string') {
    addIssue(issues, path, '必须是字符串')
    return ''
  }
  if (options.min != null && value.length < options.min) {
    addIssue(issues, path, `长度不能小于 ${options.min}`)
  }
  if (options.max != null && value.length > options.max) {
    addIssue(issues, path, `长度不能超过 ${options.max}`)
  }
  if (options.pattern && !options.pattern.test(value)) {
    addIssue(issues, path, '格式无效')
  }
  return value
}

function expectBoolean(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  if (typeof value !== 'boolean') addIssue(issues, path, '必须是布尔值')
  return value === true
}

function expectNumber(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  options: { integer?: boolean; min?: number; max?: number } = {},
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addIssue(issues, path, '必须是有限数字')
    return 0
  }
  if (options.integer && !Number.isInteger(value)) addIssue(issues, path, '必须是整数')
  if (options.min != null && value < options.min) {
    addIssue(issues, path, `不能小于 ${options.min}`)
  }
  if (options.max != null && value > options.max) {
    addIssue(issues, path, `不能大于 ${options.max}`)
  }
  return value
}

function expectArray(value: unknown, path: string, issues: ConfigValidationIssue[], max = 200) {
  if (!Array.isArray(value)) {
    addIssue(issues, path, '必须是数组')
    return [] as unknown[]
  }
  if (value.length > max) addIssue(issues, path, `不能超过 ${max} 项`)
  return value
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  options: { itemMax?: number; max?: number; minItem?: number; unique?: boolean } = {},
) {
  const result = expectArray(value, path, issues, options.max ?? CONFIG_LIMITS.arrayItems)
  const seen = new Set<string>()
  result.forEach((item, index) => {
    const itemPath = childPath(path, index)
    const text = expectString(item, itemPath, issues, {
      min: options.minItem ?? 1,
      max: options.itemMax ?? 256,
    })
    if (options.unique !== false && text) {
      if (seen.has(text)) addIssue(issues, itemPath, '不能重复')
      seen.add(text)
    }
  })
  return result
}

function validateTargetValue(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  if (
    value == null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (typeof value === 'string') {
    expectString(value, path, issues, { max: 1024 })
    return
  }
  if (Array.isArray(value)) {
    validateStringArray(value, path, issues, { itemMax: 256 })
    return
  }
  addIssue(issues, path, '只允许字符串、数字、布尔值、null 或字符串数组')
}

function validateResumeMetric(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  const metric = asRecord(value, path, issues)
  exactKeys(metric, path, ['name', 'value'], ['period'], issues)
  expectString(metric.name, childPath(path, 'name'), issues, { max: 256 })
  expectString(metric.value, childPath(path, 'value'), issues, { max: 256 })
  if ('period' in metric) {
    expectString(metric.period, childPath(path, 'period'), issues, { max: 256 })
  }
}

function validateResumeEvidence(
  value: unknown,
  markdown: string,
  path: string,
  issues: ConfigValidationIssue[],
) {
  const evidence = asRecord(value, path, issues)
  exactKeys(evidence, path, ['facts', 'buckets', 'claimPolicy'], ['name', 'target'], issues)
  if ('name' in evidence) {
    expectString(evidence.name, childPath(path, 'name'), issues, { max: 128 })
  }
  if ('target' in evidence) {
    const target = asRecord(evidence.target, childPath(path, 'target'), issues)
    if (Object.keys(target).length > 50) {
      addIssue(issues, childPath(path, 'target'), '不能超过 50 个字段')
    }
    for (const [key, targetValue] of Object.entries(target)) {
      validateTargetValue(targetValue, childPath(childPath(path, 'target'), key), issues)
    }
  }

  const facts = expectArray(
    evidence.facts,
    childPath(path, 'facts'),
    issues,
    CONFIG_LIMITS.arrayItems,
  )
  const factIds = new Set<string>()
  facts.forEach((item, index) => {
    const factPath = childPath(childPath(path, 'facts'), index)
    const fact = asRecord(item, factPath, issues)
    exactKeys(
      fact,
      factPath,
      [
        'id',
        'sourceQuote',
        'action',
        'object',
        'ownership',
        'domains',
        'skills',
        'evidenceType',
        'allowedClaimVerbs',
        'confidence',
      ],
      ['company', 'role', 'start', 'end', 'metrics'],
      issues,
    )
    const id = expectString(fact.id, childPath(factPath, 'id'), issues, {
      min: 1,
      max: 128,
      pattern: identifierPattern,
    })
    if (id) {
      if (factIds.has(id)) addIssue(issues, childPath(factPath, 'id'), '事实 ID 不能重复')
      factIds.add(id)
    }
    const quote = expectString(fact.sourceQuote, childPath(factPath, 'sourceQuote'), issues, {
      min: 1,
      max: 4096,
    })
    if (markdown && quote && !markdown.includes(quote)) {
      addIssue(issues, childPath(factPath, 'sourceQuote'), '必须能在当前简历原文中找到')
    }
    for (const key of ['company', 'role', 'start', 'end'] as const) {
      if (key in fact) expectString(fact[key], childPath(factPath, key), issues, { max: 256 })
    }
    expectString(fact.action, childPath(factPath, 'action'), issues, { min: 1, max: 1024 })
    expectString(fact.object, childPath(factPath, 'object'), issues, { min: 1, max: 1024 })
    const ownership = expectString(fact.ownership, childPath(factPath, 'ownership'), issues)
    if (ownership && !ownershipValues.has(ownership)) {
      addIssue(issues, childPath(factPath, 'ownership'), '枚举值无效')
    }
    if ('metrics' in fact) {
      expectArray(fact.metrics, childPath(factPath, 'metrics'), issues, 50).forEach(
        (metric, metricIndex) =>
          validateResumeMetric(
            metric,
            childPath(childPath(factPath, 'metrics'), metricIndex),
            issues,
          ),
      )
    }
    validateStringArray(fact.domains, childPath(factPath, 'domains'), issues)
    validateStringArray(fact.skills, childPath(factPath, 'skills'), issues)
    const evidenceType = expectString(
      fact.evidenceType,
      childPath(factPath, 'evidenceType'),
      issues,
    )
    if (evidenceType && !evidenceTypes.has(evidenceType)) {
      addIssue(issues, childPath(factPath, 'evidenceType'), '枚举值无效')
    }
    validateStringArray(fact.allowedClaimVerbs, childPath(factPath, 'allowedClaimVerbs'), issues)
    const confidence = expectString(fact.confidence, childPath(factPath, 'confidence'), issues)
    if (confidence && !confidenceValues.has(confidence)) {
      addIssue(issues, childPath(factPath, 'confidence'), '枚举值无效')
    }
  })

  const buckets = expectArray(
    evidence.buckets,
    childPath(path, 'buckets'),
    issues,
    CONFIG_LIMITS.arrayItems,
  )
  const bucketIds = new Set<string>()
  buckets.forEach((item, index) => {
    const bucketPath = childPath(childPath(path, 'buckets'), index)
    const bucket = asRecord(item, bucketPath, issues)
    exactKeys(bucket, bucketPath, ['id', 'signals', 'factIds'], [], issues)
    const id = expectString(bucket.id, childPath(bucketPath, 'id'), issues, {
      min: 1,
      max: 128,
      pattern: identifierPattern,
    })
    if (id) {
      if (bucketIds.has(id)) addIssue(issues, childPath(bucketPath, 'id'), 'bucket ID 不能重复')
      bucketIds.add(id)
    }
    expectArray(
      bucket.signals,
      childPath(bucketPath, 'signals'),
      issues,
      CONFIG_LIMITS.arrayItems,
    ).forEach((signalValue, signalIndex) => {
      const signalPath = childPath(childPath(bucketPath, 'signals'), signalIndex)
      const signal = asRecord(signalValue, signalPath, issues)
      exactKeys(signal, signalPath, ['value', 'weight'], [], issues)
      expectString(signal.value, childPath(signalPath, 'value'), issues, { min: 1, max: 256 })
      expectNumber(signal.weight, childPath(signalPath, 'weight'), issues, {
        min: -1000,
        max: 1000,
      })
    })
    const bucketFactIds = validateStringArray(
      bucket.factIds,
      childPath(bucketPath, 'factIds'),
      issues,
    )
    for (const factId of bucketFactIds) {
      if (typeof factId === 'string' && !factIds.has(factId)) {
        addIssue(issues, childPath(bucketPath, 'factIds'), `引用了不存在的事实 ID: ${factId}`)
      }
    }
  })

  const claimPolicyPath = childPath(path, 'claimPolicy')
  const claimPolicy = asRecord(evidence.claimPolicy, claimPolicyPath, issues)
  exactKeys(claimPolicy, claimPolicyPath, ['adjacentOnly', 'forbiddenClaims'], [], issues)
  validateStringArray(claimPolicy.adjacentOnly, childPath(claimPolicyPath, 'adjacentOnly'), issues)
  validateStringArray(
    claimPolicy.forbiddenClaims,
    childPath(claimPolicyPath, 'forbiddenClaims'),
    issues,
  )
}

export function validateResumeEvidenceForMarkdown(
  markdown: string,
  value: unknown,
): ResumeEvidence {
  const issues: ConfigValidationIssue[] = []
  expectString(markdown, '$.profile.resume.markdown', issues, {
    max: CONFIG_LIMITS.resumeCharacters,
  })
  validateResumeEvidence(value, markdown, '$.profile.resume.evidence', issues)
  if (issues.length > 0) throw new ConfigValidationError(issues)
  return value as ResumeEvidence
}

function validateProfile(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  const profile = asRecord(value, path, issues)
  exactKeys(profile, path, ['displayName', 'resume'], [], issues)
  expectString(profile.displayName, childPath(path, 'displayName'), issues, {
    max: CONFIG_LIMITS.displayNameCharacters,
  })
  const resumePath = childPath(path, 'resume')
  const resume = asRecord(profile.resume, resumePath, issues)
  exactKeys(
    resume,
    resumePath,
    ['markdown', 'sourceHash', 'evidenceVersion', 'evidence'],
    [],
    issues,
  )
  const markdown = expectString(resume.markdown, childPath(resumePath, 'markdown'), issues, {
    max: CONFIG_LIMITS.resumeCharacters,
  })
  if (resume.sourceHash !== null) {
    expectString(resume.sourceHash, childPath(resumePath, 'sourceHash'), issues, {
      pattern: sourceHashPattern,
    })
  }
  expectNumber(resume.evidenceVersion, childPath(resumePath, 'evidenceVersion'), issues, {
    integer: true,
    min: 1,
    max: 1000,
  })
  if (!markdown && (resume.sourceHash != null || resume.evidence != null)) {
    addIssue(issues, resumePath, '空简历不能携带 sourceHash 或结构化证据')
  }
  if (resume.evidence != null) {
    if (resume.sourceHash == null) {
      addIssue(issues, childPath(resumePath, 'sourceHash'), '有结构化证据时不能为空')
    }
    validateResumeEvidence(resume.evidence, markdown, childPath(resumePath, 'evidence'), issues)
  }
}

function validateGeneration(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  const generation = asRecord(value, path, issues)
  exactKeys(
    generation,
    path,
    ['temperature', 'topP', 'presencePenalty', 'frequencyPenalty'],
    [],
    issues,
  )
  const rules: Array<[string, number, number]> = [
    ['temperature', 0, 2],
    ['topP', 0, 1],
    ['presencePenalty', -2, 2],
    ['frequencyPenalty', -2, 2],
  ]
  for (const [key, min, max] of rules) {
    if (generation[key] !== null) {
      expectNumber(generation[key], childPath(path, key), issues, { min, max })
    }
  }
}

function validateModels(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  const models = expectArray(value, path, issues, CONFIG_LIMITS.modelCount)
  const ids = new Set<string>()
  models.forEach((item, index) => {
    const modelPath = childPath(path, index)
    const model = asRecord(item, modelPath, issues)
    exactKeys(
      model,
      modelPath,
      [
        'id',
        'name',
        'protocol',
        'url',
        'apiKey',
        'model',
        'reasoningEffort',
        'timeoutSeconds',
        'responsesBackground',
        'generation',
      ],
      ['color'],
      issues,
    )
    const id = expectString(model.id, childPath(modelPath, 'id'), issues, {
      min: 1,
      max: 128,
      pattern: identifierPattern,
    })
    if (id) {
      if (ids.has(id)) addIssue(issues, childPath(modelPath, 'id'), '模型 ID 不能重复')
      ids.add(id)
    }
    expectString(model.name, childPath(modelPath, 'name'), issues, { min: 1, max: 128 })
    if ('color' in model) {
      expectString(model.color, childPath(modelPath, 'color'), issues, { max: 32 })
    }
    const protocol = expectString(model.protocol, childPath(modelPath, 'protocol'), issues)
    if (protocol && !protocols.has(protocol)) {
      addIssue(issues, childPath(modelPath, 'protocol'), '协议无效')
    }
    const url = expectString(model.url, childPath(modelPath, 'url'), issues, {
      min: 8,
      max: CONFIG_LIMITS.urlCharacters,
    })
    if (url) {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          addIssue(issues, childPath(modelPath, 'url'), '只支持完整 HTTP 或 HTTPS URL')
        }
      } catch {
        addIssue(issues, childPath(modelPath, 'url'), '不是合法完整 URL')
      }
    }
    expectString(model.apiKey, childPath(modelPath, 'apiKey'), issues, {
      max: CONFIG_LIMITS.apiKeyCharacters,
    })
    expectString(model.model, childPath(modelPath, 'model'), issues, { min: 1, max: 256 })
    expectString(model.reasoningEffort, childPath(modelPath, 'reasoningEffort'), issues, {
      max: 64,
    })
    expectNumber(model.timeoutSeconds, childPath(modelPath, 'timeoutSeconds'), issues, {
      integer: true,
      min: 1,
      max: 1800,
    })
    const backgroundMode = expectString(
      model.responsesBackground,
      childPath(modelPath, 'responsesBackground'),
      issues,
    )
    if (backgroundMode && !backgroundModes.has(backgroundMode)) {
      addIssue(issues, childPath(modelPath, 'responsesBackground'), '后台模式无效')
    }
    validateGeneration(model.generation, childPath(modelPath, 'generation'), issues)
  })
  return ids
}

function validateNullableModelId(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  if (value === null) return null
  return expectString(value, path, issues, {
    min: 1,
    max: 128,
    pattern: identifierPattern,
  })
}

function validateTasks(
  value: unknown,
  path: string,
  modelIds: Set<string>,
  issues: ConfigValidationIssue[],
) {
  const tasks = asRecord(value, path, issues)
  exactKeys(tasks, path, ['resumeExtraction', 'aiFiltering', 'aiGreeting'], [], issues)

  const extractionPath = childPath(path, 'resumeExtraction')
  const extraction = asRecord(tasks.resumeExtraction, extractionPath, issues)
  exactKeys(extraction, extractionPath, ['modelId'], [], issues)
  const extractionModelId = validateNullableModelId(
    extraction.modelId,
    childPath(extractionPath, 'modelId'),
    issues,
  )

  const filteringPath = childPath(path, 'aiFiltering')
  const filtering = asRecord(tasks.aiFiltering, filteringPath, issues)
  exactKeys(filtering, filteringPath, ['enabled', 'modelId', 'score', 'prompt'], [], issues)
  const filteringEnabled = expectBoolean(
    filtering.enabled,
    childPath(filteringPath, 'enabled'),
    issues,
  )
  const filteringModelId = validateNullableModelId(
    filtering.modelId,
    childPath(filteringPath, 'modelId'),
    issues,
  )
  expectNumber(filtering.score, childPath(filteringPath, 'score'), issues, {
    integer: true,
    min: 0,
    max: 100,
  })
  expectString(filtering.prompt, childPath(filteringPath, 'prompt'), issues, {
    max: CONFIG_LIMITS.promptCharacters,
  })

  const greetingPath = childPath(path, 'aiGreeting')
  const greeting = asRecord(tasks.aiGreeting, greetingPath, issues)
  exactKeys(
    greeting,
    greetingPath,
    ['enabled', 'modelId', 'messageCount', 'minTotalCharacters', 'maxTotalCharacters', 'prompt'],
    [],
    issues,
  )
  const greetingEnabled = expectBoolean(
    greeting.enabled,
    childPath(greetingPath, 'enabled'),
    issues,
  )
  const greetingModelId = validateNullableModelId(
    greeting.modelId,
    childPath(greetingPath, 'modelId'),
    issues,
  )
  expectNumber(greeting.messageCount, childPath(greetingPath, 'messageCount'), issues, {
    integer: true,
    min: 1,
    max: 5,
  })
  const minCharacters = expectNumber(
    greeting.minTotalCharacters,
    childPath(greetingPath, 'minTotalCharacters'),
    issues,
    { integer: true, min: 20, max: 500 },
  )
  const maxCharacters = expectNumber(
    greeting.maxTotalCharacters,
    childPath(greetingPath, 'maxTotalCharacters'),
    issues,
    { integer: true, min: 20, max: 500 },
  )
  if (minCharacters > maxCharacters) {
    addIssue(issues, greetingPath, '最少总字数不能大于最多总字数')
  }
  expectString(greeting.prompt, childPath(greetingPath, 'prompt'), issues, {
    max: CONFIG_LIMITS.promptCharacters,
  })

  for (const [taskName, modelId] of [
    ['resumeExtraction', extractionModelId],
    ['aiFiltering', filteringModelId],
    ['aiGreeting', greetingModelId],
  ] as const) {
    if (modelId && !modelIds.has(modelId)) {
      addIssue(issues, childPath(childPath(path, taskName), 'modelId'), '引用的模型不存在')
    }
  }
  if (filteringEnabled && filteringModelId == null) {
    addIssue(issues, childPath(filteringPath, 'modelId'), 'AI 匹配开启时必须选择模型')
  }
  if (greetingEnabled && greetingModelId == null) {
    addIssue(issues, childPath(greetingPath, 'modelId'), 'AI 招呼语开启时必须选择模型')
  }
}

function validateKeywordRule(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  const rule = asRecord(value, path, issues)
  exactKeys(rule, path, ['enabled', 'mode', 'values', 'options'], [], issues)
  expectBoolean(rule.enabled, childPath(path, 'enabled'), issues)
  const mode = expectString(rule.mode, childPath(path, 'mode'), issues)
  if (mode !== 'include' && mode !== 'exclude') {
    addIssue(issues, childPath(path, 'mode'), '必须是 include 或 exclude')
  }
  validateStringArray(rule.values, childPath(path, 'values'), issues)
  validateStringArray(rule.options, childPath(path, 'options'), issues)
}

function validateRangeTuple(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  const range = expectArray(value, path, issues, 3)
  if (range.length !== 3) addIssue(issues, path, '必须包含最小值、最大值和严格模式')
  const min = expectNumber(range[0], childPath(path, 0), issues, { min: 0, max: 10_000_000 })
  const max = expectNumber(range[1], childPath(path, 1), issues, { min: 0, max: 10_000_000 })
  expectBoolean(range[2], childPath(path, 2), issues)
  if (min > max) addIssue(issues, path, '最小值不能大于最大值')
}

function validateSettings(value: unknown, path: string, issues: ConfigValidationIssue[]) {
  const settings = asRecord(value, path, issues)
  exactKeys(
    settings,
    path,
    ['jobRules', 'filters', 'delivery', 'commute', 'appearance'],
    [],
    issues,
  )

  const jobRulesPath = childPath(path, 'jobRules')
  const jobRules = asRecord(settings.jobRules, jobRulesPath, issues)
  exactKeys(jobRules, jobRulesPath, ['sources', 'sourceWeights', 'search'], [], issues)

  const sourcesPath = childPath(jobRulesPath, 'sources')
  const sources = asRecord(jobRules.sources, sourcesPath, issues)
  exactKeys(
    sources,
    sourcesPath,
    ['searchEnabled', 'recommendEnabled', 'expectationsInitialized', 'enabledExpectations'],
    [],
    issues,
  )
  expectBoolean(sources.searchEnabled, childPath(sourcesPath, 'searchEnabled'), issues)
  expectBoolean(sources.recommendEnabled, childPath(sourcesPath, 'recommendEnabled'), issues)
  expectBoolean(
    sources.expectationsInitialized,
    childPath(sourcesPath, 'expectationsInitialized'),
    issues,
  )
  const expectationIds = new Set<string>()
  expectArray(
    sources.enabledExpectations,
    childPath(sourcesPath, 'enabledExpectations'),
    issues,
    CONFIG_LIMITS.arrayItems,
  ).forEach((item, index) => {
    const expectationPath = childPath(childPath(sourcesPath, 'enabledExpectations'), index)
    const expectation = asRecord(item, expectationPath, issues)
    exactKeys(
      expectation,
      expectationPath,
      ['id', 'positionName', 'locationName', 'salaryDesc'],
      [],
      issues,
    )
    const id = expectString(expectation.id, childPath(expectationPath, 'id'), issues, {
      min: 1,
      max: 128,
    })
    if (id) {
      if (expectationIds.has(id)) {
        addIssue(issues, childPath(expectationPath, 'id'), '求职期望 ID 不能重复')
      }
      expectationIds.add(id)
    }
    for (const key of ['positionName', 'locationName', 'salaryDesc'] as const) {
      expectString(expectation[key], childPath(expectationPath, key), issues, { max: 256 })
    }
  })

  const weightsPath = childPath(jobRulesPath, 'sourceWeights')
  const weights = asRecord(jobRules.sourceWeights, weightsPath, issues)
  exactKeys(weights, weightsPath, ['search', 'expectations'], [], issues)
  const searchWeight = expectNumber(weights.search, childPath(weightsPath, 'search'), issues, {
    integer: true,
    min: 0,
    max: 100,
  })
  const expectationWeight = expectNumber(
    weights.expectations,
    childPath(weightsPath, 'expectations'),
    issues,
    { integer: true, min: 0, max: 100 },
  )
  if (searchWeight + expectationWeight !== 100) {
    addIssue(issues, weightsPath, '搜索与求职期望来源比例之和必须为 100')
  }

  const searchPath = childPath(jobRulesPath, 'search')
  const search = asRecord(jobRules.search, searchPath, issues)
  exactKeys(
    search,
    searchPath,
    ['directions', 'city', 'salary', 'experience', 'degree', 'jobType'],
    [],
    issues,
  )
  validateStringArray(search.directions, childPath(searchPath, 'directions'), issues, { max: 20 })
  expectString(search.city, childPath(searchPath, 'city'), issues, { max: 64 })
  expectString(search.salary, childPath(searchPath, 'salary'), issues, { max: 64 })
  validateStringArray(search.experience, childPath(searchPath, 'experience'), issues)
  validateStringArray(search.degree, childPath(searchPath, 'degree'), issues)
  validateStringArray(search.jobType, childPath(searchPath, 'jobType'), issues)

  const filtersPath = childPath(path, 'filters')
  const filters = asRecord(settings.filters, filtersPath, issues)
  exactKeys(
    filters,
    filtersPath,
    [
      'jobContent',
      'companySizeRange',
      'activity',
      'friendStatus',
      'sameCompany',
      'sameHr',
      'goldHunter',
    ],
    [],
    issues,
  )
  validateKeywordRule(filters.jobContent, childPath(filtersPath, 'jobContent'), issues)
  const companySizePath = childPath(filtersPath, 'companySizeRange')
  const companySize = asRecord(filters.companySizeRange, companySizePath, issues)
  exactKeys(companySize, companySizePath, ['enabled', 'range'], [], issues)
  expectBoolean(companySize.enabled, childPath(companySizePath, 'enabled'), issues)
  validateRangeTuple(companySize.range, childPath(companySizePath, 'range'), issues)
  for (const key of ['activity', 'friendStatus', 'sameCompany', 'sameHr', 'goldHunter'] as const) {
    expectBoolean(filters[key], childPath(filtersPath, key), issues)
  }

  const deliveryPath = childPath(path, 'delivery')
  const delivery = asRecord(settings.delivery, deliveryPath, issues)
  exactKeys(delivery, deliveryPath, ['customGreeting', 'useCache', 'timing'], [], issues)
  const customGreetingPath = childPath(deliveryPath, 'customGreeting')
  const customGreeting = asRecord(delivery.customGreeting, customGreetingPath, issues)
  exactKeys(customGreeting, customGreetingPath, ['enabled', 'value'], [], issues)
  expectBoolean(customGreeting.enabled, childPath(customGreetingPath, 'enabled'), issues)
  expectString(customGreeting.value, childPath(customGreetingPath, 'value'), issues, { max: 2000 })
  expectBoolean(delivery.useCache, childPath(deliveryPath, 'useCache'), issues)
  const timingPath = childPath(deliveryPath, 'timing')
  const timing = asRecord(delivery.timing, timingPath, issues)
  exactKeys(
    timing,
    timingPath,
    [
      'initialDelaySeconds',
      'minJobIntervalSeconds',
      'maxJobIntervalSeconds',
      'nextPageDelaySeconds',
      'messageSendDelaySeconds',
      'greetingSegmentSeconds',
      'batchSize',
      'batchRestMinutes',
    ],
    [],
    issues,
  )
  const timingRules: Array<[string, number, number]> = [
    ['initialDelaySeconds', 0, 3600],
    ['minJobIntervalSeconds', 0, 86400],
    ['maxJobIntervalSeconds', 0, 86400],
    ['nextPageDelaySeconds', 0, 86400],
    ['messageSendDelaySeconds', 0, 86400],
    ['greetingSegmentSeconds', 0, 600],
    ['batchSize', 1, 1000],
    ['batchRestMinutes', 0, 1440],
  ]
  for (const [key, min, max] of timingRules) {
    expectNumber(timing[key], childPath(timingPath, key), issues, {
      integer: true,
      min,
      max,
    })
  }
  if (
    typeof timing.minJobIntervalSeconds === 'number' &&
    typeof timing.maxJobIntervalSeconds === 'number' &&
    timing.minJobIntervalSeconds > timing.maxJobIntervalSeconds
  ) {
    addIssue(issues, timingPath, '最小投递间隔不能大于最大投递间隔')
  }

  const commutePath = childPath(path, 'commute')
  const commute = asRecord(settings.commute, commutePath, issues)
  exactKeys(
    commute,
    commutePath,
    [
      'enabled',
      'apiKey',
      'origin',
      'straightDistanceKm',
      'drivingDistanceKm',
      'drivingDurationMinutes',
      'walkingDistanceKm',
      'walkingDurationMinutes',
    ],
    [],
    issues,
  )
  expectBoolean(commute.enabled, childPath(commutePath, 'enabled'), issues)
  expectString(commute.apiKey, childPath(commutePath, 'apiKey'), issues, {
    max: CONFIG_LIMITS.apiKeyCharacters,
  })
  expectString(commute.origin, childPath(commutePath, 'origin'), issues, { max: 1024 })
  for (const key of [
    'straightDistanceKm',
    'drivingDistanceKm',
    'drivingDurationMinutes',
    'walkingDistanceKm',
    'walkingDurationMinutes',
  ] as const) {
    expectNumber(commute[key], childPath(commutePath, key), issues, { min: 0, max: 100_000 })
  }

  const appearancePath = childPath(path, 'appearance')
  const appearance = asRecord(settings.appearance, appearancePath, issues)
  exactKeys(appearance, appearancePath, ['hideHeader', 'listSink'], [], issues)
  expectBoolean(appearance.hideHeader, childPath(appearancePath, 'hideHeader'), issues)
  expectBoolean(appearance.listSink, childPath(appearancePath, 'listSink'), issues)
}

export function collectConfigBundleIssues(value: unknown): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = []
  const root = asRecord(value, '$', issues)
  exactKeys(
    root,
    '$',
    [
      'format',
      'schemaVersion',
      'appVersion',
      'exportedAt',
      'containsSecrets',
      'settingsScope',
      'profile',
      'models',
      'tasks',
      'settings',
    ],
    [],
    issues,
  )
  if (root.format !== CONFIG_FORMAT) addIssue(issues, '$.format', '配置格式不匹配')
  if (root.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    addIssue(issues, '$.schemaVersion', `只支持版本 ${CONFIG_SCHEMA_VERSION}`)
  }
  expectString(root.appVersion, '$.appVersion', issues, { min: 1, max: 64 })
  const exportedAt = expectString(root.exportedAt, '$.exportedAt', issues, { min: 1, max: 64 })
  if (exportedAt && !Number.isFinite(Date.parse(exportedAt))) {
    addIssue(issues, '$.exportedAt', '必须是 ISO 日期时间')
  }
  if (root.containsSecrets !== true) addIssue(issues, '$.containsSecrets', '必须为 true')
  if (root.settingsScope !== CONFIG_SETTINGS_SCOPE) {
    addIssue(issues, '$.settingsScope', '必须绑定当前活动 BOSS 账号')
  }
  validateProfile(root.profile, '$.profile', issues)
  const modelIds = validateModels(root.models, '$.models', issues)
  validateTasks(root.tasks, '$.tasks', modelIds, issues)
  validateSettings(root.settings, '$.settings', issues)
  return issues
}

export function validateConfigBundle(value: unknown): ConfigBundleV1 {
  const issues = collectConfigBundleIssues(value)
  if (issues.length > 0) throw new ConfigValidationError(issues)
  return value as ConfigBundleV1
}

export function validateAiModelConfig(value: unknown) {
  const bundle = createDefaultConfigBundleForModel(value)
  validateConfigBundle(bundle)
  return value as import('./types').AiModelConfig
}

function createDefaultConfigBundleForModel(value: unknown): ConfigBundleV1 {
  return {
    format: CONFIG_FORMAT,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    appVersion: 'model-validation',
    exportedAt: new Date(0).toISOString(),
    containsSecrets: true,
    settingsScope: CONFIG_SETTINGS_SCOPE,
    profile: {
      displayName: '',
      resume: { markdown: '', sourceHash: null, evidenceVersion: 1, evidence: null },
    },
    models: [value as import('./types').AiModelConfig],
    tasks: {
      resumeExtraction: { modelId: null },
      aiFiltering: {
        enabled: false,
        modelId: null,
        score: DEFAULT_AI_FILTERING_SCORE,
        prompt: '',
      },
      aiGreeting: {
        enabled: false,
        modelId: null,
        messageCount: 3,
        minTotalCharacters: 125,
        maxTotalCharacters: 175,
        prompt: '',
      },
    },
    settings: createDefaultDeliverySettings(),
  }
}

export function assertConfigImportSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new ConfigValidationError([{ path: '$', message: '配置文件大小无效' }])
  }
  if (sizeBytes > CONFIG_LIMITS.importFileBytes) {
    throw new ConfigValidationError([
      {
        path: '$',
        message: `配置文件不能超过 ${CONFIG_LIMITS.importFileBytes} 字节`,
      },
    ])
  }
}

export function validateStoredConfigState(value: unknown): StoredConfigStateV1 {
  const issues: ConfigValidationIssue[] = []
  const state = asRecord(value, '$', issues)
  exactKeys(
    state,
    '$',
    ['schemaVersion', 'configRevision', 'profile', 'models', 'tasks', 'accountSettings'],
    [],
    issues,
  )
  if (state.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    addIssue(issues, '$.schemaVersion', `只支持版本 ${CONFIG_SCHEMA_VERSION}`)
  }
  expectNumber(state.configRevision, '$.configRevision', issues, {
    integer: true,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  })
  const accountSettings = asRecord(state.accountSettings, '$.accountSettings', issues)
  if (Object.keys(accountSettings).length > CONFIG_LIMITS.arrayItems) {
    addIssue(issues, '$.accountSettings', `不能超过 ${CONFIG_LIMITS.arrayItems} 个账号`)
  }
  const settingsEntries = Object.entries(accountSettings)
  for (const [uid] of settingsEntries) {
    if (!uid || uid.length > 128) addIssue(issues, `$.accountSettings.${uid}`, '账号 UID 无效')
  }
  const firstSettings = settingsEntries[0]?.[1] ?? createDefaultDeliverySettings()
  const bundle = {
    format: CONFIG_FORMAT,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    appVersion: 'stored-state',
    exportedAt: new Date(0).toISOString(),
    containsSecrets: true,
    settingsScope: CONFIG_SETTINGS_SCOPE,
    profile: state.profile,
    models: state.models,
    tasks: state.tasks,
    settings: firstSettings,
  }
  issues.push(...collectConfigBundleIssues(bundle))
  for (const [uid, settings] of settingsEntries.slice(1)) {
    const settingsIssues: ConfigValidationIssue[] = []
    validateSettings(settings, `$.accountSettings.${uid}`, settingsIssues)
    issues.push(...settingsIssues)
  }
  if (issues.length > 0) throw new ConfigValidationError(issues)
  return value as StoredConfigStateV1
}
