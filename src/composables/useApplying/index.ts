import { useCommon } from '@/composables/useCommon'
import { PipelineCacheManager } from '@/composables/usePipelineCache'
import type { JobStatus } from '@/stores/jobs'
import { addLogTrace } from '@/stores/log'
import { useUser } from '@/stores/user'
import {
  DeliveryStoppedError,
  JobDetailAccessError,
  JobDataIncompleteError,
  JobUnavailableError,
  PageSessionUnavailableError,
  RetryablePipelineError,
} from '@/types/deliverError'
import type { FormData } from '@/types/formData'
import type { PipelineCacheItem, ProcessorType } from '@/types/pipelineCache'
import { acquireBossAction } from '@/utils/actionGateStore'

import { handles } from './handles'
import type { Handler, Pipeline, Step } from './type'
import { errorHandle } from './utils'

export * from './utils'

// 全局缓存管理器实例
let cacheManager: PipelineCacheManager | null = null

function getPipelineCacheScope(): string | null {
  const user = useUser()
  const uid = user.getUserId()
  if (uid == null) return null
  // Only successful/non-retryable results are persisted. Configuration changes must not make an
  // already contacted job deliverable again; account identity is the only required boundary.
  return `uid:${String(uid)}`
}

function compilePipeline(
  pipeline: Pipeline,
  isNested = false,
): {
  before: Handler[]
  after: Handler[]
  afterPublish: Handler[]
} {
  const result: {
    before: Handler[]
    after: Handler[]
    afterPublish: Handler[]
  } = {
    before: [],
    after: [],
    afterPublish: [],
  }
  let guard: Step | undefined
  if (isNested) {
    const first = pipeline.shift()
    if (Array.isArray(first)) {
      throw new TypeError('PipelineGroup 第一项不能是数组')
    }
    guard = first
  }
  for (const h of pipeline) {
    if (h == null) {
      continue
    }
    if (Array.isArray(h)) {
      const { before, after, afterPublish } = compilePipeline(h, true)
      result.before.push(...before)
      result.after.push(...after)
      result.afterPublish.push(...afterPublish)
    } else if (typeof h === 'function') {
      result.before.push(h)
    } else {
      h.fn && result.before.push(h.fn)
      h.after && result.after.push(h.after)
      h.afterPublish && result.afterPublish.push(h.afterPublish)
    }
  }
  if (guard) {
    if (typeof guard === 'function') {
      result.before.length > 0 && result.before.unshift(guard)
    } else {
      result.before.length > 0 && guard.fn && result.before.unshift(guard.fn)
      result.after.length > 0 && guard.after && result.after.unshift(guard.after)
      result.afterPublish.length > 0 &&
        guard.afterPublish &&
        result.afterPublish.unshift(guard.afterPublish)
    }
  }
  return result
}

/**
 * 列表页凭据（securityId / lid）何时应先刷新。
 *
 * 30 分钟只触发列表刷新，不判岗位失效。这样既遵守现行产品契约，也避免拿已放置较久的
 * securityId/lid 直接撞详情接口；刷新后岗位仍按原 FIFO 顺序处理。
 */
const JOB_CREDENTIAL_REFRESH_AGE_MINUTES = 30

