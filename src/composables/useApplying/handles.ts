import { useCommon } from '@/composables/useCommon'
import { useStatistics } from '@/composables/useStatistics'
import { Message } from '@/composables/useWebSocket'
import {
  claimPendingGreetingForFallback,
  enqueuePendingGreeting,
  getPendingGreeting,
  PENDING_GREETING_MAX_AGE_MS,
  removePendingGreeting,
} from '@/composables/useWebSocket/pendingGreeting'
import { COMMUTE_FEATURE_AVAILABLE, DEFAULT_AI_FILTERING_SCORE } from '@/config/defaults'
import { counter, runBackgroundAiTask } from '@/message'
import { useConf } from '@/stores/conf'
import { addLogTrace, useLog } from '@/stores/log'
import type { logData } from '@/stores/log'
import { useUser } from '@/stores/user'
import type { GreetingFilteringContext, RecentGreetingSummary } from '@/types/aiGreeting'
import type { messageReps } from '@/types/aiProtocol'
import {
  ActivityError,
  AIFilteringError,
  AIProviderError,
  CompanySizeError,
  DeliveryStoppedError,
  FriendStatusError,
  GoldHunterError,
  GreetError,
  JobAddressError,
  JobDataIncompleteError,
  JobDescriptionError,
  RepeatError,
  RetryablePipelineError,
} from '@/types/deliverError'
import type { FormData } from '@/types/formData'
import { delay } from '@/utils'
import { acquireBossAction } from '@/utils/actionGateStore'
import { parseGreetingDraft } from '@/utils/aiGreetingDraft'
import { amapDistance, resolveAmapLocation } from '@/utils/amap'
import { getAiTaskDiagnostics, type AiTaskDiagnostics } from '@/utils/backgroundAiDiagnostics'
import { fingerprintGreeting } from '@/utils/greetingHistory'
import { greetingSegmentDelayMs } from '@/utils/humanPace'
import { shouldRejectJobContent } from '@/utils/jobContentFilter'
import { logger } from '@/utils/logger'
import { isProviderHeartbeatError } from '@/utils/providerHealth'
import { evaluateRecruiterActivity } from '@/utils/recruiterActivity'
import { toSafeJsonValue } from '@/utils/safeJson'
import { buildGeekChatUrl, isGeekChatUrl } from '@/utils/zhipinRoute'

import type { Handler, StepFactory } from './type'
import {
  errorHandle,
  parseFiltering,
  rangeMatch,
  rangeMatchFormat,
  requestBossData,
  sameCompanyKey,
  sameHrKey,
} from './utils'

const pendingGreetingExpirySafetyMs = 10_000
type GreetingSendRecord = NonNullable<NonNullable<logData['greetingSend']>['messages']>[number]

class AiGreetingDisabledError extends Error {
  constructor() {
    super('AI招呼语已关闭，已取消待发送文本')
    this.name = 'AiGreetingDisabledError'
  }
}

export function getPendingGreetingWaitTimeoutMs(configuredSeconds: number, total: number) {
  const configuredMs = Math.max(0, configuredSeconds) * 1000
  const minimumMs = Math.max(90_000, total * 35_000)
  return Math.min(
    PENDING_GREETING_MAX_AGE_MS - pendingGreetingExpirySafetyMs,
    Math.max(minimumMs, configuredMs),
  )
}

