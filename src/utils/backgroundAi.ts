import {
  resolveConfiguredAiTaskTimeoutSeconds,
  type ConfiguredAiTaskType,
} from '@/config/aiTimeout'
import type { AiModelConfig } from '@/config/types'
import type { messageReps, prompt } from '@/types/aiProtocol'
import type { AiTaskDiagnostics } from '@/utils/backgroundAiDiagnostics'
import { AI_TASK_MAX_RETRIES, AI_TASK_MAX_RETRY_DELAY_SECONDS } from '@/utils/backgroundAiProtocol'

import { assertHttpUrl, assertRequestTimeout, normalizeRequestTimeout } from './httpGuards'
import { toSafeJsonValue } from './safeJson'

const templateExpressionRE = /\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}/g
const maxAiRequestBodyBytes = 1024 * 1024
const maxAiResponseBodyBytes = 1024 * 1024
const maxAiStreamBodyBytes = 16 * 1024 * 1024
/** 供应商失败正文在日志里保留的长度。够看清原因，又不至于把整段响应灌进日志。 */
const maxProviderFailureDetailLength = 220
const retryBackoffBaseMs = 50
const maxRetryDelayMs = AI_TASK_MAX_RETRY_DELAY_SECONDS * 1000
/** Anthropic 不接受省略 max_tokens，「不设上限」在这个协议下只能退化成一个足够大的值。 */
const anthropicUnboundedMaxTokens = 64_000
/** 结构化输出用的工具名。请求与解析必须用同一个名字，否则拿不到结果。 */
const anthropicResultToolName = 'agent_delivery_result'
const responsesBackgroundPollIntervalMs = 2000
const responsesBackgroundRequestTimeoutSeconds = 60
const responsesBackgroundProgressIntervalMs = 30_000

export interface AiRuntimeDiagnosticEvent {
  at: number
  diagnostics: AiTaskDiagnostics
  durationMs: number
  error?: unknown
  model: string
  phase: 'started' | 'progress' | 'succeeded' | 'failed'
  protocol: AiModelConfig['protocol']
  providerStatus?: string
  reasoningEffort: string
  requestMode: 'background' | 'stream' | 'sync'
  task?: ConfiguredAiTaskType
  /** 当前协议接不住、因而没有发出去的模型设置。 */
  unsupportedSettings?: string[]
  /** 供应商返回的 token 用量。只有它能区分「模型本身慢」和「我们要的输出变多了」。 */
  usage?: messageReps['usage']
}

export type AiRuntimeDiagnosticHandler = (event: AiRuntimeDiagnosticEvent) => void | Promise<void>

/** 后台任务轮询专用：任务本身已经失败时不该继续轮询，只有这几类值得再查一次。 */
function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500
}

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

function getRetryDelayMs(response: Response | undefined, attempt: number) {
  const retryAfter = response?.headers.get('retry-after')?.trim()
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maxRetryDelayMs, seconds * 1000)
    }

    const retryAt = Date.parse(retryAfter)
    if (Number.isFinite(retryAt)) {
      return Math.min(maxRetryDelayMs, Math.max(0, retryAt - Date.now()))
    }
  }
  return Math.min(maxRetryDelayMs, retryBackoffBaseMs * 2 ** attempt)
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeProviderFailureDetail(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return ''
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 ? ' ' : character
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

class BackgroundAiRequestError extends Error {
  diagnostics: AiTaskDiagnostics

  constructor(message: string, diagnostics: AiTaskDiagnostics, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BackgroundAiRequestError'
    this.diagnostics = diagnostics
  }
}

class BackgroundAiPollingTransientError extends BackgroundAiRequestError {
  retryDelayMs: number

  constructor(
    message: string,
    diagnostics: AiTaskDiagnostics,
    retryDelayMs: number,
    options?: ErrorOptions,
  ) {
    super(message, diagnostics, options)
    this.name = 'BackgroundAiPollingTransientError'
    this.retryDelayMs = retryDelayMs
  }
}

async function readAiResponseText(response: Response, diagnostics: AiTaskDiagnostics) {
  const contentLength = response.headers.get('content-length')?.trim()
  if (contentLength) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxAiResponseBodyBytes) {
      try {
        await response.body?.cancel()
      } catch {
        // The size error is authoritative even if the provider stream cannot be cancelled.
      }
      throw new BackgroundAiRequestError('AI响应体过大，最大允许 1 MiB', diagnostics)
    }
  }

  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maxAiResponseBodyBytes) {
        try {
          await reader.cancel()
        } catch {
          // The size error is authoritative even if the provider stream cannot be cancelled.
        }
        throw new BackgroundAiRequestError('AI响应体过大，最大允许 1 MiB', diagnostics)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function getTemplateValue(data: object, path: string) {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, data)
}

function formatTemplateValue(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value.map(formatTemplateValue).filter(Boolean).join('、')
  }
  if (typeof value === 'object') {
    return JSON.stringify(toSafeJsonValue(value))
  }
  return String(value)
}

