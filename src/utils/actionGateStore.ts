import { counter } from '@/message'

import {
  type ActionEvent,
  ActionGateTimeoutError,
  type BossActionKind,
  defaultGateRules,
  getSessionElapsedMs,
  paceMultiplier,
  pruneEvents,
  waitMsFor,
} from './actionGate'
import { logger } from './logger'

/**
 * 闸门的持久化与跨标签页互斥。
 *
 * 计数必须跨页面存活：投递过程中会翻页、会跳聊天页、刷新后还会重入，只要窗口存在内存里，
 * 每一次页面切换都等于把限额清零，而那正是最需要它生效的时刻。
 *
 * 互斥同样必要：两个标签页各自以为自己在限额内，合起来就是两倍速率。这里用的锁和
 * 招呼语队列是同一套（navigator.locks + 一条本地串行链），行为已经在真机上跑过。
 */

export const actionGateKey = 'local:boss-action-gate'
const actionGateLockName = `${actionGateKey}:queue`
let localTail = Promise.resolve()

/** 等待时的轮询步长。锁不能在等待期间一直握着，否则别的标签页会被饿死。 */
const pollStepMs = 1500

/** 单次申请的等待上限。超过这个时间说明限额配置有问题或来错了地方，交给上层处理。 */
export const maxGateWaitMs = 15 * 60_000

function withGateLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = localTail.then(async () => {
    if (navigator.locks != null) {
      return navigator.locks.request(actionGateLockName, operation)
    }
    return operation()
  })
  localTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function isActionEvent(value: unknown): value is ActionEvent {
  if (value == null || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return typeof event.kind === 'string' && Number.isFinite(event.at)
}

/**
 * 存储不可达时的兜底账本。
 *
 * 闸门本身绝不能把投递卡死：后台休眠、消息通道断开时 storage 调用可能一直不返回，
 * 而闸门在每个动作前都要过一次。所以读写都带超时，超时就退回内存账本——限额仍然生效，
 * 只是丢掉跨标签页和跨刷新的那部分。失效方向必须是「少记一些」而不是「不再限速」。
 */
let memoryEvents: ActionEvent[] = []
let storageDegraded = false

const storageTimeoutMs = 2000

async function withTimeout<T>(operation: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), storageTimeoutMs)
      }),
    ])
  } catch {
    return fallback
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

function markDegraded(reason: string) {
  if (storageDegraded) return
  storageDegraded = true
  logger.warn('动作闸门无法读写本地存储，已退回内存计数', { reason })
}

async function readEvents() {
  const sentinel: unknown = Symbol('gate-storage-timeout')
  const stored = await withTimeout<unknown>(
    (async () => await counter.storageGet<unknown>(actionGateKey, []))(),
    sentinel,
  )
  if (stored === sentinel) {
    markDegraded('读取超时')
    return memoryEvents
  }
  if (!Array.isArray(stored)) return memoryEvents
  const parsed = stored.filter(isActionEvent)
  // 内存账本可能比存储新（上一次写入超时了），两边取并集才不会漏记。
  const seen = new Set(parsed.map((event) => `${event.kind}:${event.at}`))
  return [...parsed, ...memoryEvents.filter((event) => !seen.has(`${event.kind}:${event.at}`))]
}

/**
 * 试一次：能发就把这次动作记上并返回 0，不能发就返回还要等多久。
 *
 * 记账和判定必须在同一把锁里，否则两个标签页会同时判定「可以发」。
 */
async function tryClaim(kind: BossActionKind, now: number) {
  return withGateLock(async () => {
    const events = pruneEvents(await readEvents(), now)
    const waitMs = waitMsFor(events, kind, now, defaultGateRules)
    if (waitMs > 0) return waitMs
    const next = [...events, { kind, at: now }]
    memoryEvents = next
    const written = await withTimeout(
      (async () => {
        await counter.storageSet(actionGateKey, next)
        return true
      })(),
      false,
    )
    if (!written) markDegraded('写入超时')
    return 0
  })
}

export interface AcquireActionOptions {
  /** 用户点了停止就别再等下去了。 */
  shouldAbort?: () => boolean
  /** 每次实际等待时回调，用于把等待写进日志。 */
  onWait?: (waitMs: number) => void
}

/**
 * 申请发出一个动作，拿不到就等。
 *
 * 阻塞而不是抛错，是因为调用点想要的是「慢下来」而不是「这一个不做了」——限额到了就
 * 排队，投递照常往下走，只是变慢。真正异常的情况（等太久）才抛。
 */
export async function acquireBossAction(kind: BossActionKind, options: AcquireActionOptions = {}) {
  const startedAt = Date.now()
  let notified = false
  for (;;) {
    if (options.shouldAbort?.() === true) return false
    const waitMs = await tryClaim(kind, Date.now())
    if (waitMs === 0) return true
    const waited = Date.now() - startedAt
    if (waited >= maxGateWaitMs) throw new ActionGateTimeoutError(kind, waited)
    if (!notified) {
      notified = true
      options.onWait?.(waitMs)
      logger.info('动作闸门限速', { kind, waitMs })
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollStepMs, waitMs)))
  }
}

/**
 * 当前会话处在曲线的哪一档。
 *
 * 闸门只管「不许超过」，真正决定吞吐的是单个岗位的目标耗时——不把同一条曲线接到那里，
 * 调闸门是白调的。所以这个倍率要暴露出去，让投递节奏和闸门用同一个会话、同一条曲线。
 */
export async function getCurrentPaceMultiplier() {
  const now = Date.now()
  const events = pruneEvents(await withGateLock(async () => await readEvents()), now)
  return paceMultiplier(getSessionElapsedMs(events, now))
}

/** 测试与「清空数据」用。 */
export async function resetActionGate() {
  await withGateLock(async () => {
    memoryEvents = []
    storageDegraded = false
    await withTimeout(
      (async () => {
        await counter.storageSet(actionGateKey, [])
        return true
      })(),
      false,
    )
  })
}
