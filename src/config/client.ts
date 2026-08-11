import { browser } from 'wxt/browser'

import type { ResumeDraftResult, ResumeSaveResult } from '@/background/configService'
import { appendAccountRuntimeLog, createAccountAiRuntimeLogger } from '@/background/runtimeLogs'
import type { AiModelConfig, ConfigBundleV1 } from '@/config/types'
import {
  CONFIG_REQUEST_TYPE,
  createConfigFailure,
  isConfigResponse,
  type ConfigResponseData,
} from '@/message/configProtocol'
import { extractResumeEvidence } from '@/profile/resumeExtraction'
import { toStructuredCloneSafeValue } from '@/utils/safeJson'

export class ConfigClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message)
    this.name = 'ConfigClientError'
  }
}

function createBackgroundDisconnectedError() {
  return new ConfigClientError('插件后台连接中断', 'CONFIG_BACKGROUND_DISCONNECTED')
}

function normalizeConfigTransportError(error: unknown) {
  if (error instanceof ConfigClientError) return error
  return createBackgroundDisconnectedError()
}

async function sendConfigRequest<T extends ConfigResponseData>(
  request: Record<string, unknown>,
): Promise<T> {
  const requestId = crypto.randomUUID()
  const response = await Promise.resolve()
    .then(() =>
      browser.runtime.sendMessage(
        browser.runtime.id,
        toStructuredCloneSafeValue({
          ...request,
          type: CONFIG_REQUEST_TYPE,
          requestId,
        }),
      ),
    )
    .catch((error) => {
      throw normalizeConfigTransportError(error)
    })
  if (!isConfigResponse(response) || response.requestId !== requestId) {
    throw new ConfigClientError('配置后台返回格式无效', 'CONFIG_RESPONSE_INVALID')
  }
  if (!response.ok) {
    throw new ConfigClientError(response.error, response.errorCode, response.issues ?? [])
  }
  return response.data as T
}

async function appendResumeWorkflowLog(args: {
  uid: string
  state: 'success' | 'danger'
  stateName: '解析成功' | '解析失败'
  message: string
  durationMs: number
  detail: Record<string, unknown>
}) {
  await appendAccountRuntimeLog(args.uid, {
    title: '简历解析',
    state: args.state,
    state_name: args.stateName,
    message: args.message,
    data: {
      trace: [
        {
          at: Date.now(),
          stage: '简历解析',
          status: args.state,
          message: args.message,
          detail: {
            durationMs: args.durationMs,
            transport: 'options-page',
            ...args.detail,
          },
        },
      ],
    },
  })
}

function normalizeResumeExtractionError(error: unknown) {
  if (error instanceof ConfigClientError) return error
  const failure = createConfigFailure('local-resume-extraction', error)
  return failure.ok
    ? new ConfigClientError('简历解析失败', 'MODEL_TASK_FAILED')
    : new ConfigClientError(failure.error, failure.errorCode, failure.issues ?? [])
}

export function getConfigBundle(uid: string) {
  return sendConfigRequest<ConfigBundleV1>({ action: 'get', uid })
}

export function replaceConfigBundle(uid: string, bundle: ConfigBundleV1) {
  return sendConfigRequest({ action: 'replace', uid, bundle })
}

export function saveAiConfiguration(models: ConfigBundleV1['models']) {
  return sendConfigRequest({ action: 'save-ai-config', models })
}

export function importConfigJson(uid: string, text: string, sizeBytes: number) {
  return sendConfigRequest({ action: 'import-json', uid, text, sizeBytes })
}

export function resetAllConfig(uid: string) {
  return sendConfigRequest({ action: 'reset-all', uid })
}

export function testAiModel(uid: string, model: AiModelConfig) {
  return sendConfigRequest<{
    ok: true
    durationMs: number
    model: string
    protocol: AiModelConfig['protocol']
  }>({
    action: 'test-model',
    uid,
    model,
  })
}

export async function saveProfileAndExtract(
  uid: string,
  displayName: string,
  markdown: string,
  model: AiModelConfig,
) {
  const startedAt = Date.now()
  const draft = await sendConfigRequest<ResumeDraftResult>({
    action: 'save-profile-draft',
    uid,
    displayName,
    markdown,
  })
  if (draft.status === 'ready') {
    try {
      await appendResumeWorkflowLog({
        uid,
        state: 'success',
        stateName: '解析成功',
        message: '解析成功',
        durationMs: Date.now() - startedAt,
        detail: {
          evidenceVersion: draft.evidenceVersion,
          factCount: draft.factCount,
          reused: true,
        },
      })
    } catch {
      // Runtime logging is diagnostic only and must not change configuration behavior.
    }
    return draft
  }

  try {
    const modelSnapshot = toStructuredCloneSafeValue(model) as AiModelConfig
    const evidence = await extractResumeEvidence({
      markdown,
      model: modelSnapshot,
      onDiagnostic: createAccountAiRuntimeLogger(uid),
    })
    const result = await sendConfigRequest<ResumeSaveResult>({
      action: 'commit-profile-evidence',
      uid,
      markdown,
      evidence,
    })
    try {
      await appendResumeWorkflowLog({
        uid,
        state: 'success',
        stateName: '解析成功',
        message: '解析成功',
        durationMs: Date.now() - startedAt,
        detail: {
          evidenceVersion: result.evidenceVersion,
          factCount: result.factCount,
          reused: false,
        },
      })
    } catch {
      // Runtime logging is diagnostic only and must not change configuration behavior.
    }
    return result
  } catch (rawError) {
    const error = normalizeResumeExtractionError(rawError)
    try {
      await appendResumeWorkflowLog({
        uid,
        state: 'danger',
        stateName: '解析失败',
        message: error.message,
        durationMs: Date.now() - startedAt,
        detail: {
          errorCode: error.code,
        },
      })
    } catch {
      // The UI error remains authoritative when diagnostic storage is unavailable.
    }
    throw error
  }
}