export function renderBackgroundPromptTemplate(template: string, data: object) {
  try {
    return template.replace(templateExpressionRE, (_match, path: string) =>
      formatTemplateValue(getTemplateValue(data, path)),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`AI提示词渲染失败：${message}`, { cause: error })
  }
}

function buildPrompt(template: string | prompt, data: object | string): prompt {
  if (typeof data === 'string') {
    return [
      {
        content: data,
        role: 'user',
      },
    ]
  }

  if (typeof template === 'string') {
    return [
      {
        content: renderBackgroundPromptTemplate(template, data),
        role: 'user',
      },
    ]
  }

  if (template.length === 0) {
    throw new Error('多对话提示词不能为空')
  }

  const prompts = template.map((item) => ({ ...item }))
  const last = prompts[prompts.length - 1]
  last.content = renderBackgroundPromptTemplate(last.content, data)
  return prompts
}

function promptToInput(prompt: prompt) {
  return prompt.map((item) => ({
    role: item.role,
    content: item.content,
  }))
}

function parseResponsesContent(res: any) {
  if (typeof res.output_text === 'string') return res.output_text

  const content = res.output
    ?.flatMap((item: any) => item.content ?? [])
    ?.map((item: any) => item.text ?? '')
    ?.join('')

  return content ?? ''
}

function parseUsage(res: any): messageReps['usage'] {
  return {
    input_tokens: res?.usage?.prompt_tokens ?? res?.usage?.input_tokens,
    output_tokens: res?.usage?.completion_tokens ?? res?.usage?.output_tokens,
    reasoning_tokens:
      res?.usage?.output_tokens_details?.reasoning_tokens ??
      res?.usage?.completion_tokens_details?.reasoning_tokens,
    // Chat Completions 放在 prompt_tokens_details，Responses 放在 input_tokens_details。
    cached_tokens:
      res?.usage?.prompt_tokens_details?.cached_tokens ??
      res?.usage?.input_tokens_details?.cached_tokens,
    total_tokens: res?.usage?.total_tokens,
  }
}

function createProviderHeaders(model: AiModelConfig) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (model.protocol === 'anthropic-messages') {
    if (model.apiKey) headers['x-api-key'] = model.apiKey
    headers['anthropic-version'] = '2023-06-01'
    // 官方接口默认拒绝浏览器发起的请求。扩展的后台仍然是浏览器上下文，请求带着
    // chrome-extension:// 的 Origin，不显式声明就会在 CORS 预检阶段被挡下。
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  } else if (model.apiKey) {
    headers.Authorization = `Bearer ${model.apiKey}`
  }
  return headers
}

function resolveConfiguredEndpoint(model: AiModelConfig) {
  const parsed = new URL(model.url)
  const pathname = parsed.pathname.replace(/\/+$/, '')
  const suffix =
    model.protocol === 'openai-responses'
      ? '/responses'
      : model.protocol === 'openai-chat-completions'
        ? '/chat/completions'
        : '/messages'

  if (pathname.toLowerCase().endsWith(suffix)) return model.url
  if (pathname !== '' && !/\/v1$/i.test(pathname)) return model.url

  parsed.pathname = `${pathname || '/v1'}${suffix}`
  return parsed.toString()
}

