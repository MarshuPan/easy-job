import { defineStore } from 'pinia'
import { ref } from 'vue'

import {
  cachePipelineResult,
  createHandle,
  errorHandle,
  sendPublishReq,
} from '@/composables/useApplying'
import { useCommon } from '@/composables/useCommon'
import { createEmptyStatistics, useStatistics } from '@/composables/useStatistics'
import { useConf } from '@/stores/conf'
import type { MyJobListData } from '@/stores/jobs'
import { jobList } from '@/stores/jobs'
import type { DeliveryStage, log, logData, logErr } from '@/stores/log'
import { addLogTrace } from '@/stores/log'
import { useLog } from '@/stores/log'
import {
  AIProviderError,
  AgentDeliveryError,
  DeliveryStoppedError,
  GreetError,
  JobDataIncompleteError,
  JobUnavailableError,
  LimitError,
  PublishError,
  RateLimitError,
  RetryablePipelineError,
  UnknownError,
} from '@/types/deliverError'
import type { FormData } from '@/types/formData'
import { AgentMessage } from '@/ui/instrument'
import { delay, getCurDay } from '@/utils'
import { ActionGateTimeoutError } from '@/utils/actionGate'
import { acquireBossAction, getCurrentPaceMultiplier } from '@/utils/actionGateStore'
import { sampleHumanDelayMs } from '@/utils/humanPace'
import { logger } from '@/utils/logger'
import { getProviderHeartbeatDiagnostic, isProviderHeartbeatError } from '@/utils/providerHealth'
import {
  isStorageQuotaError,
  shouldReportStorageQuota,
  STORAGE_QUOTA_ERROR_MESSAGE,
} from '@/utils/storageQuota'

import {
  DAILY_DELIVERY_LIMIT,
  type DeliveryLimitSource,
  getDeliveryLimitSource,
  hasDailyDeliveryRemaining,
} from '../utils/deliveryLimit'
import type { DeliveryBatchItem } from '../utils/deliveryQueue'
import { getJobSourceLabel } from '../utils/jobExpectations'

export type JobListHandleResult =
  | 'completed'
  | 'sourceLimit'
  | 'stopped'
  | 'terminalError'
  | 'aiUnavailable'
  | 'rateLimited'
type ProcessJobResult =
  | 'success'
  | 'failed'
  | 'sourceLimit'
  | 'stopped'
  | 'terminalError'
  | 'aiUnavailable'
  | 'rateLimited'
type ProcessMode = 'full' | 'greetingOnly'
type PublishPhase = 'sent' | 'confirmed' | 'unknown'
const maxManualJobRetries = 3
/**
 * 连续这么多个岗位取详情失败，就不再当成「这些岗位恰好都下线了」。
 *
 * 详情失败原来一律翻译成「岗位已失效或已下线」，然后跳过、继续下一个。这个翻译是猜的：
 * 代码没有看失败原因，只知道请求没成功。真机上连续 11 个岗位被这样判掉，投递照常往下跑，
 * 而日志里没有任何东西能说明到底出了什么事。
 *
 * 投递池里的岗位是几分钟前刚抓的，连着三个恰好同时下线讲不通。所以连续三次就停下来——
 * 不是因为知道原因，恰恰是因为不知道：一个还没查清的故障，不该由它决定后面几十个岗位
 * 的命运。停下来把真实报错摆出来，比继续跑有用。
 */
const unevaluableJobLimit = 3
/**
 * 只看不投的岗位，占用单岗位目标耗时的比例区间。
 *
 * 人打开一个 JD 看完觉得不合适就划走，比认真投一个快，但也不会是零。
 */
const browseOnlyMinRatio = 0.3
const browseOnlyMaxRatio = 0.55

