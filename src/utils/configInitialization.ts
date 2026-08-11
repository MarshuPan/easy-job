import { probeExtensionRuntimeHealth } from '@/message'
import {
  ExtensionRuntimeHealthError,
  getExtensionRuntimeHealthMessage,
  type ExtensionRuntimeHealthErrorCode,
} from '@/utils/extensionRuntimeHealth'
import { getErrorMessage, isProviderHeartbeatError } from '@/utils/providerHealth'

export const CONFIG_INITIALIZATION_RETRY_DELAYS_MS = [250, 750] as const

export interface ConfigInitializationDiagnostic {
  code: ExtensionRuntimeHealthErrorCode | 'CONFIG_INITIALIZATION_FAILED'
  message: string
  retryable: boolean
  userMessage: string
}

interface ConfigInitializationOptions {
  probeRuntime?: () => Promise<unknown>
  retryDelaysMs?: readonly number[]
  sleep?: (delayMs: number) => Promise<void>
  onRetry?: (
    diagnostic: ConfigInitializationDiagnostic,
    nextAttempt: number,
    maxAttempts: number,
  ) => void
}

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs)
  })
}

export function getConfigInitializationDiagnostic(error: unknown): ConfigInitializationDiagnostic {
  if (error instanceof ExtensionRuntimeHealthError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === 'BACKGROUND_UNAVAILABLE',
      userMessage: error.message,
    }
  }

  if (isProviderHeartbeatError(error)) {
    return {
      code: 'BACKGROUND_UNAVAILABLE',
      message: getErrorMessage(error),
      retryable: true,
      userMessage: getExtensionRuntimeHealthMessage('BACKGROUND_UNAVAILABLE'),
    }
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error != null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : '未知配置初始化错误'
  return {
    code: 'CONFIG_INITIALIZATION_FAILED',
    message,
    retryable: false,
    userMessage: '配置初始化失败，请重新加载扩展后重试',
  }
}

/**
 * 只探测运行时，带上和配置初始化同一套重试策略。
 *
 * 面板启动时必须先确认通信桥，但探测不能是一次性的：MV3 的后台 service worker 闲置几十秒
 * 就会休眠，重新打开页面时第一次探测大概率拿到 BACKGROUND_UNAVAILABLE——那不是故障，
 * 是它还没醒。裸探一次就判死会让每次重开页面都启动失败。
 *
 * 重试策略不另起一套：能不能重试由 getConfigInitializationDiagnostic 统一决定，
 * 后台没醒会重试，版本不一致和通信桥真的断了不会。
 */
export async function probeRuntimeWithRetry(options: ConfigInitializationOptions = {}) {
  await initializeConfigWithRuntimeRetry(async () => undefined, options)
}

export async function initializeConfigWithRuntimeRetry(
  initializeConfig: () => Promise<void>,
  options: ConfigInitializationOptions = {},
) {
  const probeRuntime = options.probeRuntime ?? (() => probeExtensionRuntimeHealth())
  const retryDelaysMs = options.retryDelaysMs ?? CONFIG_INITIALIZATION_RETRY_DELAYS_MS
  const wait = options.sleep ?? sleep
  const maxAttempts = retryDelaysMs.length + 1

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await probeRuntime()
      await initializeConfig()
      return
    } catch (error) {
      const diagnostic = getConfigInitializationDiagnostic(error)
      if (!diagnostic.retryable || attempt === maxAttempts) throw error
      options.onRetry?.(diagnostic, attempt + 1, maxAttempts)
      await wait(retryDelaysMs[attempt - 1])
    }
  }
}