async function fetchAiJson(args: {
  body: unknown
  diagnostics: AiTaskDiagnostics
  headers: Record<string, string>
  maxRetries?: number
  timeout: number
  url: string
}) {
  const { body, diagnostics, headers, maxRetries = AI_TASK_MAX_RETRIES, timeout, url } = args
  const bodyText = JSON.stringify(body)
  diagnostics.requestBodyChars = bodyText.length
  if (new TextEncoder().encode(bodyText).byteLength > maxAiRequestBodyBytes) {
    throw new BackgroundAiRequestError('AI请求体过大，最大允许 1 MiB', diagnostics)
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now()
    let response: Response
    try {
      const signal = AbortSignal.timeout(timeout * 1000)
      response = await fetch(url, {
        method: 'POST',
        body: bodyText,
        headers,
        signal,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
      })
    } catch (error) {
      lastError = error
      diagnostics.attempts.push({
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: 'AI请求网络失败',
        ok: false,
      })
      // 网络失败是最典型的瞬时故障，过去它一次都不重试。上层遇到 AI 失败就暂停投递，
      // 于是一次网络抖动就足以让整轮停下来——真正需要重试的恰恰是这一类。
      if (attempt === maxRetries) {
        throw new BackgroundAiRequestError(
          `AI请求网络失败，已重试 ${maxRetries} 次仍失败`,
          diagnostics,
          { cause: error },
        )
      }
      await waitForRetry(getRetryDelayMs(undefined, attempt))
      continue
    }

    if (response.redirected || (response.url !== '' && response.url !== url)) {
      const error = new Error('AI响应不允许重定向')
      diagnostics.attempts.push({
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: error.message,
        ok: false,
        status: response.status,
      })
      throw new BackgroundAiRequestError(error.message, diagnostics, { cause: error })
    }

    if (!response.ok || response.status >= 400) {
      // 供应商把拒绝的原因写在响应体里。这里原本读出来就丢掉，于是日志只剩一个状态码，
      // 400 到底是请求体太大、参数不认识还是别的，只能靠猜。
      // 读取本身失败（例如错误正文超过大小上限）时不吞掉，那条保护要继续生效。
      const failureBody = await readAiResponseText(response, diagnostics)
      const detail = sanitizeProviderFailureDetail(failureBody, maxProviderFailureDetailLength)
      const message = detail
        ? `AI请求失败，状态码: ${response.status}：${detail}`
        : `AI请求失败，状态码: ${response.status}`
      const error = new Error(message)
      lastError = error
      diagnostics.attempts.push({
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: message,
        ok: false,
        status: response.status,
      })

      // 不再按状态码区分「值得重试」和「不值得」。上层遇到 AI 失败会暂停整轮投递，
      // 判定失败前一律给满三次尝试：规则统一才不会在下一次改动里又漂掉，
      // 而重试一个确定性错误的代价只是多两次几百毫秒的往返。
      if (attempt === maxRetries) {
        throw new BackgroundAiRequestError(
          `AI请求失败，已重试 ${maxRetries} 次仍失败：${message}`,
          diagnostics,
          { cause: error },
        )
      }
      await waitForRetry(getRetryDelayMs(response, attempt))
      continue
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('application/json') && !contentType.includes('+json')) {
      const error = new Error('AI响应 Content-Type 必须是 application/json')
      diagnostics.attempts.push({
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: error.message,
        ok: false,
        status: response.status,
      })
      throw new BackgroundAiRequestError(error.message, diagnostics, { cause: error })
    }

    let json: any
    try {
      json = JSON.parse(await readAiResponseText(response, diagnostics))
    } catch (error) {
      if (error instanceof BackgroundAiRequestError) throw error
      const message = `AI响应不是合法 JSON：${getErrorMessage(error)}`
      diagnostics.attempts.push({
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: 'AI响应不是合法 JSON',
        ok: false,
        status: response.status,
      })
      throw new BackgroundAiRequestError(message, diagnostics, { cause: error })
    }

    diagnostics.attempts.push({
      attempt: attempt + 1,
      durationMs: Date.now() - startedAt,
      ok: true,
      status: response.status,
    })
    return { diagnostics, json }
  }

  throw new Error(`AI请求失败：${getErrorMessage(lastError)}`)
}

async function readResponsesStreamJson(response: Response, diagnostics: AiTaskDiagnostics) {
  if (!response.body) {
    throw new BackgroundAiRequestError('AI流式响应体为空', diagnostics)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let buffer = ''
  let completed = false
  let outputText = ''
  let outputBytes = 0
  let usage: unknown
  const encoder = new TextEncoder()

  const consumeBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) return
    if (data === '[DONE]') return

    let event: any
    try {
      event = JSON.parse(data)
    } catch (error) {
      throw new BackgroundAiRequestError('AI流式响应包含无效 JSON 事件', diagnostics, {
        cause: error,
      })
    }
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      outputText += event.delta
      outputBytes += encoder.encode(event.delta).byteLength
      if (outputBytes > maxAiResponseBodyBytes) {
        throw new BackgroundAiRequestError('AI最终文本过大，最大允许 1 MiB', diagnostics)
      }
    }
    if (event?.type === 'response.completed' && event.response != null) {
      completed = true
      usage = event.response.usage
      if (!outputText) {
        outputText = parseResponsesContent(event.response)
        if (encoder.encode(outputText).byteLength > maxAiResponseBodyBytes) {
          throw new BackgroundAiRequestError('AI最终文本过大，最大允许 1 MiB', diagnostics)
        }
      }
    }
    if (event?.type === 'response.failed' || event?.type === 'error') {
      const failure = event.response?.error ?? event.error
      const code = sanitizeProviderFailureDetail(failure?.code, 80)
      const message = sanitizeProviderFailureDetail(failure?.message, 240)
      const detail = [code, message].filter(Boolean).join(': ')
      throw new BackgroundAiRequestError(
        detail ? `AI流式响应返回失败事件：${detail}` : 'AI流式响应返回失败事件',
        diagnostics,
      )
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maxAiStreamBodyBytes) {
        await reader.cancel().catch(() => undefined)
        throw new BackgroundAiRequestError('AI流式响应过大，最大允许 16 MiB', diagnostics)
      }
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.match(/\r?\n\r?\n/)
      while (boundary?.index != null) {
        consumeBlock(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
        boundary = buffer.match(/\r?\n\r?\n/)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeBlock(buffer)
  } finally {
    reader.releaseLock()
  }

  if (completed) return { output_text: outputText, usage }
  throw new BackgroundAiRequestError('AI流式响应缺少完成事件', diagnostics)
}

