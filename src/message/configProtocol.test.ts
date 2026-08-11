import { describe, expect, it } from 'vitest'

import { createDefaultConfigBundle } from '@/config/defaults'
import {
  ConfigImportRunningError,
  ConfigMutationRunningError,
  ConfigValidationError,
} from '@/config/types'

import {
  CONFIG_REQUEST_TYPE,
  CONFIG_RESPONSE_TYPE,
  createConfigFailure,
  isConfigRequest,
  isConfigRevisionChangedMessage,
} from './configProtocol'

describe('configuration message protocol', () => {
  it('accepts only explicit configuration commands', () => {
    expect(
      isConfigRequest({
        type: CONFIG_REQUEST_TYPE,
        requestId: 'request-1',
        action: 'replace',
        uid: 'account-a',
        bundle: createDefaultConfigBundle(),
      }),
    ).toBe(true)
    expect(
      isConfigRequest({
        type: CONFIG_REQUEST_TYPE,
        requestId: 'request-model-test',
        action: 'test-model',
        uid: 'account-a',
        model: {},
      }),
    ).toBe(true)
    expect(
      isConfigRequest({
        type: CONFIG_REQUEST_TYPE,
        requestId: 'request-model-test-without-account',
        action: 'test-model',
        model: {},
      }),
    ).toBe(false)
    expect(
      isConfigRequest({
        type: CONFIG_REQUEST_TYPE,
        requestId: 'request-profile',
        action: 'save-profile-draft',
        uid: 'account-a',
        displayName: '候选人',
        markdown: '简历内容',
      }),
    ).toBe(true)
    expect(
      isConfigRequest({
        type: CONFIG_REQUEST_TYPE,
        requestId: 'request-profile-evidence',
        action: 'commit-profile-evidence',
        uid: 'account-a',
        markdown: '简历内容',
        evidence: {},
      }),
    ).toBe(true)
    expect(
      isConfigRequest({
        type: CONFIG_REQUEST_TYPE,
        requestId: 'request-profile-evidence-invalid',
        action: 'commit-profile-evidence',
        uid: 'account-a',
        markdown: '简历内容',
        evidence: null,
      }),
    ).toBe(false)
    expect(
      isConfigRequest({
        type: CONFIG_REQUEST_TYPE,
        requestId: 'request-2',
        action: 'read-storage',
        uid: 'account-a',
      }),
    ).toBe(false)
    expect(
      isConfigRequest({
        type: CONFIG_REQUEST_TYPE,
        requestId: 'request-ai',
        action: 'save-ai-config',
        models: [],
      }),
    ).toBe(true)
    expect(
      isConfigRequest({
        type: CONFIG_REQUEST_TYPE,
        requestId: 'request-ai-stale',
        action: 'save-ai-config',
        models: [],
        tasks: createDefaultConfigBundle().tasks,
      }),
    ).toBe(false)
  })

  it('returns validation paths without echoing submitted secret values', () => {
    const response = createConfigFailure(
      'request-3',
      new ConfigValidationError([
        { path: '$.models[0].apiKey', message: '$.models[0].apiKey: 长度无效' },
      ]),
    )
    expect(response).toEqual({
      type: CONFIG_RESPONSE_TYPE,
      requestId: 'request-3',
      ok: false,
      errorCode: 'CONFIG_VALIDATION_FAILED',
      error: '$.models[0].apiKey: 长度无效',
      issues: [{ path: '$.models[0].apiKey', message: '$.models[0].apiKey: 长度无效' }],
    })
    expect(JSON.stringify(response)).not.toContain('sk-secret')
  })

  it('validates public revision messages', () => {
    expect(
      isConfigRevisionChangedMessage({
        type: 'AGENT_DELIVERY_CONFIG_REVISION_CHANGED',
        configRevision: 2,
      }),
    ).toBe(true)
    expect(
      isConfigRevisionChangedMessage({
        type: 'AGENT_DELIVERY_CONFIG_REVISION_CHANGED',
        configRevision: '2',
      }),
    ).toBe(false)
  })

  it('reports a running-delivery import conflict without exposing submitted data', () => {
    expect(createConfigFailure('request-busy', new ConfigImportRunningError())).toMatchObject({
      ok: false,
      errorCode: 'CONFIG_IMPORT_BLOCKED',
      error: '投递正在运行，停止投递后才能导入配置',
    })
  })

  it('reports other running-delivery configuration conflicts with an actionable message', () => {
    expect(createConfigFailure('request-busy', new ConfigMutationRunningError())).toMatchObject({
      ok: false,
      errorCode: 'CONFIG_MUTATION_BLOCKED',
      error: '投递正在运行，仅可关闭 AI 招呼语，停止投递后才能修改其他配置',
    })
  })

  it('classifies model failures into safe actionable categories', () => {
    const authError = Object.assign(new Error('provider body: secret'), {
      diagnostics: { attempts: [{ status: 401 }] },
    })
    expect(createConfigFailure('request-auth', authError)).toMatchObject({
      errorCode: 'MODEL_AUTH_FAILED',
      error: '模型鉴权失败，请检查 API Key',
    })
    expect(JSON.stringify(createConfigFailure('request-auth', authError))).not.toContain('secret')

    const networkError = new Error('AI请求网络失败', {
      cause: new TypeError('Failed to fetch'),
    })
    expect(createConfigFailure('request-network', networkError)).toMatchObject({
      errorCode: 'MODEL_NETWORK_OR_PERMISSION',
    })

    const providerFailure = new Error(
      'AI流式响应返回失败事件：server_error: provider task failed with secret payload',
    )
    const response = createConfigFailure('request-provider-failed', providerFailure)
    expect(response).toMatchObject({
      errorCode: 'MODEL_TASK_FAILED',
      error: '模型任务执行失败（server_error）',
    })
    expect(JSON.stringify(response)).not.toContain('secret payload')

    const successfulStreamTimedOut = Object.assign(
      new Error('AI流式响应读取超时', {
        cause: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      }),
      {
        diagnostics: {
          attempts: [{ attempt: 1, durationMs: 180_000, ok: false, status: 200 }],
        },
      },
    )
    expect(createConfigFailure('request-stream-timeout', successfulStreamTimedOut)).toMatchObject({
      errorCode: 'MODEL_TIMEOUT',
      error: '模型请求超时',
    })
  })
})