export const useDeliver = defineStore('zhipin/deliver', () => {
  const total = ref(0)
  const current = ref(0)
  const currentData = ref<MyJobListData>()
  const log = useLog()
  const statistics = useStatistics()
  const common = useCommon()
  const liveConf = useConf()
  let activeRuntimeFormData: FormData | null = null
  const conf = {
    get formData() {
      return activeRuntimeFormData ?? liveConf.formData
    },
  }
  const isAiGreetingRuntimeEnabled = () =>
    conf.formData.aiGreeting.enable && liveConf.formData.aiGreeting.enable
  const terminalError = ref('')
  /** 触发平台限流后本次运行额外增加的单岗间隔（秒），随每次 jobListHandle 重置。 */
  let rateLimitBackoffSeconds = 0
  let consecutiveUnevaluableJobs = 0
  function resetBatchPace() {
    // 兼容操作面板调用；批量休息按今日累计成功数判断，避免页面跳转后漏休息。
  }

  function setDeliveryStage(ctx: logData, data: MyJobListData, stage: DeliveryStage, record?: log) {
    ctx.deliveryStage = stage
    // 完整 Record 而不是 Partial + ?? 兜底：新增阶段时必须显式给出它对应的岗位状态，
    // 否则会静默落到 running，而 running 是「可投递」，岗位就又回到队列里了。
    const statusMap: Record<DeliveryStage, Parameters<typeof data.status.setStatus>[0]> = {
      待处理: 'wait',
      JD筛选中: 'running',
      打招呼语生成中: 'running',
      正在建立沟通: 'running',
      正在打招呼: 'running',
      投递成功: 'success',
      已过滤: 'filtered',
      投递失败: 'error',
    }
    data.status.setStatus(statusMap[stage], stage)
    if (record) {
      log.touchDelivery(record, ctx)
    }
  }

  function inferFailureStage(ctx: logData): DeliveryStage {
    if (ctx.publish?.ok === true && ctx.greetingSend?.ok !== true) return '正在打招呼'
    if (ctx.deliveryStage && ctx.deliveryStage !== '投递失败') return ctx.deliveryStage
    if (ctx.publish) return '正在建立沟通'
    if (ctx.aiGreetingA || ctx.greetingWarning) return '打招呼语生成中'
    return 'JD筛选中'
  }

  function canRetryError(e: AgentDeliveryError, ctx: logData) {
    if (e instanceof LimitError) return false
    if (e.state === 'warning') return false
    if (ctx.publish?.ok === true && ctx.greetingSend?.ok !== true) {
      const detail = ctx.greetingSend?.detail
      if (
        typeof detail === 'object' &&
        detail != null &&
        (detail as Record<string, unknown>).resultUnknown === true
      ) {
        return false
      }
      return true
    }
    return (
      e instanceof AIProviderError ||
      e instanceof RetryablePipelineError ||
      e instanceof PublishError ||
      e instanceof RateLimitError ||
      e instanceof UnknownError
    )
  }

  function getRetryMode(record: log): ProcessMode {
    const data = record.data
    return data?.publish?.ok === true && data?.greetingSend?.ok !== true ? 'greetingOnly' : 'full'
  }

  function getPublishPhase(ctx: logData): PublishPhase | undefined {
    return (ctx.publish as (typeof ctx.publish & { phase?: PublishPhase }) | undefined)?.phase
  }

  function countCommunicationAgainstDailyLimit(ctx: logData, confirmed: boolean) {
    if (ctx.communicationCounted || (confirmed && ctx.publish?.ok !== true)) return false
    ctx.communicationCounted = true
    statistics.todayData.success++
    const limitSource = ctx.deliverySource ?? getDeliveryLimitSource()
    const successKey = limitSource === 'group' ? 'groupSuccess' : 'searchSuccess'
    statistics.todayData[successKey] = (statistics.todayData[successKey] ?? 0) + 1
    addLogTrace(
      ctx,
      '投递接口',
      confirmed ? 'success' : 'warning',
      confirmed ? '已建立沟通并计入今日额度' : '投递结果未确认，已按可能建立沟通计入今日额度',
    )
    return true
  }

  function countConfirmedCommunication(ctx: logData) {
    return countCommunicationAgainstDailyLimit(ctx, true)
  }

  function countUnknownCommunication(ctx: logData) {
    return countCommunicationAgainstDailyLimit(ctx, false)
  }

  function assertDeliveryNotStopped(message: string) {
    if (common.deliverStop) throw new DeliveryStoppedError(message)
  }

  async function processJob(
    data: MyJobListData,
    chandle: Awaited<ReturnType<typeof createHandle>>,
    options: {
      index?: number
      total?: number
      record?: log
      mode?: ProcessMode
      source?: ReturnType<typeof getDeliveryLimitSource>
    } = {},
  ): Promise<ProcessJobResult> {
    const jobStartedAt = Date.now()
    // 闸门只管「不许超过」，真正决定吞吐的是这个目标耗时。同一条会话曲线必须同时作用在
    // 两边，否则调闸门是白调的：刚开工的一段快，跑久了慢，歇一会儿再回到快。
    const currentPaceMultiplier = await getCurrentPaceMultiplier()
    const targetJobDuration = getRandomJobDurationMs(currentPaceMultiplier)
    const mode = options.mode ?? 'full'
    const isRetry = options.record != null
    let delivered = false
    let shouldWaitForHumanLikePace = false
    let shouldWaitForBatchRest = false
    let shouldCachePipeline = true
    // 这个岗位是不是「根本没评上」——详情取不到、数据缺字段。它决定连续计数加还是清。
    let jobWasUnevaluable = false
    let shouldCountTotal = !isRetry
    const ctx: logData = options.record?.data ?? { listData: data }
    ctx.listData = data
    ctx.deliverySource = options.source ?? ctx.deliverySource ?? getDeliveryLimitSource()
    ctx.deliverySourceName = getJobSourceLabel(
      ctx.deliverySource,
      data,
      liveConf.availableJobExpectations,
    )
    ctx.failureReason = undefined
    ctx.failureStage = undefined
    ctx.retryable = false
    const record = options.record ?? log.startDelivery(data, ctx)

    try {
      await ensureTodayStatisticsSafely(ctx, record)
      assertDeliveryNotStopped('用户已停止投递，当前岗位尚未开始处理')
      if (!isRetry && !hasDailyDeliveryRemaining(statistics.todayData)) {
        const msg = `今日投递已达到 ${DAILY_DELIVERY_LIMIT}，已停止投递`
        addLogTrace(ctx, '流程', 'warning', msg)
        common.deliverStop = true
        return 'sourceLimit'
      }
      setDeliveryStage(ctx, data, mode === 'greetingOnly' ? '正在打招呼' : 'JD筛选中', record)
      currentData.value = data
      try {
        addLogTrace(
          ctx,
          '流程',
          'info',
          mode === 'greetingOnly'
            ? '从打招呼阶段重试，跳过建立沟通接口'
            : `开始处理第 ${(options.index ?? 0) + 1}/${options.total ?? 1} 个岗位`,
        )

        if (mode === 'full') {
          for (const h of chandle.before) {
            assertDeliveryNotStopped('用户已停止投递，当前岗位未建立沟通')
            await h({ data }, ctx)
          }
          addLogTrace(ctx, '前置筛选', 'success', '前置筛选通过，准备投递')
          assertDeliveryNotStopped('用户已停止投递，当前岗位未建立沟通')
          setDeliveryStage(ctx, data, '正在建立沟通', record)
          await acquireBossAction('publish', {
            shouldAbort: () => common.deliverStop,
            onWait: (waitMs) =>
              addLogTrace(
                ctx,
                '动作闸门',
                'info',
                `投递限速，等待 ${Math.round(waitMs / 1000)} 秒`,
              ),
          })
          assertDeliveryNotStopped('用户已停止投递，当前岗位未建立沟通')
          await sendPublishReq(data, undefined, 3, {}, ctx)
          shouldWaitForBatchRest = countConfirmedCommunication(ctx)
          shouldWaitForHumanLikePace = true
          addLogTrace(ctx, '投递后处理', 'info', `开始执行 ${chandle.after.length} 个投递后处理`)
        }

        setDeliveryStage(ctx, data, '正在打招呼', record)
        if (shouldWaitForBatchRest) {
          await flushJobRunState(ctx, record, '已建立沟通，进入招呼语阶段')
        }
        if (mode === 'greetingOnly') {
          if (isAiGreetingRuntimeEnabled()) {
            assertDeliveryNotStopped('用户已停止投递，未继续补发招呼语')
          }
          await chandle.retryGreeting({ data }, ctx)
        } else {
          for (const [afterIndex, h] of chandle.after.entries()) {
            if (isAiGreetingRuntimeEnabled()) {
              assertDeliveryNotStopped('用户已停止投递，未继续发送招呼语')
            }
            const label = `第 ${afterIndex + 1}/${chandle.after.length} 个投递后处理`
            setDeliveryStage(
              ctx,
              data,
              isAiGreetingRuntimeEnabled() ? '打招呼语生成中' : '正在打招呼',
              record,
            )
            addLogTrace(ctx, '投递后处理', 'info', `${label}开始`)
            try {
              await h({ data }, ctx)
              addLogTrace(ctx, '投递后处理', 'success', `${label}完成`)
            } catch (e) {
              addLogTrace(ctx, '投递后处理', 'danger', `${label}失败：${errorHandle(e)}`)
              throw e
            }
            if (ctx.greetingSend?.ok !== true) {
              setDeliveryStage(ctx, data, '正在打招呼', record)
            }
          }
        }
        if (isAiGreetingRuntimeEnabled()) {
          if (ctx.greetingSend?.ok !== true) {
            throw new GreetError('招呼语未确认发送成功')
          }
        }
        delivered = true
        ctx.failureReason = undefined
        ctx.failureStage = undefined
        ctx.retryable = false
        ctx.greetingWarning = undefined
        ctx.err = undefined
        ctx.state = '成功'
        setDeliveryStage(ctx, data, '投递成功', record)
        addLogTrace(ctx, '流程', 'success', '岗位处理完成')
        log.finishDelivery(record, null, ctx, ctx.message)
        logger.debug('投递成功', ctx)
        if (mode === 'full' && statistics.todayData.success >= DAILY_DELIVERY_LIMIT) {
          const msg = `今日投递已达到 ${DAILY_DELIVERY_LIMIT}`
          AgentMessage.info(msg)
          return 'sourceLimit'
        }
        return 'success'
      } catch (e: any) {
        const publishPhase = getPublishPhase(ctx)
        if (e instanceof ActionGateTimeoutError) {
          // 等到闸门超时，说明撞上了硬顶——那是「跑太快」的信号，不是这个岗位的错。
          // 原来它顺着未知错误走成岗位失败并清掉检查点，方向正好反了：应该停下来、
          // 检查点保住，等节奏缓过来再继续。
          //
          // 判断要放在这个 catch 的最前面：后面几条分支会按 publishPhase 先把它领走。
          shouldCachePipeline = false
          shouldCountTotal = false
          // 沟通已经建立时不能放回待处理，否则「继续」会对同一个 boss 重复建联、额度重复计。
          if (ctx.publish?.ok === true) {
            data.status.setStatus('warn', '已建立沟通，招呼语未完成，可从记录中继续')
          } else {
            data.status.setStatus('wait', '等待中')
          }
          addLogTrace(ctx, '流程', 'warning', `动作闸门限速超时，已暂停：${e.message}`)
          AgentMessage.warning('操作过于频繁，已暂停投递')
          common.deliverStop = true
          terminalError.value = e.message
          return 'aiUnavailable'
        }
        if (
          (publishPhase === 'sent' || publishPhase === 'unknown') &&
          !isProviderHeartbeatError(e)
        ) {
          shouldWaitForBatchRest = countUnknownCommunication(ctx)
          shouldWaitForHumanLikePace = true
          const failureStage = inferFailureStage(ctx)
          const failureReason = e instanceof Error ? e.message : String(e)
          shouldCachePipeline = false
          shouldCountTotal = false
          setDeliveryStage(ctx, data, '投递失败', record)
          ctx.failureStage = failureStage
          ctx.failureReason = failureReason
          ctx.retryable = false
          ctx.state = '结果未知'
          ctx.err = failureReason
          addLogTrace(ctx, '投递接口', 'warning', '投递请求结果未知，需人工核对', {
            error: failureReason,
          })
          log.touchDelivery(record, ctx)
          data.status.setStatus('warn', '投递请求结果不确定，需人工核对后再处理')
          logger.warn('投递请求结果未知，已停止自动重试', { error: failureReason })
          return statistics.todayData.success >= DAILY_DELIVERY_LIMIT ? 'sourceLimit' : 'failed'
        }
        if (isProviderHeartbeatError(e)) {
          if (publishPhase === 'sent' || publishPhase === 'unknown') {
            shouldWaitForBatchRest = countUnknownCommunication(ctx)
            shouldWaitForHumanLikePace = true
          }
          const failureStage = inferFailureStage(ctx)
          const diagnostic = {
            ...getProviderHeartbeatDiagnostic(e),
            jobId: data.encryptJobId,
            jobName: data.jobName,
            reason: '岗位执行链路Provider心跳异常',
            source: ctx.deliverySource ?? getDeliveryLimitSource(),
            stage: failureStage,
          }
          shouldCachePipeline = false
          shouldCountTotal = false
          setDeliveryStage(ctx, data, '投递失败', record)
          ctx.failureStage = failureStage
          ctx.failureReason = diagnostic.error
          ctx.retryable = publishPhase !== 'sent' && publishPhase !== 'unknown'
          ctx.state = '通信异常'
          ctx.err = diagnostic.error
          addLogTrace(
            ctx,
            '通信桥',
            'danger',
            `Provider心跳异常，交由批次层重试当前页：${diagnostic.error}`,
            diagnostic,
          )
          log.touchDelivery(record, ctx)
          if (publishPhase === 'sent' || publishPhase === 'unknown') {
            data.status.setStatus('warn', '投递请求结果不确定，需人工核对后再处理')
          } else if (ctx.publish?.ok === true) {
            data.status.setStatus('warn', '已建立沟通但后续状态不确定，需核对后重试招呼语')
          } else {
            data.status.setStatus('wait', '通信异常，等待重试当前岗位')
          }
          logger.warn('Provider心跳异常，交由批次层重试当前页', diagnostic)
          throw e
        }
        if (e instanceof DeliveryStoppedError) {
          const failureStage = inferFailureStage(ctx)
          const communicationEstablished = ctx.publish?.ok === true
          shouldCachePipeline = false
          shouldCountTotal = false
          setDeliveryStage(ctx, data, '投递失败', record)
          ctx.failureStage = failureStage
          ctx.failureReason = e.message
          ctx.retryable = !communicationEstablished || ctx.greetingSend?.ok !== true
          ctx.state = '已停止'
          ctx.err = e.message
          addLogTrace(ctx, '流程', 'warning', e.message, {
            communicationEstablished,
            retryable: ctx.retryable,
          })
          log.finishDelivery(record, e, ctx)
          if (communicationEstablished) {
            data.status.setStatus('warn', '已建立沟通，招呼语未完成，可从记录中继续')
          } else {
            data.status.setStatus('wait', '已停止，可再次手动投递')
          }
          return 'stopped'
        }
        if (!(e instanceof AgentDeliveryError)) {
          const message = e instanceof Error ? e.message : errorHandle(e)
          // eslint-disable-next-line no-ex-assign
          e = new UnknownError(`预期外:${message}`, {
            cause: e instanceof Error ? e : undefined,
          })
        }
        const isGreetingAfterPublishFailure = e instanceof GreetError && ctx.publish?.ok === true
        const failureStage = inferFailureStage(ctx)
        setDeliveryStage(ctx, data, e.state === 'warning' ? '已过滤' : '投递失败', record)
        ctx.failureStage = failureStage
        ctx.failureReason = e.message ?? ''
        ctx.retryable = canRetryError(e, ctx)
        ctx.state = isGreetingAfterPublishFailure
          ? '招呼语失败'
          : e.state === 'warning'
            ? '过滤'
            : '失败'
        ctx.err = e.message ?? ''
        addLogTrace(ctx, e.state === 'warning' ? '筛选/跳过' : '失败', e.state, e.message ?? '')
        log.finishDelivery(record, e as logErr, ctx)
        logger.warn(
          isGreetingAfterPublishFailure
            ? '招呼语失败，继续投递'
            : e.state === 'warning'
              ? '投递过滤'
              : '投递失败',
          ctx,
        )

        if (e instanceof JobUnavailableError || e instanceof JobDataIncompleteError) {
          jobWasUnevaluable = true
          consecutiveUnevaluableJobs += 1
          if (consecutiveUnevaluableJobs >= unevaluableJobLimit) {
            // 停下来，但不对原因下结论。连续失败说明问题不在单个岗位上——投递池里的岗位是
            // 几分钟前刚抓的，连着三个恰好同时下线讲不通。至于是被限制、登录态失效还是
            // 别的，日志里现在带着真实报错，看了才知道。
            //
            // 不走风控退避那条路：那会扣当日额度、当天反复命中还会直接收工，代价不小，
            // 不该压在一个还没查清的原因上。先停下、把话说清楚，比自动决定重要。
            const msg = `连续 ${consecutiveUnevaluableJobs} 个岗位无法评估，已暂停：${e.message}`
            shouldCachePipeline = false
            shouldCountTotal = false
            data.status.setStatus('wait', '等待中')
            addLogTrace(ctx, '流程', 'danger', msg)
            AgentMessage.error('连续多个岗位无法评估，已暂停投递，请查看运行日志')
            common.deliverStop = true
            terminalError.value = msg
            return 'terminalError'
          }
          return 'failed'
        }

        if (e instanceof AIProviderError || e instanceof RetryablePipelineError) {
          shouldCachePipeline = false
          shouldCountTotal = false
          // AI 请求失败就是 AI 有问题，再拿后面的岗位去试结果一样，只会白白废掉它们。
          //
          // 岗位是否放回待处理，取决于沟通有没有已经建立：招呼语是在建立沟通之后生成的，
          // 此时把岗位放回待处理，点「继续」会让它从头再跑一遍，对同一个 boss 重复建立沟通、
          // 额度也重复计一次。这种情况保留终态，改从投递记录里重试招呼语。
          if (ctx.publish?.ok === true) {
            data.status.setStatus('warn', '已建立沟通，招呼语未完成，可从记录中继续')
          } else {
            data.status.setStatus('wait', '等待中')
          }
          addLogTrace(ctx, '流程', 'danger', `AI 请求失败：${e.message}`)
          AgentMessage.error('AI 请求失败')
          common.deliverStop = true
          terminalError.value = e.message
          return 'aiUnavailable'
        }

        if (isGreetingAfterPublishFailure) {
          const msg =
            'BOSS沟通已建立但招呼语未确认发送，已记录为招呼语失败，继续处理后续岗位，可从打招呼阶段重试'
          addLogTrace(ctx, '流程', 'warning', msg)
          log.touchDelivery(record, ctx)
          AgentMessage.info('招呼语发送未确认，已继续处理后续岗位')
          return 'failed'
        }

        if (e instanceof PublishError) {
          shouldCachePipeline = false
          shouldCountTotal = false
          const msg = `投递接口异常，已暂停投递，当前岗位可重试：${e.message}`
          addLogTrace(ctx, '流程', 'danger', msg)
          AgentMessage.error('投递接口异常，任务已暂停，可稍后重试当前岗位')
          common.deliverStop = true
          terminalError.value = e.message
          return 'terminalError'
        }

        if (e instanceof LimitError) {
          const msg = '已达到 BOSS 投递上限，任务已暂停'
          AgentMessage.error(msg)
          common.deliverStop = true
          return 'sourceLimit'
        } else if (e instanceof RateLimitError) {
          // 原来是「等 30 秒、单岗位加 3 秒、接着投下一个」。方向是错的：被限流说明当前这一段
          // 行为已经被判定成异常，30 秒后接着投等于拿后面的岗位去验证同一个判定。
          //
          // 这里只负责把岗位留在待处理并把信号交上去，退多久、要不要今天收工由上层决定——
          // 那需要跨运行的当日命中次数，不是单个岗位能知道的事。
          shouldCachePipeline = false
          shouldCountTotal = false
          data.status.setStatus('wait', '等待中')
          addLogTrace(ctx, '流程', 'warning', `触发频率限制：${e.message}`)
          common.deliverStop = true
          terminalError.value = e.message
          return 'rateLimited'
        }
        return 'failed'
      }
    } catch (e) {
      if (isProviderHeartbeatError(e)) throw e
      const failureStage = inferFailureStage(ctx)
      setDeliveryStage(ctx, data, '投递失败', record)
      ctx.failureStage = failureStage
      ctx.failureReason = e instanceof Error ? e.message : `${e}`
      ctx.retryable = true
      log.finishDelivery(record, new UnknownError(ctx.failureReason), ctx)
      logger.error('未知报错', e, data)
      AgentMessage.error('投递失败，请稍后重试')
      terminalError.value = ctx.failureReason
      common.deliverStop = true
      return 'terminalError'
    } finally {
      // 岗位只要评上了就把连续计数清零，不管评的结果是投递还是过滤。少了这一步，「连续」
      // 其实是「累计」：第 5 个失败一次、第 30 个失败一次、第 80 个再失败一次也会停，
      // 中间七十多个全成功也不算数。
      //
      // 不能按「详情取到了」来清：通勤查询失败这类问题发生在取详情之后，用 detailFetched
      // 清零会把刚加上的那一次立刻抹掉，连续计数永远攒不起来。
      if (!jobWasUnevaluable) consecutiveUnevaluableJobs = 0

      try {
        if (shouldCachePipeline) {
          await cachePipelineResult(
            data.encryptJobId,
            data.jobName || '',
            data.brandName || '',
            data.status.status,
            data.status.msg || '处理完成',
          )
        }
      } catch (cacheError) {
        logger.warn('缓存Pipeline结果失败', cacheError)
      }

      if (shouldCountTotal || (!isRetry && ctx.communicationCounted === true)) {
        statistics.todayData.total++
      }
      await flushJobRunState(ctx, record, delivered ? '岗位处理成功' : '岗位处理结束')
      if (shouldWaitForHumanLikePace) {
        await waitForHumanLikeJobPace(ctx, jobStartedAt, targetJobDuration, currentPaceMultiplier)
      } else if (ctx.detailAttempted === true) {
        // 节奏要按「向 BOSS 发过请求」算，不能按「投递成功」算，也不能按「请求成功」算。
        // 原来只有真的投出去才等，于是一页里被 AI 或岗位规则筛掉的岗位是零等待；
        // 后来改成按详情拿到手算，失败的详情请求仍然是零等待——而详情开始失败恰恰是
        // 最该慢下来的时候。真机上 6 个失败请求在 565 毫秒内打空了令牌桶。
        // 只看不投的岗位，人停留的时间本来也比投出去的短，所以按一个折扣比例来。
        await waitForHumanLikeJobPace(
          ctx,
          jobStartedAt,
          getBrowseOnlyDurationMs(targetJobDuration),
          currentPaceMultiplier,
        )
      }
      if (shouldWaitForBatchRest && hasDailyDeliveryRemaining(statistics.todayData)) {
        await waitForBatchRest(statistics.todayData.success)
      }
    }
  }

  async function ensureTodayStatistics() {
    const date = getCurDay()
    if (statistics.todayData.date === date) return
    await statistics.updateStatistics(createEmptyStatistics(date))
  }

  async function ensureTodayStatisticsSafely(ctx: logData, record: log) {
    try {
      await ensureTodayStatistics()
    } catch (error) {
      if (!isProviderHeartbeatError(error)) throw error
      const diagnostic = {
        ...getProviderHeartbeatDiagnostic(error),
        jobId: ctx.listData.encryptJobId,
        jobName: ctx.listData.jobName,
        reason: '读取今日统计',
        source: ctx.deliverySource ?? getDeliveryLimitSource(),
      }
      addLogTrace(
        ctx,
        '运行状态保存',
        'warning',
        `统计读取失败，已使用当前页面内存统计继续：${diagnostic.error}`,
        diagnostic,
      )
      log.touchDelivery(record, ctx)
      logger.warn('统计读取遇到Provider心跳异常，已降级继续', diagnostic)
    }
  }

  async function flushJobRunState(ctx: logData, record: log, reason: string) {
    await flushJobRunStatePart('统计保存', () => statistics.flush(), ctx, record, reason)
    await flushJobRunStatePart('日志保存', () => log.flush(), ctx, record, reason)
  }

  async function flushJobRunStatePart(
    label: string,
    flush: () => Promise<unknown>,
    ctx: logData,
    record: log,
    reason: string,
  ) {
    try {
      await flush()
    } catch (error) {
      const diagnostic = {
        ...getProviderHeartbeatDiagnostic(error),
        jobId: ctx.listData.encryptJobId,
        jobName: ctx.listData.jobName,
        reason,
        source: ctx.deliverySource ?? getDeliveryLimitSource(),
        target: label,
      }
      addLogTrace(
        ctx,
        '运行状态保存',
        'warning',
        `${label}失败，已保留当前页面内存状态并继续：${diagnostic.error}`,
        diagnostic,
      )
      log.touchDelivery(record, ctx)
      logger.warn('岗位运行状态保存失败，已降级继续', diagnostic)
      // 配额写满时这条降级日志本身也存不进去，必须直接告诉用户，
      // 否则数据会在刷新后静默消失而没有任何征兆。
      if (isStorageQuotaError(error) && shouldReportStorageQuota()) {
        AgentMessage.error(STORAGE_QUOTA_ERROR_MESSAGE)
      }
    }
  }

  async function jobListHandle(
    batchItems?: DeliveryBatchItem<MyJobListData>[],
    runtimeFormData?: FormData,
  ): Promise<JobListHandleResult> {
    const previousRuntimeFormData = activeRuntimeFormData
    activeRuntimeFormData = runtimeFormData ?? null
    try {
      terminalError.value = ''
      rateLimitBackoffSeconds = 0
      consecutiveUnevaluableJobs = 0
      try {
        await log.hydrate()
      } catch (error) {
        const diagnostic = getProviderHeartbeatDiagnostic(error)
        log.info('招呼语续发', `历史投递记录加载失败，已降级使用当前页面记录：${diagnostic.error}`)
        logger.warn('历史投递记录加载失败，招呼语续发降级使用当前页面记录', diagnostic)
      }
      const currentSource = getDeliveryLimitSource()
      const items =
        batchItems ??
        jobList._list.value.map((item) => ({
          item,
          source: currentSource,
        }))
      log.info('投递池', `本次从投递池取出 ${items.length} 个岗位`)
      total.value = items.length
      const chandle = await createHandle(activeRuntimeFormData ?? undefined)
      const greetingResumeResult = await resumePendingGreetingRecords(chandle)
      if (greetingResumeResult != null) return greetingResumeResult
      let skippedByStatus = 0
      let processed = 0
      let succeeded = 0
      let failed = 0
      const sourceSummary = summarizeBatchSources(items)
      log.info(
        '岗位处理',
        `开始处理投递池批次\n${JSON.stringify({
          listLength: items.length,
          source: batchItems == null ? currentSource : 'mixed',
          sources: sourceSummary,
          success: statistics.todayData.success,
          total: statistics.todayData.total,
        })}`,
      )
      items.forEach(({ item }) => {
        switch (item.status.status) {
          // 已有结论的状态一律保持。filtered 原本落在下面的 default 分支里被重置成 wait，
          // 等于把刚判掉的岗位重新放回队列，下一轮再判一次，如此空转。
          case 'success':
          case 'warn':
          case 'error':
          case 'filtered':
            break
          case 'running':
            item.status.setStatus('warn', '上次投递中断，结果不确定，需核对后再处理')
            break
          case 'pending':
          case 'wait':
            item.status.setStatus('wait', '等待中')
            break
          default:
            // 未知状态不猜它能不能投，交给下面的 `!== 'wait'` 跳过。
            break
        }
      })
      for (const [index, { item: data, source }] of items.entries()) {
        current.value = index
        if (common.deliverStop) {
          log.info(
            '暂停投递',
            `剩余 ${items.length - index} 个未处理\n${JSON.stringify({
              index,
              processed,
              succeeded,
              failed,
              skippedByStatus,
              source,
              sources: sourceSummary,
            })}`,
          )
          return 'stopped'
        }
        if (data.status.status !== 'wait') {
          skippedByStatus++
          continue
        }
        processed++
        const result = await processJob(data, chandle, {
          index,
          total: items.length,
          source,
        })
        if (result === 'success') succeeded++
        if (result === 'failed') failed++
        log.info(
          '岗位处理',
          `岗位处理进度\n${JSON.stringify({
            index,
            processed,
            result,
            succeeded,
            failed,
            skippedByStatus,
            listLength: items.length,
            source,
            sources: sourceSummary,
          })}`,
        )
        if (result === 'sourceLimit') {
          log.info(
            '岗位处理',
            `当前页处理触发每日额度上限\n${JSON.stringify({
              index,
              processed,
              succeeded,
              failed,
              skippedByStatus,
              source,
              sources: sourceSummary,
            })}`,
          )
          return 'sourceLimit'
        }
        if (result === 'stopped') {
          log.info(
            '岗位处理',
            `当前页处理被暂停\n${JSON.stringify({
              index,
              processed,
              succeeded,
              failed,
              skippedByStatus,
              source,
              sources: sourceSummary,
            })}`,
          )
          return 'stopped'
        }
        if (result === 'terminalError' || result === 'aiUnavailable' || result === 'rateLimited') {
          log.info(
            '岗位处理',
            `当前页处理因运行错误终止\n${JSON.stringify({
              index,
              processed,
              succeeded,
              failed,
              skippedByStatus,
              source,
              sources: sourceSummary,
            })}`,
          )
          return result
        }
      }
      const finalResult = common.deliverStop ? 'stopped' : 'completed'
      log.info(
        '岗位处理',
        `当前页岗位处理结束：${finalResult}\n${JSON.stringify({
          processed,
          succeeded,
          failed,
          skippedByStatus,
          listLength: items.length,
          source: batchItems == null ? currentSource : 'mixed',
          sources: sourceSummary,
        })}`,
      )
      return finalResult
    } finally {
      activeRuntimeFormData = previousRuntimeFormData
    }
  }

  function getPendingGreetingRetryRecords() {
    if (!isAiGreetingRuntimeEnabled()) return []
    const records = log.data.value
    const todayStartedAt = new Date()
    todayStartedAt.setHours(0, 0, 0, 0)
    const seenJobs = new Set<string>()
    return records
      .filter((record) => {
        const ctx = record.data
        const jobId = record.job?.encryptJobId ?? ctx?.listData?.encryptJobId
        const detail = ctx?.greetingSend?.detail
        const resultUnknown =
          typeof detail === 'object' &&
          detail != null &&
          (detail as Record<string, unknown>).resultUnknown === true
        if (
          !jobId ||
          seenJobs.has(jobId) ||
          record.createdAt < todayStartedAt.getTime() ||
          ctx?.retryable !== true ||
          ctx.publish?.ok !== true ||
          ctx.greetingSend?.ok === true ||
          resultUnknown ||
          (ctx.retryAttempts ?? 0) >= maxManualJobRetries
        ) {
          return false
        }
        seenJobs.add(jobId)
        return true
      })
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  async function resumePendingGreetingRecords(
    chandle: Awaited<ReturnType<typeof createHandle>>,
  ): Promise<JobListHandleResult | null> {
    const records = getPendingGreetingRetryRecords()
    if (records.length === 0) return null
    log.info('招呼语续发', `发现 ${records.length} 条已建立沟通但未完成的招呼语，开始自动续发`)

    for (const record of records) {
      if (common.deliverStop) return 'stopped'
      const persistedJob = record.job ?? record.data?.listData
      const data = persistedJob ? jobList.resolveRuntimeJob(persistedJob) : null
      const ctx = record.data
      if (!data || !ctx) {
        if (ctx) {
          ctx.retryable = false
          log.touchDelivery(record, ctx)
        }
        continue
      }

      const retryAttempts = Math.max(0, ctx.retryAttempts ?? 0) + 1
      ctx.retryAttempts = retryAttempts
      ctx.maxRetryAttempts = maxManualJobRetries
      data.retryAttempts = retryAttempts
      record.job = data
      ctx.listData = data
      addLogTrace(
        ctx,
        '招呼语续发',
        'info',
        `自动执行第 ${retryAttempts}/${maxManualJobRetries} 次招呼语续发，跳过建立沟通接口`,
      )
      const result = await processJob(data, chandle, {
        index: 0,
        total: records.length,
        record,
        mode: 'greetingOnly',
        source: ctx.deliverySource,
      })
      if (ctx.retryable && retryAttempts >= maxManualJobRetries) {
        ctx.retryable = false
        data.status.setStatus('error', `招呼语续发已达到 ${maxManualJobRetries} 次上限`)
        addLogTrace(
          ctx,
          '招呼语续发',
          'warning',
          `已达到 ${maxManualJobRetries} 次续发上限，后续不再自动重试`,
        )
        log.touchDelivery(record, ctx)
      }
      // 招呼语续发同样要在 AI 失败时停下，否则会带着一个已知失效的模型把剩下的记录跑完。
      if (
        result === 'terminalError' ||
        result === 'aiUnavailable' ||
        result === 'rateLimited' ||
        result === 'sourceLimit' ||
        result === 'stopped'
      ) {
        return result
      }
    }
    return null
  }

  function summarizeBatchSources(items: DeliveryBatchItem<MyJobListData>[]) {
    return items.reduce(
      (summary, item) => {
        summary[item.source] += 1
        return summary
      },
      { group: 0, search: 0 } as Record<DeliveryLimitSource, number>,
    )
  }

  async function deliverOne(
    data: MyJobListData,
    source?: ReturnType<typeof getDeliveryLimitSource>,
  ) {
    if (common.deliverLock) {
      AgentMessage.info('当前已有投递任务在执行')
      return
    }
    common.deliverLock = true
    common.deliverStop = false
    try {
      const chandle = await createHandle()
      await processJob(data, chandle, { index: 0, total: 1, source })
    } finally {
      common.deliverLock = false
    }
  }

  async function retryRecord(record: log) {
    const persistedJob = record.job ?? record.data?.listData
    const data = persistedJob ? jobList.resolveRuntimeJob(persistedJob) : null
    if (!data) {
      AgentMessage.error('没有找到可重试的岗位数据')
      return
    }
    if (!record.data?.retryable) {
      AgentMessage.info('这条记录不适合重试，请查看失败原因')
      return
    }
    const retryAttempts = Math.max(0, record.data.retryAttempts ?? 0)
    if (retryAttempts >= maxManualJobRetries) {
      record.data.retryable = false
      data.retryAttempts = retryAttempts
      data.status.setStatus('error', `已达到 ${maxManualJobRetries} 次重试上限`)
      log.touchDelivery(record, record.data)
      AgentMessage.info(`该岗位已达到 ${maxManualJobRetries} 次重试上限，已跳过`)
      return
    }
    if (common.deliverLock) {
      AgentMessage.info('当前已有投递任务在执行')
      return
    }
    common.deliverLock = true
    common.deliverStop = false
    try {
      record.data.retryAttempts = retryAttempts + 1
      record.data.maxRetryAttempts = maxManualJobRetries
      data.retryAttempts = retryAttempts + 1
      addLogTrace(
        record.data,
        '岗位重试',
        'info',
        `开始第 ${retryAttempts + 1}/${maxManualJobRetries} 次手动重试`,
      )
      record.job = data
      record.data.listData = data
      const chandle = await createHandle()
      await processJob(data, chandle, {
        index: 0,
        total: 1,
        record,
        mode: getRetryMode(record),
        source: record.data?.deliverySource,
      })
      if (record.data.retryable && record.data.retryAttempts >= maxManualJobRetries) {
        record.data.retryable = false
        data.status.setStatus('error', `已达到 ${maxManualJobRetries} 次重试上限`)
        addLogTrace(
          record.data,
          '岗位重试',
          'warning',
          `已达到 ${maxManualJobRetries} 次重试上限，后续将跳过该岗位`,
        )
        log.touchDelivery(record, record.data)
      }
    } finally {
      common.deliverLock = false
    }
  }

  /**
   * 只看详情、没投出去的岗位该占多长时间。
   *
   * 从用户配置的单岗位耗时里按比例取，而不是另设一套常量：用户调慢整体节奏时，
   * 浏览节奏必须跟着一起慢，否则调了半天最密集的那类请求还是老样子。
   */
  function getBrowseOnlyDurationMs(targetJobDurationMs: number) {
    const ratio = browseOnlyMinRatio + Math.random() * (browseOnlyMaxRatio - browseOnlyMinRatio)
    return Math.round(targetJobDurationMs * ratio)
  }

  /**
   * 单个岗位的目标耗时。
   *
   * 用户配的两个数按「典型值」和「十次里九次不超过」理解，不是「最短」和「最长」。
   * 按区间均匀取值会把均值抬到区间中点，那是均匀抖动最亏效率的地方；重尾分布的
   * 大多数样本落在典型值附近甚至更快，只有少数落到长尾上——真人也是这个形状。
   */
  function getRandomJobDurationMs(paceMultiplier = 1) {
    const typicalSeconds =
      Math.max(0, conf.formData.delay.deliveryInterval) + rateLimitBackoffSeconds
    const p90Seconds = Math.max(
      typicalSeconds,
      conf.formData.delay.deliveryIntervalMax + rateLimitBackoffSeconds,
    )
    // 倍率越高节奏越快，所以是除不是乘：用户配的值代表「常规档」，曲线在它上下浮动。
    const pace = Math.max(0.1, paceMultiplier)
    return sampleHumanDelayMs((typicalSeconds * 1000) / pace, {
      p90Ms: (p90Seconds * 1000) / pace,
      minMs: 4000,
      maxMs: (p90Seconds * 4000) / pace,
    })
  }

  async function waitForHumanLikeJobPace(
    ctx: logData,
    startedAt: number,
    targetDurationMs: number,
    paceMultiplier = 1,
  ) {
    const remainingMs = targetDurationMs - (Date.now() - startedAt)
    if (remainingMs <= 0) return
    const waitSeconds = Math.ceil(remainingMs / 1000)
    const targetSeconds = Math.ceil(targetDurationMs / 1000)
    const msg = `投递节奏等待 ${waitSeconds} 秒后继续下一个岗位`
    log.info(
      '投递节奏',
      `${msg}\n${JSON.stringify({
        jobName: ctx.listData.jobName,
        jobId: ctx.listData.encryptJobId,
        source: ctx.deliverySource ?? getDeliveryLimitSource(),
        waitSeconds,
        targetSeconds,
        // 没有档位就没法判断曲线该不该调：同一个「目标 22 秒」可能来自 1.8 档，
        // 也可能来自用户把配置调小了，两者要采取的动作完全相反。
        paceMultiplier,
      })}`,
    )
    logger.info(`${msg}，目标单JD耗时 ${targetSeconds} 秒`)
    await delayWithStop(remainingMs)
  }

  async function waitForBatchRest(successCount: number) {
    const batchSize = Math.max(0, conf.formData.delay.batchSize)
    const restMinutes = Math.max(0, conf.formData.delay.batchRestMinutes)
    if (batchSize === 0 || restMinutes === 0 || successCount % batchSize !== 0) return

    const restSeconds = restMinutes * 60
    const msg = `已投递/打招呼 ${successCount} 个，进入批量休息 ${restMinutes} 分钟，休息结束后会自动继续`
    log.info('批量休息', msg)
    AgentMessage.info(msg)
    await delayWithStop(restSeconds * 1000)
    if (common.deliverStop) {
      log.info('批量休息', `批量休息被停止打断，当前成功 ${successCount} 个`)
      return
    }
    log.info('批量休息', `批量休息结束，继续投递，当前成功 ${successCount} 个`)
  }

  async function delayWithStop(ms: number) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (common.deliverStop) return
      await delay(Math.min(5, Math.max(0, (deadline - Date.now()) / 1000)))
    }
  }
  return {
    createHandle,
    deliverOne,
    jobListHandle,
    retryRecord,
    resetBatchPace,
    terminalError,
    total,
    current,
    currentData,
  }
})