async function fetchResponsesStreamJson(args: {
  body: unknown
  diagnostics: AiTaskDiagnostics
  headers: Record<string, string>
  timeout: number
  url: string
}) {
  const { body, diagnostics, headers, timeout, url } = args
  const bodyText = JSON.stringify(body)
  diagnostics.requestBodyChars = bodyText.length
  if (new TextEncoder().encode(bodyText).byteLength > maxAiRequestBodyBytes) {
    throw new BackgroundAiRequestError('AI请求体过大，最大允许 1 MiB', diagnostics)
  }

  const startedAt = Date.now()
  const attemptNumber = diagnostics.attempts.length + 1
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      body: bodyText,
      headers,
      signal: AbortSignal.timeout(timeout * 1000),
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
    })
  } catch (error) {
    diagnostics.attempts.push({
      attempt: attemptNumber,
      durationMs: Date.now() - startedAt,
      error: 'AI流式请求网络失败',
      ok: false,
    })
    throw new BackgroundAiRequestError('AI流式请求网络失败，未自动重试', diagnostics, {
      cause: error,
    })
  }

  if (response.redirected || (response.url !== '' && response.url !== url)) {
    diagnostics.attempts.push({
      attempt: attemptNumber,
      durationMs: Date.now() - startedAt,
      error: 'AI流式响应不允许重定向',
      ok: false,
      status: response.status,
    })
    throw new BackgroundAiRequestError('AI流式响应不允许重定向', diagnostics)
  }
  if (!response.ok || response.status >= 400) {
    await readAiResponseText(response, diagnostics)
    diagnostics.attempts.push({
      attempt: attemptNumber,
      durationMs: Date.now() - startedAt,
      error: `AI流式请求失败，状态码: ${response.status}`,
      ok: false,
      status: response.status,
    })
    throw new BackgroundAiRequestError(`AI流式请求失败，状态码: ${response.status}`, diagnostics)
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('text/event-stream')) {
    diagnostics.attempts.push({
      attempt: attemptNumber,
      durationMs: Date.now() - startedAt,
      error: 'AI流式响应 Content-Type 必须是 text/event-stream',
      ok: false,
      status: response.status,
    })
    throw new BackgroundAiRequestError(
      'AI流式响应 Content-Type 必须是 text/event-stream',
      diagnostics,
    )
  }

  let json: unknown
  try {
    json = await readResponsesStreamJson(response, diagnostics)
  } catch (error) {
    if (error instanceof BackgroundAiRequestError) throw error
    const readErrorMessage = getErrorMessage(error)
    const timedOut = /timeout|abort|超时/i.test(readErrorMessage)
    const message = timedOut ? 'AI流式响应读取超时' : 'AI流式响应读取失败'
    diagnostics.attempts.push({
      attempt: attemptNumber,
      durationMs: Date.now() - startedAt,
      error: message,
      ok: false,
      status: response.status,
    })
    throw new BackgroundAiRequestError(message, diagnostics, { cause: error })
  }
  diagnostics.attempts.push({
    attempt: attemptNumber,
    durationMs: Date.now() - startedAt,
    ok: true,
    status: response.status,
  })
  return { diagnostics, json }
}

function getResponsesStatus(value: unknown) {
  if (typeof value !== 'object' || value == null || !('status' in value)) return undefined
  return typeof value.status === 'string' ? value.status : undefined
}

function getResponsesId(value: unknown) {
  if (typeof value !== 'object' || value == null || !('id' in value)) return undefined
  return typeof value.id === 'string' && value.id ? value.id : undefined
}

/**
 * 明确表示「不要思考」的强度写法。
 *
 * reasoningEffort 是自由文本，各家词表不同，因此只能反向识别：列出确定表示关闭的写法，
 * 其余一律当作要思考。
 */
const lightReasoningEfforts = new Set(['', 'none', 'off', 'minimal'])

function wantsReasoning(effort: string) {
  return !lightReasoningEfforts.has(effort.trim().toLowerCase())
}

/**
 * Anthropic 的 thinking 用 token 预算表达强度，协议里没有 low/high 这类档位词。
 *
 * 这里不发明「high 等于多少 token」的换算——那个数字没有依据，而且一旦拿它去和
 * max_tokens 相互推导，就变成用一个凭空的上限去决定模型想多深。
 * 规则改成：填数字就按数字给预算，填词就交给模型自己决定。想精确控制的人有直接的表达方式，
 * 不想控制的人也不会被一个编出来的数字代替。
 */
function parseThinkingBudget(effort: string) {
  const value = Number(effort.trim())
  return Number.isInteger(value) && value >= 1024 ? value : null
}

function anthropicThinking(effort: string) {
  if (!wantsReasoning(effort)) return undefined
  const budget = parseThinkingBudget(effort)
  return budget == null
    ? { type: 'adaptive' as const }
    : { type: 'enabled' as const, budget_tokens: budget }
}

/**
 * 当前协议接不住的模型设置。
 *
 * 三个协议的参数集合不同：惩罚项只有 chat-completions 有，Anthropic 的 thinking 也接不住
 * 具体强度值。这类字段过去是被静默丢掉的——用户配了，请求里没有，也没有任何地方说明。
 * 把它列进运行日志，至少「配了不生效」当场可见，不用去翻代码才能发现。
 */