export async function createHandle(runtimeFormData?: FormData): Promise<{
  before: Handler[]
  after: Handler[]
  afterPublish: Handler[]
  retryGreeting: Handler
}> {
  const h = handles(runtimeFormData)
  const pipeline: Pipeline = [
    h.communicated(), // 已沟通过滤
    h.SameCompanyFilter(), // 相同公司过滤
    h.SameHrFilter(), // 相同hr过滤
    h.goldHunterFilter(), // 列表中的猎头标记过滤
    h.companySizeRange(), // 公司规模过滤
    [
      // Card卡片信息获取
      async (args, ctx) => {
        const fetchedAt = Number(args.data.fetchedAt) || Date.now()
        const ageMinutesAt = (at: number) => Math.max(0, (at - fetchedAt) / 60_000)
        try {
          const assertCredentialsFreshEnough = (alwaysLog = false) => {
            const ageMinutes = ageMinutesAt(Date.now())
            const refreshRequired = ageMinutes >= JOB_CREDENTIAL_REFRESH_AGE_MINUTES
            if (alwaysLog || refreshRequired) {
              addLogTrace(ctx, '岗位时效', 'info', '投递前重新校验岗位详情与投递凭据', {
                ageMinutes: Math.round(ageMinutes),
                refreshRequired,
              })
            }
            if (refreshRequired) {
              throw new JobDetailAccessError(
                `岗位列表凭据已放置 ${Math.round(ageMinutes)} 分钟，需要刷新列表凭据后继续`,
                { kind: 'credentials-stale' },
              )
            }
          }
          assertCredentialsFreshEnough(false)
          // 详情请求要过闸门。这是整条链路上最密集的一类请求：粗筛放行的每个岗位都会打一次，
          // 而其中大部分随后就被过滤掉了，用户看不到任何投递，BOSS 那边却看到一串请求。
          const acquired = await acquireBossAction('detail', {
            shouldAbort: () => useCommon().deliverStop,
            onWait: (waitMs) =>
              addLogTrace(
                ctx,
                '动作闸门',
                'info',
                `详情请求限速，等待 ${Math.round(waitMs / 1000)} 秒`,
              ),
          })
          if (!acquired) {
            throw new DeliveryStoppedError('用户已停止投递，未继续请求岗位详情')
          }
          // 时效必须在闸门之后算。原来是在前面算完就记进日志，然后这里一等就是几分钟——
          // 真机上那次等了 222 秒，凭据从 24.3 分钟被推到 28.1 分钟，然后被 BOSS 拒掉。
          // 也就是说限速本身把凭据等过了期：为了「慢一点更安全」付的钱，买来的是失败。
          assertCredentialsFreshEnough(true)
          // 年龄只用于诊断和触发上层刷新，不能直接判岗位失效。现行产品契约明确要求池中
          // 岗位超过 30 分钟仍应刷新详情与有效凭据后继续处理。
          // 请求发出去就要记账，不管拿没拿到结果。节奏是按「BOSS 那边看到了什么」算的，
          // 失败的详情请求在 BOSS 那边和成功的一样是一次请求——真机上就是这样：详情开始
          // 连续失败之后，每个岗位都零等待往下走，半秒钟打空了整个令牌桶。
          ctx.detailAttempted = true
          if ((await args.data.getCard()) == null) {
            throw new JobDataIncompleteError('职位详情获取为空，无法继续判断')
          }
          ctx.detailFetched = true
        } catch (e) {
          addLogTrace(
            ctx,
            '职位详情',
            e instanceof JobUnavailableError ? 'warning' : 'danger',
            `职位详情获取失败：${errorHandle(e)}`,
          )
          if (e instanceof JobUnavailableError) {
            throw e
          }
          if (e instanceof JobDetailAccessError) {
            throw e
          }
          if (e instanceof PageSessionUnavailableError) {
            throw e
          }
          if (e instanceof DeliveryStoppedError) {
            throw e
          }
          if (e instanceof RetryablePipelineError) {
            throw e
          }
          throw new JobDataIncompleteError(`职位详情获取失败：${errorHandle(e)}`, {
            cause: e instanceof Error ? e : undefined,
          })
        }
      },
      h.jobContent(), // 完整 JD 工作内容排除
      h.jobFriendStatus(), // 好友状态过滤
      h.activityFilter(), // 招聘者活跃度过滤
      h.amap(), // 岗位地址与通勤过滤
      h.aiFiltering(), // AI匹配度：唯一岗位适配过滤标准
      h.greeting(), // 招呼语
    ],
  ]
  return {
    ...compilePipeline(pipeline),
    retryGreeting: h.retryGreeting,
  }
}

/**
 * 创建缓存实例
 */
export function getCacheManager(): PipelineCacheManager {
  if (!cacheManager) {
    cacheManager = new PipelineCacheManager()
  }
  return cacheManager
}

/**
 * 缓存Pipeline处理结果
 */
export async function cachePipelineResult(
  encryptJobId: string,
  jobName: string,
  brandName: string,
  status: JobStatus,
  message: string,
  processorType?: ProcessorType,
): Promise<void> {
  const scope = getPipelineCacheScope()
  if (scope == null) return
  const cacheManager = getCacheManager()
  await cacheManager.setCacheResult(
    encryptJobId,
    jobName,
    brandName,
    status,
    message,
    scope,
    processorType,
  )
}

/**
 * 检查职位是否有有效缓存
 */
export function checkJobCache(encryptJobId: string): PipelineCacheItem | null {
  const scope = getPipelineCacheScope()
  if (scope == null) return null
  const cacheManager = getCacheManager()

  if (cacheManager.isValidCache(encryptJobId, scope)) {
    const cached = cacheManager.getCachedResult(encryptJobId, scope)
    return cached
  }
  return null
}