export function handles(runtimeFormData?: FormData) {
  const liveConf = useConf()
  const conf = {
    get formData() {
      return runtimeFormData ?? liveConf.formData
    },
    get aiTaskTimeoutSeconds() {
      return liveConf.aiTaskTimeoutSeconds
    },
  }
  const common = useCommon()
  const statistics = useStatistics()
  let commuteOriginCache:
    | { key: string; promise: ReturnType<typeof resolveAmapLocation> }
    | undefined

  const isAiGreetingRuntimeEnabled = () =>
    conf.formData.aiGreeting.enable && liveConf.formData.aiGreeting.enable

  function resolveCommuteOrigin() {
    const origin = conf.formData.amap.origins.trim()
    const key = `${conf.formData.amap.key.trim()}\u0000${origin}`
    if (commuteOriginCache?.key === key) return commuteOriginCache.promise

    const promise = resolveAmapLocation(origin).catch((error) => {
      if (commuteOriginCache?.promise === promise) commuteOriginCache = undefined
      throw error
    })
    commuteOriginCache = { key, promise }
    return promise
  }

  function toCloneable<T>(value: T): T {
    return toSafeJsonValue(value) as T
  }

  /**
   * 这次 AI 调用失败，是服务不可用，还是只是这一次的输出不能用？
   *
   * 只有服务性故障才值得停掉整轮——后面的岗位拿去试结果一样。输出不合法是单次事件，
   * 换一个岗位、换一份 JD 很可能就正常了，把整轮停掉是拿一个岗位的意外惩罚其余几十个。
   */
  function isRecoverableAiTaskFailure(error: unknown) {
    const serviceFailures = new Set([
      'AI_TASK_TIMEOUT',
      'AI_TASK_RATE_LIMITED',
      'AI_TASK_AUTH_FAILED',
      'AI_TASK_HTTP_FAILED',
    ])
    if (error instanceof Error && serviceFailures.has(error.name)) return false
    if (isProviderHeartbeatError(error)) return false
    return true
  }

  function buildAiTaskData(
    ctx: logData,
    extras: {
      filteringThreshold?: number
      filtering?: GreetingFilteringContext
      recentGreetings?: RecentGreetingSummary[]
    } = {},
  ) {
    const accountUid = useUser().getUserId()
    if (accountUid == null) throw new AIProviderError('无法识别当前 BOSS 账号')
    const { filteringThreshold: extraThreshold, ...contextExtras } = extras
    const filteringThreshold =
      extraThreshold ??
      ctx.aiFilteringThreshold ??
      conf.formData.aiFiltering.score ??
      DEFAULT_AI_FILTERING_SCORE
    const listData = toCloneable(ctx.listData) as unknown as bossZpJobItemData &
      Record<string, unknown>
    const serializableListData = listData as Record<string, unknown>
    delete serializableListData.card
    delete serializableListData.status
    delete serializableListData.getCard
    return {
      accountUid: String(accountUid),
      data: listData,
      boss: ctx.bossData ? toCloneable(ctx.bossData) : undefined,
      card: ctx.listData.card ? toCloneable(ctx.listData.card) : undefined,
      amap: {
        straightDistance: (ctx.amap?.distance?.straight.distance ?? 0) / 1000,
        drivingDistance: (ctx.amap?.distance?.driving.distance ?? 0) / 1000,
        drivingDuration: (ctx.amap?.distance?.driving.duration ?? 0) / 60,
        walkingDistance: (ctx.amap?.distance?.walking.distance ?? 0) / 1000,
        walkingDuration: (ctx.amap?.distance?.walking.duration ?? 0) / 60,
      },
      ...contextExtras,
      // 阈值只在需要筛选上下文的招呼语任务里带上。匹配任务不能看到它——看到了模型就会
      // 先定「投不投」，再补一个刚好落在线下的分数，于是用户把门槛从 80 调到 40 也不会
      // 多投出一个岗位。阈值必须留在代码这一侧做判定，不能进提示词。
      // 注意 extras 是解构后再展开的：直接 ...extras 会把阈值原样铺回去，绕开这个开关。
      ...(contextExtras.filtering !== undefined || contextExtras.recentGreetings !== undefined
        ? { filteringThreshold }
        : {}),
    }
  }

  function formatDiagnosticError(message?: string) {
    if (!message) return ''
    return message.length > 140 ? `${message.slice(0, 140)}...` : message
  }

  function addAiTaskDiagnosticsLog(
    ctx: logData,
    stage: string,
    status: 'success' | 'danger',
    diagnostics?: AiTaskDiagnostics,
  ) {
    if (!diagnostics) return

    const attempts = diagnostics.attempts
    const maxAttempts = diagnostics.maxRetries + 1
    const retryCount = Math.max(0, attempts.length - 1)
    const totalDurationMs = attempts.reduce((sum, item) => sum + item.durationMs, 0)
    const lastAttempt = attempts[attempts.length - 1]
    const lastError = status === 'danger' ? formatDiagnosticError(lastAttempt?.error) : ''
    const suffix = lastError ? `，最后错误：${lastError}` : ''

    addLogTrace(
      ctx,
      `${stage}请求`,
      status,
      `AI请求${status === 'success' ? '完成' : '失败'}：${attempts.length}/${maxAttempts} 次，重试 ${retryCount} 次，耗时 ${totalDurationMs}ms${suffix}`,
      diagnostics,
    )
  }

  const communicated: StepFactory = () => {
    if (!conf.formData.friendStatus.value) {
      return
    }
    return async ({ data }) => {
      if (data.contact) {
        statistics.todayData.repeat++
        throw new RepeatError(`已经沟通过`)
      }
    }
  }

  const SameCompanyFilter: StepFactory = () => {
    if (!conf.formData.sameCompanyFilter.value) {
      return
    }
    let someSet: Set<string> | null = null
    let uid: string | number | null = null
    return {
      fn: async ({ data }) => {
        uid ??= useUser().getUserId()
        if (uid == null) {
          throw new RetryablePipelineError('没有获取到uid，无法执行同公司去重')
        }
        if (someSet == null) {
          someSet = new Set<string>()
          const data = await counter.storageGet<Record<string, string[]>>(sameCompanyKey, {})
          for (const id of data[uid] ?? []) {
            someSet.add(id)
          }
        }
        const id = data.encryptBrandId
        if (id != null && someSet.has(id)) {
          statistics.todayData.repeat++
          throw new RepeatError('相同公司已投递')
        }
      },
      after: async ({ data }) => {
        uid ??= useUser().getUserId()
        if (uid == null) {
          throw new RetryablePipelineError('没有获取到uid，无法记录同公司去重')
        }
        if (data.encryptBrandId == null) return
        someSet?.add(data.encryptBrandId)
        const oldData = await counter.storageGet<Record<string, string[]>>(sameCompanyKey, {})
        await counter.storageSet(sameCompanyKey, {
          ...oldData,
          [uid]: Array.from(someSet ?? []),
        })
      },
    }
  }

  const SameHrFilter: StepFactory = () => {
    if (!conf.formData.sameHrFilter.value) {
      return
    }
    let someSet: Set<string> | null = null
    let uid: string | number | null = null
    return {
      fn: async ({ data }) => {
        uid ??= useUser().getUserId()
        if (uid == null) {
          throw new RetryablePipelineError('没有获取到uid，无法执行同HR去重')
        }
        if (someSet == null) {
          someSet = new Set<string>()
          const data = await counter.storageGet<Record<string, string[]>>(sameHrKey, {})
          for (const id of data[uid] ?? []) {
            someSet.add(id)
          }
        }
        const id = data.encryptBossId
        if (id != null && someSet.has(id)) {
          statistics.todayData.repeat++
          throw new RepeatError('相同hr已投递')
        }
      },
      after: async ({ data }) => {
        uid ??= useUser().getUserId()
        if (uid == null) {
          throw new RetryablePipelineError('没有获取到uid，无法记录同HR去重')
        }
        if (data.encryptBossId == null) return
        someSet?.add(data.encryptBossId)
        const oldData = await counter.storageGet<Record<string, string[]>>(sameHrKey, {})
        await counter.storageSet(sameHrKey, {
          ...oldData,
          [uid]: Array.from(someSet ?? []),
        })
      },
    }
  }

  const goldHunterFilter: StepFactory = () => {
    if (!conf.formData.goldHunterFilter.value) {
      return
    }
    return async ({ data }, _ctx) => {
      if (data?.goldHunter === 1) {
        statistics.todayData.goldHunterFilter++
        throw new GoldHunterError('猎头过滤')
      }
    }
  }

  const companySizeRange: StepFactory = () => {
    if (!conf.formData.companySizeRange.enable) {
      return
    }
    return async ({ data }, _ctx) => {
      try {
        const text = data.brandScaleName
        if (!rangeMatch(text, conf.formData.companySizeRange.value)) {
          throw new CompanySizeError(
            `不匹配的公司规模 ${text}, 预期: ${rangeMatchFormat(conf.formData.companySizeRange.value, '人')}`,
          )
        }
      } catch (e) {
        statistics.todayData.companySizeRange++
        throw new CompanySizeError(errorHandle(e))
      }
    }
  }

  const jobContent: StepFactory = () => {
    if (!conf.formData.jobContent.enable) {
      return
    }
    return async (_, ctx) => {
      try {
        const content = ctx.listData.card?.postDescription.toLowerCase()
        for (const x of conf.formData.jobContent.value) {
          if (!x) {
            continue
          }
          if (content != null && shouldRejectJobContent(content, x)) {
            if (conf.formData.jobContent.include) {
              return
            }
            throw new JobDescriptionError(`工作内容含有排除关键词 [${x}]`)
          }
        }
        if (conf.formData.jobContent.include) {
          throw new JobDescriptionError('工作内容中不包含关键词')
        }
      } catch (e) {
        statistics.todayData.jobContent++
        throw new JobDescriptionError(errorHandle(e))
      }
    }
  }

  const jobFriendStatus: StepFactory = () => {
    if (!conf.formData.friendStatus.value) {
      return
    }
    return async (_, ctx) => {
      const content = ctx.listData.card?.friendStatus

      if (content != null && content !== 0) {
        throw new FriendStatusError('已经是好友了')
      }
    }
  }

  const aiFiltering: StepFactory = () => {
    if (!conf.formData.aiFiltering.enable) {
      return
    }
    return async (_, ctx) => {
      ctx.aiFilteringDecision = undefined
      const minScore = conf.formData.aiFiltering.score ?? DEFAULT_AI_FILTERING_SCORE
      ctx.aiFilteringThreshold = minScore
      try {
        const { content, diagnostics, reasoning_content } = (await runBackgroundAiTask({
          task: 'aiFiltering',
          data: buildAiTaskData(ctx, { filteringThreshold: minScore }),
          json: true,
          timeout: conf.aiTaskTimeoutSeconds,
        })) as messageReps
        addAiTaskDiagnosticsLog(ctx, 'AI匹配度', 'success', diagnostics)
        if (content == null) {
          throw new AIProviderError('AI匹配度返回空内容，无法判断岗位匹配度')
        }
        const { res, message, rating, passed, data } = parseFiltering(content, minScore)

        ctx.aiFilteringAjson = res || {}
        ctx.aiFilteringAtext = message
        ctx.aiFilteringR = reasoning_content
        ctx.matchPercent = rating

        // chatInput.end(message)
        addLogTrace(
          ctx,
          'AI匹配度',
          passed ? 'success' : 'warning',
          `AI匹配度${passed ? '通过' : '跳过'} ${rating}%/${minScore}%`,
          {
            rating,
            minScore,
            passed,
            reason: message,
          },
        )
        if (!passed) {
          statistics.todayData.aiFiltering++
          throw new AIFilteringError(message)
        }
        const selectedFactIds = [...(data?.selectedFactIds ?? [])]
        const claimMode = data != null && 'claimMode' in data ? data.claimMode : undefined
        if (selectedFactIds.length === 0 || (claimMode !== 'adjacent' && claimMode !== 'direct')) {
          throw new AIProviderError('AI匹配度结果缺少有效事实边界')
        }
        ctx.aiFilteringDecision = {
          matchPercent: data?.matchPercent ?? rating,
          level: data?.level ?? 'good',
          reason: data?.reason ?? message,
          risk: data?.risk,
          selectedFactIds,
          claimMode,
        }
      } catch (e) {
        // chatInput.end('Err~')
        if (e instanceof AIFilteringError) {
          throw e
        }
        const message = errorHandle(e)
        addAiTaskDiagnosticsLog(ctx, 'AI匹配度', 'danger', getAiTaskDiagnostics(e))
        // 「模型服务不可用」和「这一次输出不合法」是两回事，之前混在一起用同一个错误抛出，
        // 于是一个岗位的坏输出会停掉整轮。真机上就是这样：储能技术总工这种和候选人毫不
        // 相关的岗位让模型给出了不合法的结果，请求本身 200、有输出，整轮却停在第 4 个。
        //
        // 超时、限流、鉴权、HTTP 错误是服务问题，换个岗位结果一样，该停；
        // 输出解析不了是这一次的问题，跳过这个岗位继续跑。
        if (isRecoverableAiTaskFailure(e)) {
          addLogTrace(ctx, 'AI匹配度', 'warning', `AI匹配度无法评估，已跳过该岗位：${message}`)
          throw new AIFilteringError(`AI匹配度无法评估，已跳过该岗位：${message}`)
        }
        addLogTrace(ctx, 'AI匹配度', 'danger', `AI匹配度评估失败：${message}`)
        throw new AIProviderError(message)
      }
    }
  }

  const activityFilter: StepFactory = () => {
    if (!conf.formData.activityFilter.value) {
      return
    }
    return async (_, ctx) => {
      const decision = evaluateRecruiterActivity({
        activeText: ctx.listData.card?.activeTimeDesc,
        activeTime: ctx.listData.card?.brandComInfo?.activeTime,
      })
      if (decision.status === 'recent') return

      statistics.todayData.activityFilter++
      const reason =
        decision.status === 'stale'
          ? `招聘者超过7日未活跃 [${decision.label}]`
          : `招聘者活跃状态无法确认 [${decision.label}]`
      throw new ActivityError(reason)
    }
  }

  function markGreetingWarning(ctx: logData, e: unknown) {
    const message = errorHandle(e)
    ctx.greetingWarning = `BOSS沟通已建立并计入今日额度，但招呼语未确认发送成功：${message}`
    ctx.greetingSend = {
      ...(ctx.greetingSend ?? {
        ok: false,
        type: 'ai',
      }),
      ok: false,
      error: message,
    }
    addLogTrace(ctx, '招呼语发送', 'warning', ctx.greetingWarning)
    logger.warn('招呼语发送失败，沟通已计入今日额度', e)
  }

  function isPendingGreetingResultUnknown(pending: Awaited<ReturnType<typeof getPendingGreeting>>) {
    return pending?.status?.stage === 'sending' || pending?.status?.stage === 'sent'
  }

  function throwGreetingResultUnknown(
    ctx: logData,
    pendingId: string,
    label: string,
    pending: Awaited<ReturnType<typeof getPendingGreeting>>,
  ): never {
    const message = '招呼语发送结果不确定，请人工核对后再处理'
    ctx.greetingSend = {
      ...(ctx.greetingSend ?? { type: 'ai' }),
      ok: false,
      error: message,
      detail: {
        pendingId,
        confirmed: false,
        resultUnknown: true,
        pendingStatus: pending?.status,
      },
    }
    addLogTrace(ctx, '招呼语发送', 'warning', `${label}${message}`, {
      pendingId,
      pendingStatus: pending?.status,
    })
    throw new GreetError(message)
  }

  async function cancelPendingGreeting(
    ctx: logData,
    pendingId: string,
    uid: string | number,
    label: string,
  ) {
    assertCurrentGreetingUid(uid)
    let removed = false
    try {
      removed = await removePendingGreeting(pendingId, uid)
    } catch (error) {
      addLogTrace(ctx, '招呼语发送', 'warning', `${label}待发送队列取消失败`, {
        pendingId,
        error: errorHandle(error),
      })
      throwGreetingResultUnknown(ctx, pendingId, label, undefined)
    }
    assertCurrentGreetingUid(uid)
    if (removed) return

    let unresolved: Awaited<ReturnType<typeof getPendingGreeting>>
    try {
      unresolved = await getPendingGreeting(pendingId, uid)
    } catch (error) {
      addLogTrace(ctx, '招呼语发送', 'warning', `${label}待发送队列状态确认失败`, {
        pendingId,
        error: errorHandle(error),
      })
      throwGreetingResultUnknown(ctx, pendingId, label, undefined)
    }
    assertCurrentGreetingUid(uid)
    throwGreetingResultUnknown(ctx, pendingId, label, unresolved)
  }

  function assertCurrentGreetingUid(expectedUid: string | number) {
    const currentUid = useUser().getUserId()
    if (currentUid == null || String(currentUid) !== String(expectedUid)) {
      throw new GreetError('账号已切换，已停止当前招呼语发送')
    }
  }

  function assertDeliveryNotStopped() {
    if (common.deliverStop) {
      throw new DeliveryStoppedError('用户已停止投递，未继续发送招呼语')
    }
  }

  function getGreetingSegmentDelayMs(content: string) {
    return greetingSegmentDelayMs(content.length, conf.formData.delay.greetingSegment)
  }

  /** 分段间隔可能有几十秒，用户点停止时必须立刻响应，不能把整段等待走完。 */
  async function delayWithDeliveryStop(ms: number) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      assertDeliveryNotStopped()
      await delay(Math.min(1, Math.max(0, (deadline - Date.now()) / 1000)))
    }
    assertDeliveryNotStopped()
  }

  function markAiGreetingDisabled(ctx: logData, records: GreetingSendRecord[] = []) {
    const sentRecords = records.filter((item) => item.ok)
    const sentLength = sentRecords.reduce((total, item) => total + item.contentLength, 0)
    ctx.message = undefined
    ctx.aiGreetingMessages = undefined
    ctx.aiGreetingMeta = undefined
    ctx.greetingSend = {
      ok: true,
      type: sentRecords.length > 0 ? 'ai' : 'none',
      contentLength: sentLength,
      messageCount: sentRecords.length,
      messages: records,
    }
    addLogTrace(
      ctx,
      '招呼语发送',
      sentRecords.length > 0 ? 'warning' : 'success',
      sentRecords.length > 0
        ? `AI招呼语已关闭，已停止剩余文本；关闭前已发送 ${sentRecords.length} 条`
        : 'AI招呼语已关闭，本次不发送文本',
      {
        cancelled: true,
        sentCount: sentRecords.length,
      },
    )
  }

  async function sendGreetingMessage(args: {
    ctx: logData
    uid: string | number
    content: string
    type: 'ai' | 'custom'
    index?: number
    total?: number
    chatPageState?: { prepared: boolean }
  }) {
    const { ctx, uid, content, type, index, total, chatPageState } = args
    const label = index != null && total != null ? `第 ${index}/${total} 条` : '单条'
    const messageArgs = {
      form_uid: uid.toString(),
      to_uid: ctx.bossData!.data.bossId.toString(),
      to_name: ctx.bossData!.data.encryptBossId,
      content,
    }
    assertDeliveryNotStopped()
    addLogTrace(ctx, '招呼语发送', 'info', `准备发送${label}招呼语`, {
      index,
      total,
      type,
      contentLength: content.length,
      ...getGreetingChannelProbe(),
    })
    assertCurrentGreetingUid(uid)
    try {
      const buf = new Message(messageArgs)
      const channel = buf.send()
      ctx.greetingSend = {
        ok: true,
        type,
        channel,
        contentLength: content.length,
      }
      addLogTrace(ctx, '招呼语发送', 'success', `${label}招呼语已通过 ${channel} 发送`, {
        index,
        total,
        channel,
        contentLength: content.length,
        content,
      })
      return channel
    } catch (e) {
      // 岗位列表页本来就没有聊天 WebSocket，转交聊天页是预期内的常规路径，不是故障。
      // 原先把底层的「无可用发送渠道，可暂时关闭招呼语功能后重试」原样拼进来，
      // 会让每条招呼语都报出一句看似需要用户处理的告警，而它其实随后就发送成功了。
      const detail = getGreetingChannelProbe()
      const expectedFallback = detail.chatWebsocket === 'undefined'
      addLogTrace(
        ctx,
        '招呼语发送',
        'info',
        expectedFallback
          ? `${label}招呼语转交聊天页发送（当前页面没有聊天通道）`
          : `${label}招呼语当前页面 WebSocket 通道不可用，转交聊天页发送：${errorHandle(e)}`,
        detail,
      )
    }

    const pending = await enqueuePendingGreeting({
      type,
      fromUid: messageArgs.form_uid,
      toUid: messageArgs.to_uid,
      toName: messageArgs.to_name,
      content,
      jobName: ctx.listData.jobName,
      brandName: ctx.listData.brandName,
    })
    assertCurrentGreetingUid(uid)
    addLogTrace(ctx, '招呼语发送', 'info', `${label}招呼语已入队，等待聊天页 WebSocket 发送`, {
      pendingId: pending.id,
      index,
      total,
      contentLength: content.length,
      ...getGreetingChannelProbe(),
    })

    if (chatPageState?.prepared !== true) {
      try {
        await openChatPageForGreeting(ctx, pending.id, index, total)
        assertCurrentGreetingUid(uid)
        if (chatPageState) {
          chatPageState.prepared = true
        }
      } catch (e) {
        assertCurrentGreetingUid(uid)
        addLogTrace(ctx, '招呼语发送', 'danger', `${label}招呼语打开聊天页失败`, {
          pendingId: pending.id,
          index,
          total,
          error: errorHandle(e),
        })
        await cancelPendingGreeting(ctx, pending.id, uid, label)
        throw new GreetError(`打开聊天页失败：${errorHandle(e)}`)
      }
    }
    const queuedResult = await waitForQueuedGreeting(ctx, pending.id, uid, total ?? 1, label)
    assertCurrentGreetingUid(uid)
    if (queuedResult.cancelled) {
      await removePendingGreeting(pending.id, uid)
      throw new AiGreetingDisabledError()
    }
    if (queuedResult.ok) {
      ctx.greetingSend = {
        ok: true,
        type,
        channel: 'ChatWebsocket',
        contentLength: content.length,
        detail: { pendingId: pending.id, queued: true },
      }
      addLogTrace(ctx, '招呼语发送', 'success', `${label}招呼语已通过 ChatWebsocket 发送`, {
        pendingId: pending.id,
        index,
        total,
        contentLength: content.length,
        content,
      })
      return 'ChatWebsocket'
    }

    if (isPendingGreetingResultUnknown(queuedResult.pending)) {
      throwGreetingResultUnknown(ctx, pending.id, label, queuedResult.pending)
    }

    if (queuedResult.stopped || common.deliverStop) {
      const cancelled = await claimPendingGreetingForFallback(pending.id, uid)
      assertCurrentGreetingUid(uid)
      if (cancelled != null) {
        throw new DeliveryStoppedError('用户已停止投递，待发送招呼语已取消')
      }
      const unresolved = await getPendingGreeting(pending.id, uid)
      assertCurrentGreetingUid(uid)
      if (isPendingGreetingResultUnknown(unresolved)) {
        throwGreetingResultUnknown(ctx, pending.id, label, unresolved)
      }
      ctx.greetingSend = {
        ok: true,
        type,
        channel: 'ChatWebsocket',
        contentLength: content.length,
        detail: { pendingId: pending.id, queued: true, stoppedAfterConsumption: true },
      }
      addLogTrace(ctx, '招呼语发送', 'success', `${label}招呼语已由聊天页 WebSocket 发送`, {
        pendingId: pending.id,
        index,
        total,
        contentLength: content.length,
      })
      return 'ChatWebsocket'
    }

    addLogTrace(
      ctx,
      '招呼语发送',
      'warning',
      `${label}招呼语聊天页 WebSocket 尚未完成发送，尝试 DOM 兜底`,
      {
        pendingId: pending.id,
        queuedResult,
        pendingStatus: queuedResult.pending?.status,
        index,
        total,
        ...getGreetingChannelProbe(),
      },
    )
    if (!isGeekChatPage()) {
      assertCurrentGreetingUid(uid)
      await cancelPendingGreeting(ctx, pending.id, uid, label)
      ctx.greetingSend = {
        ok: false,
        type,
        channel: 'QueuedChatWebsocket',
        contentLength: content.length,
        detail: {
          pendingId: pending.id,
          confirmed: false,
          pendingStatus: queuedResult.pending?.status,
          message: '当前仍不在聊天页，本次未确认发送成功',
        },
      }
      addLogTrace(ctx, '招呼语发送', 'danger', `${label}招呼语当前仍不在聊天页，未确认发送成功`, {
        pendingId: pending.id,
        index,
        total,
        pendingStatus: queuedResult.pending?.status,
      })
      throw new GreetError(buildQueuedGreetingError(queuedResult.pending))
    }
    assertCurrentGreetingUid(uid)
    const fallbackClaim = await claimPendingGreetingForFallback(pending.id, uid)
    assertCurrentGreetingUid(uid)
    if (fallbackClaim == null) {
      const unresolved = await getPendingGreeting(pending.id, uid)
      assertCurrentGreetingUid(uid)
      if (isPendingGreetingResultUnknown(unresolved)) {
        throwGreetingResultUnknown(ctx, pending.id, label, unresolved)
      }
      ctx.greetingSend = {
        ok: true,
        type,
        channel: 'ChatWebsocket',
        contentLength: content.length,
        detail: { pendingId: pending.id, queued: true, fallbackClaimed: false },
      }
      addLogTrace(
        ctx,
        '招呼语发送',
        'success',
        `${label}招呼语已由聊天页 WebSocket 消费，取消 DOM 兜底`,
        {
          pendingId: pending.id,
          index,
          total,
          contentLength: content.length,
        },
      )
      return 'ChatWebsocket'
    }
    let domResult: Awaited<ReturnType<typeof sendGreetingByDom>>
    try {
      assertCurrentGreetingUid(uid)
      domResult = await sendGreetingByDom(content, uid)
      assertCurrentGreetingUid(uid)
    } catch (e) {
      assertCurrentGreetingUid(uid)
      throw e
    }
    ctx.greetingSend = {
      ok: true,
      type,
      channel: domResult.channel,
      contentLength: content.length,
      detail: domResult.detail,
    }
    addLogTrace(ctx, '招呼语发送', 'success', `${label}招呼语已通过 DOM 发送`, {
      index,
      total,
      contentLength: content.length,
      content,
      detail: domResult.detail,
    })
    return domResult.channel
  }

  async function sendGreetingMessages(args: {
    ctx: logData
    uid: string | number
    messages: string[]
    type: 'ai' | 'custom'
  }) {
    const { ctx, uid, messages, type } = args
    const sendRecords: GreetingSendRecord[] = []
    const totalLength = messages.reduce((acc, item) => acc + item.length, 0)

    ctx.greetingSend = {
      ok: false,
      type,
      contentLength: totalLength,
      messageCount: messages.length,
      messages: sendRecords,
    }

    const chatPageState = { prepared: false }
    for (const [index, content] of messages.entries()) {
      if (type === 'ai' && !isAiGreetingRuntimeEnabled()) {
        markAiGreetingDisabled(ctx, sendRecords)
        return { cancelled: true, records: sendRecords }
      }
      try {
        // 段与段之间要有间隔。原来这个循环是连着跑的：页面自带聊天通道时几段会在几十毫秒内
        // 全部发出去，没有任何人打字是这个速度，这是整条链路上最干净的自动化特征。
        // 队列通道那边本来就有 3~5 秒的节流，只有直发这条路是裸的。
        //
        // 等待放在 try 之内，是为了让「等待期间用户点了停止」仍然给这一段记上一条未发送，
        // 而不是直接抛出循环——用户需要看得到第几段没发出去。
        if (index > 0) {
          const waitMs = getGreetingSegmentDelayMs(content)
          addLogTrace(ctx, '招呼语发送', 'info', `分段间隔等待 ${Math.round(waitMs / 1000)} 秒`, {
            index: index + 1,
            total: messages.length,
            waitMs,
            contentLength: content.length,
          })
          await delayWithDeliveryStop(waitMs)
        }
        assertDeliveryNotStopped()
        // 每一段都是一次真实发送，闸门按段计而不是按岗位计。
        await acquireBossAction('greeting', {
          shouldAbort: () => common.deliverStop,
          onWait: (waitMs) =>
            addLogTrace(
              ctx,
              '动作闸门',
              'info',
              `招呼语发送限速，等待 ${Math.round(waitMs / 1000)} 秒`,
              { index: index + 1, total: messages.length, waitMs },
            ),
        })
        assertDeliveryNotStopped()
        const channel = await sendGreetingMessage({
          ctx,
          uid,
          content,
          type,
          index: index + 1,
          total: messages.length,
          chatPageState,
        })
        sendRecords.push({
          index: index + 1,
          ok: true,
          channel,
          content,
          contentLength: content.length,
        })
      } catch (e) {
        if (e instanceof AiGreetingDisabledError) {
          markAiGreetingDisabled(ctx, sendRecords)
          return { cancelled: true, records: sendRecords }
        }
        sendRecords.push({
          index: index + 1,
          ok: false,
          content,
          contentLength: content.length,
          error: errorHandle(e),
        })
        ctx.greetingSend = {
          ...(ctx.greetingSend ?? { type }),
          ok: false,
          type,
          error: errorHandle(e),
          contentLength: totalLength,
          messageCount: messages.length,
          messages: sendRecords,
        }
        throw e
      }
    }

    ctx.greetingSend = {
      ok: true,
      type,
      channel: sendRecords
        .map((item) => item.channel)
        .filter(Boolean)
        .join(', '),
      contentLength: totalLength,
      messageCount: messages.length,
      messages: sendRecords,
    }
    return { cancelled: false, records: sendRecords }
  }

  /**
   * 招呼语续发时把丢失的岗位详情补回来。
   *
   * card 是运行时字段——里面还挂着 getCard 这种函数，持久化存不住。续发是从投递记录恢复的，
   * 岗位已经不在当前页时 resolveRuntimeJob 造出来的对象就没有 card，而续发走 greetingOnly，
   * 整条 before 流水线连同取详情那一步都跳过了，没有任何地方会把它补上。
   *
   * 原来这里用 `ctx.listData.card!` 直接往下传，requestBossData 读 card.encryptUserId 就崩。
   * 真机上是连崩三次，把三次续发机会全用光：沟通额度已经花掉、招呼语始终没发出去。
   *
   * 补详情要走闸门。这是一次真实的详情请求，BOSS 那边看到的和正常投递的那一次没有区别，
   * 绕过闸门等于在最紧的那类配额上开个后门。
   */
  async function refetchCardForGreeting(ctx: logData, stage: string) {
    addLogTrace(ctx, stage, 'info', '沟通记录缺少岗位详情，重新获取')
    await acquireBossAction('detail', {
      shouldAbort: () => useCommon().deliverStop,
      onWait: (waitMs) =>
        addLogTrace(ctx, '动作闸门', 'info', `详情请求限速，等待 ${Math.round(waitMs / 1000)} 秒`),
    })
    const card = await ctx.listData.getCard()
    if (card == null) {
      throw new GreetError('岗位详情已失效，无法补齐BOSS沟通数据')
    }
    return card
  }

  async function ensureBossDataForGreeting(ctx: logData, stage: string) {
    if (ctx.bossData != null) return ctx.bossData

    addLogTrace(ctx, stage, 'info', '开始获取BOSS沟通数据')
    try {
      const card = ctx.listData.card ?? (await refetchCardForGreeting(ctx, stage))
      const bossData = await requestBossData(card)
      ctx.bossData = bossData
      addLogTrace(ctx, stage, 'success', 'BOSS沟通数据已获取')
      return bossData
    } catch (e) {
      const message = errorHandle(e)
      addLogTrace(ctx, stage, 'danger', `BOSS沟通数据获取失败：${message}`)
      if (e instanceof GreetError) {
        throw e
      }
      throw new GreetError(`BOSS沟通数据获取失败：${message}`, {
        cause: e instanceof Error ? e : undefined,
      })
    }
  }

  async function generateAiGreetingMessages(ctx: logData) {
    ctx.deliveryStage = '打招呼语生成中'
    addLogTrace(ctx, 'AI招呼语', 'info', `开始生成AI招呼语，超时 ${conf.aiTaskTimeoutSeconds} 秒`)
    try {
      const logStore = useLog()
      await logStore.hydrate()
      const { content, diagnostics, reasoning_content } = (await runBackgroundAiTask({
        task: 'aiGreeting',
        data: buildAiTaskData(ctx, {
          filtering: ctx.aiFilteringDecision ? toCloneable(ctx.aiFilteringDecision) : undefined,
          recentGreetings: toCloneable(logStore.recentAiGreetings(10)),
        }),
        json: true,
        timeout: conf.aiTaskTimeoutSeconds,
      })) as messageReps
      addAiTaskDiagnosticsLog(ctx, 'AI招呼语', 'success', diagnostics)
      if (content == null) {
        throw new AIProviderError('AI招呼语返回空内容，无法生成可发送消息')
      }
      const draft = parseGreetingDraft(content, conf.formData.aiGreeting.messageCount)
      const greetingMessages = draft.messages
      ctx.message = greetingMessages.join('\n')
      ctx.aiGreetingA = content
      ctx.aiGreetingMessages = greetingMessages
      ctx.aiGreetingMeta = {
        usedFactIds: [...draft.usedFactIds],
        claimMode: draft.claimMode,
        openingPattern: draft.openingPattern,
        fingerprint: fingerprintGreeting(greetingMessages),
      }
      ctx.aiGreetingR = reasoning_content
      const totalLength = greetingMessages.reduce((acc, item) => acc + item.length, 0)
      addLogTrace(
        ctx,
        'AI招呼语',
        'success',
        `AI招呼语已生成 ${greetingMessages.length} 条，合计 ${totalLength} 字`,
        {
          messages: greetingMessages,
          totalLength,
          rawLength: content.length,
        },
      )
      addLogTrace(ctx, '话术样本', 'info', 'AI招呼语样本已记录，可用于后续复盘', {
        jobName: ctx.listData.jobName,
        brandName: ctx.listData.brandName,
        bossName: ctx.bossData?.data.name ?? ctx.listData.card?.bossName ?? ctx.listData.bossName,
        matchPercent: ctx.matchPercent,
        aiFilteringSummary: ctx.aiFilteringAtext,
        messages: greetingMessages,
        totalLength,
      })
      return greetingMessages
    } catch (e) {
      const message = errorHandle(e)
      addAiTaskDiagnosticsLog(ctx, 'AI招呼语', 'danger', getAiTaskDiagnostics(e))
      addLogTrace(ctx, 'AI招呼语', 'danger', `AI招呼语生成失败：${message}`)
      if (e instanceof GreetError) {
        throw e
      }
      throw new GreetError(`AI招呼语生成失败：${message}`, {
        cause: e instanceof Error ? e : undefined,
      })
    }
  }

  async function waitForQueuedGreeting(
    ctx: logData,
    pendingId: string,
    expectedUid: string | number,
    total = 1,
    label = '单条',
  ): Promise<{
    ok: boolean
    cancelled?: boolean
    stopped?: boolean
    pending?: Awaited<ReturnType<typeof getPendingGreeting>>
  }> {
    const configuredMs = conf.formData.delay.messageSending * 1000
    const minimumMs = Math.max(90000, total * 35000)
    const timeoutMs = getPendingGreetingWaitTimeoutMs(conf.formData.delay.messageSending, total)
    const startedAt = Date.now()
    const deadline = Date.now() + timeoutMs
    let pending: Awaited<ReturnType<typeof getPendingGreeting>>
    let lastStatusKey: string | null = ''
    addLogTrace(ctx, '招呼语发送', 'info', `${label}招呼语等待聊天页确认发送`, {
      pendingId,
      timeoutMs,
      configuredMs,
      minimumMs,
    })
    while (Date.now() < deadline) {
      if (common.deliverStop) return { ok: false, stopped: true, pending }
      assertCurrentGreetingUid(expectedUid)
      pending = await getPendingGreeting(pendingId, expectedUid)
      assertCurrentGreetingUid(expectedUid)
      if (pending == null) return { ok: true }
      if (pending.status?.stage === 'cancelled') {
        return { ok: false, cancelled: true, pending }
      }
      if (isPendingGreetingResultUnknown(pending)) return { ok: false, pending }
      // 只按阶段去重：reason 里带毫秒倒计时（「剩余 3502ms」），整段比较会让
      // 每一次轮询都被判为新状态，于是每秒写一条 trace——单个岗位能刷出 40 多条，
      // 既淹没日志也白白吃掉存储配额。阶段变化才是诊断需要的信息。
      const statusKey = pending.status?.stage ?? null
      if (statusKey !== lastStatusKey) {
        lastStatusKey = statusKey
        addLogTrace(ctx, '招呼语发送', 'info', `${label}招呼语仍在等待发送确认`, {
          pendingId,
          waitedMs: Date.now() - startedAt,
          pendingStatus: pending.status,
        })
      }
      await sleep(500)
      assertCurrentGreetingUid(expectedUid)
    }
    return { ok: false, pending }
  }

  function buildQueuedGreetingError(pending?: Awaited<ReturnType<typeof getPendingGreeting>>) {
    const reason = pending?.status?.reason
    return reason
      ? `招呼语已入队，但未确认发送成功：${reason}`
      : '招呼语已入队，但未在本次投递中确认发送成功'
  }

  async function openChatPageForGreeting(
    ctx: logData,
    pendingId: string,
    index?: number,
    total?: number,
  ) {
    const targetUrl = buildGeekChatUrl(
      ctx.bossData?.data.encryptBossId ?? ctx.listData.encryptBossId,
    )
    if (isGeekChatPage()) {
      addLogTrace(ctx, '招呼语发送', 'info', '当前已在聊天页，等待聊天页消费招呼语队列', {
        pendingId,
        index,
        total,
        targetUrl,
        ...getGreetingChannelProbe(),
      })
      return
    }

    const tab = await counter.openChatTab(targetUrl)
    addLogTrace(ctx, '招呼语发送', 'info', '已打开BOSS聊天页，等待聊天页WebSocket消费招呼语队列', {
      pendingId,
      index,
      total,
      targetUrl,
      tab,
      ...getGreetingChannelProbe(),
    })
  }

  function getGreetingChannelProbe() {
    const client = window.ChatWebsocket?.client
    let chatConnected: unknown
    try {
      chatConnected = client?.isConnected?.()
    } catch (e) {
      chatConnected = errorHandle(e)
    }
    return {
      url: location.href,
      isGeekChat: window._PAGE?.isGeekChat,
      geekChatCore: typeof window.GeekChatCore,
      chatWebsocket: typeof window.ChatWebsocket,
      chatWebsocketSend: typeof window.ChatWebsocket?.send,
      chatWebsocketClient: typeof client,
      chatWebsocketConnected: chatConnected,
    }
  }

  function isGeekChatPage() {
    return isGeekChatUrl(location.href)
  }

  async function sendGreetingByDom(
    content: string,
    expectedUid: string | number,
  ): Promise<{
    channel: 'DOM'
    detail: Record<string, unknown>
  }> {
    const detail: Record<string, unknown> = {
      url: location.href,
      isGeekChat: window._PAGE?.isGeekChat,
    }
    const input = await waitForChatInput(8000)
    assertDeliveryNotStopped()
    assertCurrentGreetingUid(expectedUid)
    detail.inputFound = input != null
    detail.inputSelector = input?.selector
    if (input == null) {
      throw new GreetError('未找到聊天输入框')
    }

    setEditableText(input.el, content)
    detail.inputTextLength = getEditableText(input.el).length

    const sendButton = await waitForSendButton(2500)
    assertDeliveryNotStopped()
    assertCurrentGreetingUid(expectedUid)
    detail.sendButtonFound = sendButton != null
    detail.sendButtonText = sendButton?.textContent?.trim()

    if (sendButton != null) {
      sendButton.click()
    } else {
      input.el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )
    }
    await sleep(500)
    assertCurrentGreetingUid(expectedUid)

    return {
      channel: 'DOM',
      detail,
    }
  }

  async function waitForChatInput(timeoutMs: number) {
    const selectors = [
      '#chat-input',
      '.chat-input',
      '.input-area textarea',
      '.input-area [contenteditable="true"]',
      '.chat-editor textarea',
      '.chat-editor [contenteditable="true"]',
      '.message-input textarea',
      '.message-input [contenteditable="true"]',
      '.chat-message-input textarea',
      '.chat-message-input [contenteditable="true"]',
      'textarea[placeholder*="聊"]',
      'textarea[placeholder*="消息"]',
      '[contenteditable="true"]',
      'textarea',
    ]
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      assertDeliveryNotStopped()
      for (const selector of selectors) {
        const el = document.querySelector<HTMLElement>(selector)
        if (el != null && isVisible(el) && !isDisabled(el)) {
          return { el, selector }
        }
      }
      await sleep(250)
    }
    return null
  }

  async function waitForSendButton(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      assertDeliveryNotStopped()
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('button, .btn, [role="button"], a'),
      )
      const button = candidates.find((el) => {
        const text = el.textContent?.trim() ?? ''
        return isVisible(el) && !isDisabled(el) && /^(发送|发\s*送|Send)$/i.test(text)
      })
      if (button != null) {
        return button
      }
      await sleep(250)
    }
    return null
  }

  function setEditableText(el: HTMLElement, content: string) {
    el.focus()
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      el.value = content
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }

    el.textContent = content
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: content, inputType: 'insertText' }),
    )
  }

  function getEditableText(el: HTMLElement) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return el.value
    }
    return el.textContent ?? ''
  }

  function isVisible(el: HTMLElement) {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    )
  }

  function isDisabled(el: HTMLElement) {
    return (
      (el instanceof HTMLButtonElement ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement) &&
      el.disabled
    )
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  const aiGreeting: StepFactory = () => {
    return {
      after: async (args, ctx) => {
        try {
          if (!isAiGreetingRuntimeEnabled()) {
            markAiGreetingDisabled(ctx)
            return
          }
          const uid = useUser().getUserId()
          if (uid == null) {
            throw new GreetError('没有获取到uid')
          }
          await ensureBossDataForGreeting(ctx, 'AI招呼语')
          if (!isAiGreetingRuntimeEnabled()) {
            markAiGreetingDisabled(ctx)
            return
          }
          const greetingMessages = await generateAiGreetingMessages(ctx)
          // chatInput.end(content)
          ctx.deliveryStage = '正在打招呼'
          const result = await sendGreetingMessages({
            ctx,
            uid,
            messages: greetingMessages,
            type: 'ai',
          })
          if (result.cancelled) return
          addLogTrace(
            ctx,
            '招呼语发送',
            'success',
            `AI招呼语${greetingMessages.length}条已全部发送`,
            result.records,
          )
        } catch (e) {
          // chatInput.end('Err~')
          markGreetingWarning(ctx, e)
          throw e
        }
      },
    }
  }

  const greeting: StepFactory = () => {
    return aiGreeting()
  }

  const retryGreeting: Handler = async (_, ctx) => {
    if (!isAiGreetingRuntimeEnabled() || ctx.greetingSend?.type === 'none') {
      ctx.message = undefined
      ctx.aiGreetingMessages = undefined
      ctx.greetingSend = {
        ok: true,
        type: 'none',
        contentLength: 0,
        messageCount: 0,
        messages: [],
      }
      addLogTrace(ctx, '招呼语发送', 'success', 'AI招呼语未开启，已跳过文本补发', {
        messageCount: 0,
      })
      return
    }
    const uid = useUser().getUserId()
    if (uid == null) {
      throw new GreetError('没有获取到uid')
    }
    if (ctx.bossData == null) {
      await ensureBossDataForGreeting(ctx, 'AI招呼语')
    }

    let existingMessages = ctx.aiGreetingMessages?.length
      ? ctx.aiGreetingMessages
      : ctx.message
          ?.split('\n')
          .map((item) => item.trim())
          .filter(Boolean)
    const sentIndexes = new Set(
      ctx.greetingSend?.messages?.filter((item) => item.ok).map((item) => item.index) ?? [],
    )
    const existingType = 'ai' as const
    if (existingType === 'ai' && existingMessages?.length && !ctx.aiGreetingMeta) {
      if (sentIndexes.size > 0) {
        throw new GreetError('旧招呼语缺少质量元数据，停止自动补发')
      }
      addLogTrace(ctx, 'AI招呼语', 'info', '旧招呼语缺少质量元数据，丢弃缓存并重新生成')
      existingMessages = undefined
      ctx.aiGreetingMessages = undefined
      ctx.message = undefined
    }
    if (!existingMessages?.length) {
      if (!isAiGreetingRuntimeEnabled()) {
        throw new GreetError('没有可续发的招呼语内容')
      }
      addLogTrace(ctx, 'AI招呼语', 'info', '没有可续发的招呼语内容，重新生成AI招呼语')
      existingMessages = await generateAiGreetingMessages(ctx)
    }

    const pendingMessages = existingMessages
      .map((content, index) => ({ content, index: index + 1 }))
      .filter((item) => !sentIndexes.has(item.index))

    if (pendingMessages.length === 0) {
      ctx.greetingSend = {
        ...(ctx.greetingSend ?? {
          type: 'ai',
        }),
        ok: true,
        messageCount: existingMessages.length,
      }
      addLogTrace(ctx, '招呼语发送', 'success', '招呼语已全部发送，无需补发')
      return
    }

    const type = existingType
    const mergedRecords = [...(ctx.greetingSend?.messages ?? [])]
    const totalLength = existingMessages.reduce((acc, item) => acc + item.length, 0)

    ctx.greetingSend = {
      ok: false,
      type,
      contentLength: totalLength,
      messageCount: existingMessages.length,
      messages: mergedRecords,
    }

    const chatPageState = { prepared: false }
    for (const item of pendingMessages) {
      try {
        const channel = await sendGreetingMessage({
          ctx,
          uid,
          content: item.content,
          type,
          index: item.index,
          total: existingMessages.length,
          chatPageState,
        })
        mergedRecords.push({
          index: item.index,
          ok: true,
          channel,
          content: item.content,
          contentLength: item.content.length,
        })
      } catch (e) {
        mergedRecords.push({
          index: item.index,
          ok: false,
          content: item.content,
          contentLength: item.content.length,
          error: errorHandle(e),
        })
        ctx.greetingSend = {
          ...(ctx.greetingSend ?? { type }),
          ok: false,
          type,
          error: errorHandle(e),
          contentLength: totalLength,
          messageCount: existingMessages.length,
          messages: mergedRecords,
        }
        throw e
      }
    }

    ctx.greetingSend = {
      ok: true,
      type,
      channel: mergedRecords
        .map((item) => item.channel)
        .filter(Boolean)
        .join(', '),
      contentLength: totalLength,
      messageCount: existingMessages.length,
      messages: mergedRecords,
    }
    addLogTrace(ctx, '招呼语发送', 'success', '招呼语已续发完成', mergedRecords)
  }

  function amapHandler(
    id: string,
    distance: number,
    duration: number,
    amap?: { ok: boolean; distance: number; duration: number },
  ) {
    if (distance <= 0 && duration <= 0) return
    if (!amap || amap.ok === false) {
      throw new JobDataIncompleteError(`高德地图${id}距离数据不可用`)
    }
    if (distance > 0 && amap.distance > distance * 1000) {
      throw new JobAddressError(`${id}距离超标: ${amap.distance / 1000} km，设定: ${distance} km`)
    }
    if (duration > 0 && amap.duration > duration * 60) {
      throw new JobAddressError(`${id}时间超标: ${amap.duration / 60} 分钟，设定: ${duration} 分钟`)
    }
  }

  const amap: StepFactory = () => {
    if (!COMMUTE_FEATURE_AVAILABLE || !conf.formData.amap.enable) {
      return
    }
    return async (_, ctx) => {
      try {
        const modes = {
          straight: conf.formData.amap.straightDistance > 0,
          driving: conf.formData.amap.drivingDistance > 0 || conf.formData.amap.drivingDuration > 0,
          walking: conf.formData.amap.walkingDistance > 0 || conf.formData.amap.walkingDuration > 0,
        }
        if (!modes.straight && !modes.driving && !modes.walking) return
        if (!conf.formData.amap.key.trim()) {
          throw new RetryablePipelineError('高德地图 Key 未配置')
        }
        if (!conf.formData.amap.origins.trim()) {
          throw new RetryablePipelineError('通勤起点未配置')
        }
        const address = ctx.listData.card?.address?.trim()
        if (!address) {
          throw new JobDataIncompleteError('岗位地址为空，无法执行通勤过滤')
        }

        const [origin, destination] = await Promise.all([
          resolveCommuteOrigin(),
          resolveAmapLocation(address),
        ])
        const distance = await amapDistance(destination.location, origin.location, modes)
        ctx.amap = {
          geocode: destination.geocode,
          distance,
        }
        addLogTrace(ctx, '通勤过滤', 'success', '岗位地址与通勤距离已解析', {
          address,
          destination: destination.location,
          distance,
        })

        amapHandler('直线', conf.formData.amap.straightDistance, 0, distance.straight)
        amapHandler(
          '驾车',
          conf.formData.amap.drivingDistance,
          conf.formData.amap.drivingDuration,
          distance.driving,
        )
        amapHandler(
          '步行',
          conf.formData.amap.walkingDistance,
          conf.formData.amap.walkingDuration,
          distance.walking,
        )
      } catch (error) {
        if (error instanceof JobAddressError) {
          statistics.todayData.amap++
          throw error
        }
        if (error instanceof RetryablePipelineError) throw error
        throw new JobDataIncompleteError(`通勤距离获取失败：${errorHandle(error)}`, {
          cause: error instanceof Error ? error : undefined,
        })
      }
    }
  }

  return {
    communicated,
    SameCompanyFilter,
    SameHrFilter,
    goldHunterFilter,
    companySizeRange,
    jobContent,
    jobFriendStatus,
    aiFiltering,
    activityFilter,
    greeting,
    retryGreeting,
    amap,
  }
}