export function unsupportedModelSettings(model: AiModelConfig) {
  const unsupported: string[] = []
  const { generation } = model
  if (model.protocol !== 'openai-chat-completions') {
    if (generation.presencePenalty != null) unsupported.push('presencePenalty')
    if (generation.frequencyPenalty != null) unsupported.push('frequencyPenalty')
  }
  if (model.protocol === 'anthropic-messages' && wantsReasoning(model.reasoningEffort)) {
    // 这个协议用 token 预算表达思考强度，没有档位词。填词只能交给模型自己决定，
    // 所以要告诉用户：想精确控制就直接填数字。
    if (parseThinkingBudget(model.reasoningEffort) == null) {
      unsupported.push('reasoningEffort（Anthropic 用 token 预算表达强度，填数字才能精确控制）')
    }
    // 开启扩展思考时接口不接受采样参数，我们只能丢掉它们——这也是一次静默丢弃，同样要报出来。
    if (generation.temperature != null) unsupported.push('temperature（开启思考时不可用）')
    if (generation.topP != null) unsupported.push('topP（开启思考时不可用）')
  }
  return unsupported
}

/**
 * 已知会跑很久的任务。
 *
 * 简历解析实测单次 2 到 4.5 分钟，同步请求撑不住这个时长——网关会掐断返回 502。
 * 它本来就有 600 秒的超时下限，说明代码早就知道它慢，传输方式必须把这件事考虑进去。
 */
function isLongRunningTask(task?: ConfiguredAiTaskType) {
  return task === 'resumeExtraction'
}

/**
 * 传输方式只由两件事决定：用户的显式设置，以及这个任务是不是已知的慢任务。
 *
 * 原来它还看 reasoningEffort，这是把「模型想多深」这个质量设置拿去决定网络传输。两个后果：
 * 强度是自由文本却只认字面量 'max'，用户填 'high' 就不算数——配了强度没按强度走；
 * 反过来把词表放宽，每岗一次的匹配和招呼语也会被切到流式，而流式下传输层的重试是 0，
 * 秒级请求白白失去重试。强度现在只管模型想多深，不再暗中改变请求怎么发。
 */
function shouldUseResponsesBackground(model: AiModelConfig, task?: ConfiguredAiTaskType) {
  if (model.protocol !== 'openai-responses') return false
  if (model.responsesBackground === 'on') return true
  if (model.responsesBackground === 'off') return false
  if (!isLongRunningTask(task)) return false
  try {
    return new URL(model.url).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

function shouldUseResponsesStreaming(model: AiModelConfig, task?: ConfiguredAiTaskType) {
  return (
    model.protocol === 'openai-responses' &&
    model.responsesBackground === 'auto' &&
    isLongRunningTask(task) &&
    !shouldUseResponsesBackground(model, task)
  )
}

function shouldFallbackUnsupportedResponsesBackground(error: unknown, model: AiModelConfig) {
  if (!(error instanceof BackgroundAiRequestError)) return false
  try {
    if (new URL(model.url).hostname === 'api.openai.com') return false
  } catch {
    return false
  }
  const status = [...error.diagnostics.attempts]
    .reverse()
    .find((attempt) => typeof attempt.status === 'number')?.status
  return status === 400 || status === 404 || status === 405 || status === 422
}

function createResponsesPollUrl(url: string, responseId: string) {
  const parsed = new URL(url)
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/${encodeURIComponent(responseId)}`
  return parsed.toString()
}

async function fetchBackgroundResponseJson(args: {
  diagnostics: AiTaskDiagnostics
  model: AiModelConfig
  responseId: string
  timeout: number
}) {
  const { diagnostics, model, responseId, timeout } = args
  const url = createResponsesPollUrl(model.url, responseId)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: createProviderHeaders(model),
      signal: AbortSignal.timeout(
        Math.min(timeout, responsesBackgroundRequestTimeoutSeconds) * 1000,
      ),
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
    })
  } catch (error) {
    throw new BackgroundAiPollingTransientError(
      '后台AI任务状态查询暂时失败',
      diagnostics,
      getRetryDelayMs(undefined, 0),
      { cause: error },
    )
  }

  if (response.redirected || (response.url !== '' && response.url !== url)) {
    throw new BackgroundAiRequestError('后台AI任务状态查询不允许重定向', diagnostics)
  }
  if (!response.ok || response.status >= 400) {
    await readAiResponseText(response, diagnostics)
    if (isRetryableStatus(response.status)) {
      throw new BackgroundAiPollingTransientError(
        `后台AI任务状态查询暂时失败，状态码: ${response.status}`,
        diagnostics,
        getRetryDelayMs(response, 0),
      )
    }
    throw new BackgroundAiRequestError(
      `后台AI任务状态查询失败，状态码: ${response.status}`,
      diagnostics,
    )
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json') && !contentType.includes('+json')) {
    throw new BackgroundAiRequestError('后台AI任务状态响应必须是 application/json', diagnostics)
  }
  try {
    return JSON.parse(await readAiResponseText(response, diagnostics))
  } catch (error) {
    if (error instanceof BackgroundAiRequestError) throw error
    throw new BackgroundAiRequestError('后台AI任务状态响应不是合法 JSON', diagnostics, {
      cause: error,
    })
  }
}

async function waitForBackgroundResponse(args: {
  diagnostics: AiTaskDiagnostics
  initial: unknown
  model: AiModelConfig
  onProgress?: (status: string | undefined) => void | Promise<void>
  timeout: number
}) {
  const { diagnostics, model, onProgress, timeout } = args
  let response = args.initial
  const responseId = getResponsesId(response)
  const initialStatus = getResponsesStatus(response)
  if (!responseId) {
    if (initialStatus == null) return response
    throw new BackgroundAiRequestError('后台AI任务缺少 response id', diagnostics)
  }

  const startedAt = Date.now()
  diagnostics.background = {
    durationMs: 0,
    pollCount: 0,
    responseId,
    status: initialStatus ?? 'unknown',
  }
  let nextPollDelayMs = responsesBackgroundPollIntervalMs
  let lastProgressAt = 0
  let lastProgressStatus: string | undefined
  while (true) {
    const status = getResponsesStatus(response)
    diagnostics.background.status = status ?? 'unknown'
    diagnostics.background.durationMs = Date.now() - startedAt
    const shouldReportProgress =
      status !== lastProgressStatus ||
      Date.now() - lastProgressAt >= responsesBackgroundProgressIntervalMs
    if (shouldReportProgress) {
      lastProgressAt = Date.now()
      lastProgressStatus = status
      try {
        await onProgress?.(status)
      } catch {
        // Diagnostic persistence must never change the model request outcome.
      }
    }
    if (status === 'completed') return response
    if (status !== 'queued' && status !== 'in_progress') {
      throw new BackgroundAiRequestError(
        `后台AI任务未完成，状态: ${status ?? 'unknown'}`,
        diagnostics,
      )
    }
    if (Date.now() - startedAt >= timeout * 1000) {
      throw new BackgroundAiRequestError(`后台AI任务轮询超时 ${timeout}s`, diagnostics)
    }

    const remainingBeforePollMs = timeout * 1000 - (Date.now() - startedAt)
    await waitForRetry(Math.min(nextPollDelayMs, remainingBeforePollMs))
    nextPollDelayMs = responsesBackgroundPollIntervalMs
    const remainingRequestMs = timeout * 1000 - (Date.now() - startedAt)
    if (remainingRequestMs <= 0) {
      throw new BackgroundAiRequestError(`后台AI任务轮询超时 ${timeout}s`, diagnostics)
    }
    diagnostics.background.pollCount += 1
    try {
      response = await fetchBackgroundResponseJson({
        diagnostics,
        model,
        responseId,
        timeout: remainingRequestMs / 1000,
      })
    } catch (error) {
      if (!(error instanceof BackgroundAiPollingTransientError)) throw error
      const remainingRetryMs = timeout * 1000 - (Date.now() - startedAt)
      if (remainingRetryMs <= 0) {
        throw new BackgroundAiRequestError(`后台AI任务轮询超时 ${timeout}s`, diagnostics, {
          cause: error,
        })
      }
      nextPollDelayMs = Math.min(error.retryDelayMs, remainingRetryMs)
    }
  }
}

function structuredOutputFormat(jsonSchema?: Record<string, unknown>) {
  return jsonSchema
    ? {
        type: 'json_schema',
        name: 'agent_delivery_result',
        strict: true,
        schema: toProviderCompatibleJsonSchema(jsonSchema),
      }
    : { type: 'json_object' }
}

const unsupportedStructuredOutputKeywords = new Set([
  'format',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'pattern',
  'uniqueItems',
])

function toProviderCompatibleJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toProviderCompatibleJsonSchema)
  if (value == null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !unsupportedStructuredOutputKeywords.has(key))
      .map(([key, child]) => [key, toProviderCompatibleJsonSchema(child)]),
  )
}

function buildConfiguredRequestBody(args: {
  backgroundResponses?: boolean
  model: AiModelConfig
  json?: boolean
  jsonSchema?: Record<string, unknown>
  /**
   * null 表示不声明输出上限。
   *
   * 简历提取的输出长度取决于简历本身，任何猜出来的数字都可能被真实简历超过，而超过的
   * 后果是响应被截断成非法 JSON、整次解析作废——比不设上限糟得多。Anthropic 的
   * max_tokens 是必填，那里退回一个足够大的值。
   */
  maxOutputTokens: number | null
  prompts: prompt
  streamResponses?: boolean
}) {
  const {
    backgroundResponses,
    json,
    jsonSchema,
    maxOutputTokens,
    model,
    prompts,
    streamResponses,
  } = args
  const generation = model.generation
  if (model.protocol === 'openai-responses') {
    return {
      background: backgroundResponses || undefined,
      input: promptToInput(prompts),
      max_output_tokens: maxOutputTokens ?? undefined,
      model: model.model,
      temperature: generation.temperature ?? undefined,
      top_p: generation.topP ?? undefined,
      reasoning: model.reasoningEffort ? { effort: model.reasoningEffort } : undefined,
      stream: streamResponses || undefined,
      text: json ? { format: structuredOutputFormat(jsonSchema) } : undefined,
    }
  }
  if (model.protocol === 'openai-chat-completions') {
    const format = json ? structuredOutputFormat(jsonSchema) : undefined
    return {
      messages: prompts,
      max_completion_tokens: maxOutputTokens ?? undefined,
      model: model.model,
      stream: false,
      temperature: generation.temperature ?? undefined,
      top_p: generation.topP ?? undefined,
      presence_penalty: generation.presencePenalty ?? undefined,
      frequency_penalty: generation.frequencyPenalty ?? undefined,
      reasoning_effort: model.reasoningEffort || undefined,
      response_format:
        format?.type === 'json_schema'
          ? {
              type: format.type,
              json_schema: {
                name: format.name,
                strict: format.strict,
                schema: format.schema,
              },
            }
          : format,
    }
  }

  const system = prompts
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n\n')
  const messages = prompts
    .filter((item) => item.role !== 'system')
    .map((item) => ({ role: item.role, content: item.content }))
  const thinking = anthropicThinking(model.reasoningEffort)
  // max_tokens 是这个协议的必填字段，没法表达「不设上限」，只能给一个足够大的值。
  // 预算必须小于它，所以由 max_tokens 迁就预算，而不是反过来把用户要的思考压小。
  const budget = thinking != null && 'budget_tokens' in thinking ? (thinking.budget_tokens ?? 0) : 0
  const maxTokens = Math.max(maxOutputTokens ?? anthropicUnboundedMaxTokens, budget + 2048)
  return {
    // Anthropic 的 max_tokens 是必填字段，不能省略。
    max_tokens: maxTokens,
    messages,
    model: model.model,
    system: system || undefined,
    // 开启扩展思考时接口不接受采样参数，一起发出去会被直接拒绝。
    temperature: thinking ? undefined : (generation.temperature ?? undefined),
    top_p: thinking ? undefined : (generation.topP ?? undefined),
    thinking,
    // Messages 协议没有 response_format，结构化输出走工具调用：声明一个工具，
    // 让模型把结果填进它的入参。之前发的 output_config 不是这个协议的字段，
    // 官方接口会因为未知字段直接报错——而本扩展的每个任务都要求 JSON 输出。
    ...(json
      ? {
          tools: [
            {
              name: anthropicResultToolName,
              description: '把本次任务的结果按 input_schema 填入。',
              input_schema: jsonSchema ?? { type: 'object' },
            },
          ],
          // 扩展思考开启时不能强制指定工具，只能交给模型自己选。
          tool_choice: thinking
            ? { type: 'auto' }
            : { type: 'tool', name: anthropicResultToolName },
        }
      : {}),
  }
}

function parseAnthropicContent(value: any) {
  if (!Array.isArray(value?.content)) return ''
  // 结构化输出走工具调用，结果在 tool_use 块的 input 里，不在文本块里。
  // 开启思考时正文之前还会有 thinking 块，也不能当成结果。
  const toolUse = value.content.find(
    (item: any) => item?.type === 'tool_use' && item.name === anthropicResultToolName,
  )
  if (toolUse && toolUse.input != null) return JSON.stringify(toolUse.input)
  return value.content
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text)
    .join('')
}

function parseConfiguredResult(
  model: AiModelConfig,
  json: any,
  promptText: string,
  diagnostics: AiTaskDiagnostics,
): messageReps {
  if (model.protocol === 'openai-responses') {
    return {
      prompt: promptText,
      content: parseResponsesContent(json),
      diagnostics,
      usage: parseUsage(json),
    }
  }
  if (model.protocol === 'anthropic-messages') {
    return {
      prompt: promptText,
      content: parseAnthropicContent(json),
      diagnostics,
      usage: {
        input_tokens: json?.usage?.input_tokens,
        output_tokens: json?.usage?.output_tokens,
        // Anthropic 分读取和写入两个数，这里只关心读到了多少。
        cached_tokens: json?.usage?.cache_read_input_tokens,
        total_tokens:
          typeof json?.usage?.input_tokens === 'number' &&
          typeof json?.usage?.output_tokens === 'number'
            ? json.usage.input_tokens + json.usage.output_tokens
            : undefined,
      } as messageReps['usage'],
    }
  }
  const msg = (json.choices as any[] | undefined)?.pop()
  return {
    prompt: promptText,
    content: msg?.message?.content ?? '',
    diagnostics,
    reasoning_content: (msg?.message?.reasoning_content as string | undefined)?.replaceAll(
      '\n',
      '',
    ),
    usage: parseUsage(json),
  }
}

export async function runConfiguredAiTask(args: {
  model: AiModelConfig
  template: string | prompt | undefined
  data: object
  json?: boolean
  jsonSchema?: Record<string, unknown>
  maxOutputTokens?: number | null
  onDiagnostic?: AiRuntimeDiagnosticHandler
  task?: ConfiguredAiTaskType
}) {
  if (args.template == null || args.template === '') {
    throw new Error('AI提示词为空')
  }

  const model = args.model
  assertHttpUrl(model.url)
  const endpointUrl = resolveConfiguredEndpoint(model)
  const timeout = normalizeRequestTimeout(resolveConfiguredAiTaskTimeoutSeconds(model, args.task))
  assertRequestTimeout(timeout)

  const prompts = buildPrompt(args.template, args.data)
  const promptText = prompts[prompts.length - 1].content
  let useResponsesBackground = shouldUseResponsesBackground(model, args.task)
  let useResponsesStreaming = shouldUseResponsesStreaming(model, args.task)
  let requestMode: AiRuntimeDiagnosticEvent['requestMode'] = useResponsesBackground
    ? ('background' as const)
    : useResponsesStreaming
      ? ('stream' as const)
      : ('sync' as const)
  let body = buildConfiguredRequestBody({
    backgroundResponses: useResponsesBackground,
    model,
    json: args.json,
    jsonSchema: args.jsonSchema,
    maxOutputTokens: args.maxOutputTokens ?? null,
    prompts,
    streamResponses: useResponsesStreaming,
  })
  const diagnostics: AiTaskDiagnostics = {
    attempts: [],
    endpointType:
      model.protocol === 'openai-responses'
        ? 'responses'
        : model.protocol === 'anthropic-messages'
          ? 'anthropicMessages'
          : 'chatCompletions',
    maxRetries: useResponsesBackground || useResponsesStreaming ? 0 : AI_TASK_MAX_RETRIES,
    model: model.model,
    promptChars: promptText.length,
    requestBodyChars: 0,
    task: args.task,
    timeoutSeconds: timeout,
  }
  const startedAt = Date.now()
  const emitDiagnostic = async (
    phase: AiRuntimeDiagnosticEvent['phase'],
    options?: { error?: unknown; providerStatus?: string; usage?: messageReps['usage'] },
  ) => {
    if (!args.onDiagnostic) return
    try {
      await args.onDiagnostic({
        at: Date.now(),
        diagnostics,
        durationMs: Date.now() - startedAt,
        error: options?.error,
        model: model.model,
        phase,
        protocol: model.protocol,
        providerStatus: options?.providerStatus,
        reasoningEffort: model.reasoningEffort,
        requestMode,
        task: args.task,
        unsupportedSettings: unsupportedModelSettings(model),
        usage: options?.usage,
      })
    } catch {
      // Diagnostic persistence must never change the model request outcome.
    }
  }

  await emitDiagnostic('started')
  try {
    let initialResult: Awaited<ReturnType<typeof fetchAiJson>>
    try {
      initialResult = useResponsesStreaming
        ? await fetchResponsesStreamJson({
            body,
            diagnostics,
            headers: createProviderHeaders(model),
            timeout,
            url: endpointUrl,
          })
        : await fetchAiJson({
            body,
            diagnostics,
            headers: createProviderHeaders(model),
            maxRetries: useResponsesBackground ? 0 : AI_TASK_MAX_RETRIES,
            timeout: useResponsesBackground
              ? Math.min(timeout, responsesBackgroundRequestTimeoutSeconds)
              : timeout,
            url: endpointUrl,
          })
    } catch (error) {
      if (!useResponsesBackground || !shouldFallbackUnsupportedResponsesBackground(error, model)) {
        throw error
      }
      useResponsesBackground = false
      useResponsesStreaming = true
      requestMode = 'stream'
      body = buildConfiguredRequestBody({
        backgroundResponses: false,
        model,
        json: args.json,
        jsonSchema: args.jsonSchema,
        maxOutputTokens: args.maxOutputTokens ?? null,
        prompts,
        streamResponses: true,
      })
      await emitDiagnostic('progress', { providerStatus: 'fallback_stream' })
      initialResult = await fetchResponsesStreamJson({
        body,
        diagnostics,
        headers: createProviderHeaders(model),
        timeout,
        url: endpointUrl,
      })
    }
    const { json: initialJson, diagnostics: aiDiagnostics } = initialResult
    const json = useResponsesBackground
      ? await waitForBackgroundResponse({
          diagnostics: aiDiagnostics,
          initial: initialJson,
          model: endpointUrl === model.url ? model : { ...model, url: endpointUrl },
          onProgress: (providerStatus) => emitDiagnostic('progress', { providerStatus }),
          timeout,
        })
      : initialJson
    const result = parseConfiguredResult(model, json, promptText, aiDiagnostics)
    await emitDiagnostic('succeeded', { usage: result.usage })
    return result
  } catch (error) {
    await emitDiagnostic('failed', { error })
    throw error
  }
}

export async function testConfiguredAiModel(
  model: AiModelConfig,
  onDiagnostic?: AiRuntimeDiagnosticHandler,
) {
  const startedAt = Date.now()
  const result = await runConfiguredAiTask({
    model,
    template: [
      {
        role: 'system',
        content: 'Return only the JSON object required by the provided output contract.',
      },
      { role: 'user', content: 'Return {"ok":true}.' },
    ],
    data: {},
    json: true,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
    maxOutputTokens: 512,
    onDiagnostic,
    task: 'modelTest',
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(result.content ?? '')
  } catch {
    throw new Error('模型连接成功，但没有返回合法结构化 JSON')
  }
  if (typeof parsed !== 'object' || parsed == null || (parsed as { ok?: unknown }).ok !== true) {
    throw new Error('模型连接成功，但结构化 JSON 内容不符合测试契约')
  }
  return {
    ok: true as const,
    durationMs: Date.now() - startedAt,
    model: model.model,
    protocol: model.protocol,
  }
}
