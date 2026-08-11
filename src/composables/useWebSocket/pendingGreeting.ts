import { counter } from '@/message'
import { useUser } from '@/stores/user'
import { isPlainObject } from '@/utils/deepmerge'
import { logger } from '@/utils/logger'
import { isGeekChatUrl } from '@/utils/zhipinRoute'

import { Message } from './protobuf'

export const pendingGreetingKey = 'local:pending-greetings'
const pendingGreetingLockName = `${pendingGreetingKey}:queue`
let pendingGreetingQueueTail = Promise.resolve()

function withPendingGreetingQueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = pendingGreetingQueueTail.then(async () => {
    if (navigator.locks != null) {
      return navigator.locks.request(pendingGreetingLockName, operation)
    }
    return operation()
  })
  pendingGreetingQueueTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export interface PendingGreeting {
  id: string
  createdAt: number
  type: 'ai' | 'custom'
  fromUid: string
  toUid: string
  toName: string
  content: string
  jobName?: string
  brandName?: string
  status?: PendingGreetingStatus
}

export interface PendingGreetingSendResult {
  id: string
  ok: boolean
  channel?: 'GeekChatCore' | 'ChatWebsocket'
  error?: string
}

export interface PendingGreetingStatus {
  stage: 'queued' | 'waiting' | 'sending' | 'sent' | 'failed' | 'cancelled'
  reason?: string
  pageUrl?: string
  channel?: 'GeekChatCore' | 'ChatWebsocket'
  observedAt: number
}

const maxQueueLength = 50
export const PENDING_GREETING_MAX_AGE_MS = 5 * 60 * 1000
const chatReadyDelayMs = 6000
const minSendIntervalMs = 3000
const maxSendIntervalMs = 5000
let consuming = false
let consumeTimer: number | undefined
let lastChatUrl = ''
let chatReadyAt = 0
let nextSendAt = 0

function isCurrentUid(expectedUid: string) {
  const currentUid = useUser().getUserId()
  return currentUid != null && String(currentUid) === expectedUid
}

function isPendingGreeting(value: unknown): value is PendingGreeting {
  if (!isPlainObject(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    (value.type === 'ai' || value.type === 'custom') &&
    typeof value.fromUid === 'string' &&
    typeof value.toUid === 'string' &&
    typeof value.toName === 'string' &&
    typeof value.content === 'string'
  )
}

export async function enqueuePendingGreeting(
  greeting: Omit<PendingGreeting, 'id' | 'createdAt'>,
): Promise<PendingGreeting> {
  return withPendingGreetingQueue(async () => {
    const item: PendingGreeting = {
      ...greeting,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: Date.now(),
      status: {
        stage: 'queued',
        reason: '已进入待发送队列',
        pageUrl: location.href,
        observedAt: Date.now(),
      },
    }
    const queue = await getPendingGreetings()
    const otherAccounts = queue.filter((entry) => entry.fromUid !== item.fromUid)
    const currentAccount = queue.filter((entry) => entry.fromUid === item.fromUid)
    currentAccount.push(item)
    await savePendingGreetings([...otherAccounts, ...currentAccount.slice(-maxQueueLength)])
    return item
  })
}

export async function consumePendingGreetings(
  currentUid: string | number | null = useUser().getUserId(),
): Promise<PendingGreetingSendResult[]> {
  if (consuming) return []
  consuming = true
  try {
    return await withPendingGreetingQueue(async () => {
      const queue = await getPendingGreetings()
      if (queue.length === 0) return []
      if (currentUid == null) {
        logger.warn('当前账号 UID 不可用，保留待发送招呼语队列')
        return []
      }
      const normalizedCurrentUid = String(currentUid)
      if (!isCurrentUid(normalizedCurrentUid)) {
        logger.warn('账号已切换，保留原账号待发送招呼语队列')
        return []
      }

      const remaining: PendingGreeting[] = []
      const results: PendingGreetingSendResult[] = []
      const now = Date.now()
      let changed = false
      for (const [index, item] of queue.entries()) {
        if (item.fromUid !== normalizedCurrentUid) {
          remaining.push(item)
          continue
        }
        if (now - item.createdAt > PENDING_GREETING_MAX_AGE_MS) {
          logger.warn('待发送招呼语已过期，跳过发送', {
            jobName: item.jobName,
            brandName: item.brandName,
            ageMs: now - item.createdAt,
          })
          results.push({ id: item.id, ok: false, error: '待发送招呼语已过期' })
          changed = true
          continue
        }
        if (item.status?.stage === 'sending' || item.status?.stage === 'sent') {
          remaining.push(item, ...queue.slice(index + 1))
          results.push({ id: item.id, ok: false, error: '招呼语发送结果不确定，已停止自动重试' })
          break
        }
        if (item.status?.stage === 'cancelled') {
          results.push({ id: item.id, ok: false, error: item.status.reason ?? '待发送文本已取消' })
          changed = true
          continue
        }
        const readiness = getChatReadiness()
        if (!readiness.ready) {
          remaining.push(withStatus(item, 'waiting', readiness.reason), ...queue.slice(index + 1))
          results.push({ id: item.id, ok: false, error: readiness.reason })
          changed = true
          break
        }
        const sendTiming = getSendTimingReadiness()
        if (!sendTiming.ready) {
          remaining.push(withStatus(item, 'waiting', sendTiming.reason), ...queue.slice(index + 1))
          results.push({ id: item.id, ok: false, error: sendTiming.reason })
          changed = true
          break
        }
        if (!isCurrentUid(normalizedCurrentUid)) {
          remaining.push(item, ...queue.slice(index + 1))
          break
        }
        const runtime = await counter.configRuntime(normalizedCurrentUid)
        if (!isCurrentUid(normalizedCurrentUid)) {
          remaining.push(item, ...queue.slice(index + 1))
          break
        }
        if (!runtime.accountInitialized || runtime.formData.aiGreeting.enable !== true) {
          const pendingItems = queue.slice(index)
          const cancelledItems = pendingItems.map((entry) =>
            entry.fromUid === normalizedCurrentUid
              ? withStatus(entry, 'cancelled', 'AI招呼语已关闭，已取消待发送文本')
              : entry,
          )
          remaining.push(...cancelledItems)
          for (const entry of pendingItems) {
            if (entry.fromUid !== normalizedCurrentUid) continue
            results.push({
              id: entry.id,
              ok: false,
              error: 'AI招呼语已关闭，已取消待发送文本',
            })
          }
          logger.info('AI招呼语已关闭，已取消当前账号待发送文本', {
            cancelledCount: pendingItems.filter((entry) => entry.fromUid === normalizedCurrentUid)
              .length,
          })
          changed = true
          break
        }
        const sendingItem = withStatus(item, 'sending', '发送通道已接管消息，等待本地队列确认')
        await savePendingGreetings([...remaining, sendingItem, ...queue.slice(index + 1)])
        try {
          const channel = new Message({
            form_uid: item.fromUid,
            to_uid: item.toUid,
            to_name: item.toName,
            content: item.content,
          }).send()
          logger.info('待发送招呼语已通过聊天页 WebSocket 发送', {
            channel,
            jobName: item.jobName,
            brandName: item.brandName,
            contentLength: item.content.length,
          })
          scheduleNextSend()
          results.push({ id: item.id, ok: true, channel })
          changed = true
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e)
          remaining.push(withStatus(item, 'failed', error), ...queue.slice(index + 1))
          results.push({
            id: item.id,
            ok: false,
            error,
          })
          changed = true
          break
        }
      }

      if (changed || remaining.length !== queue.length) {
        if (!isCurrentUid(normalizedCurrentUid)) return results
        await savePendingGreetings(remaining)
      }
      return results
    })
  } finally {
    consuming = false
  }
}

function getSendTimingReadiness() {
  const now = Date.now()
  if (nextSendAt === 0) {
    nextSendAt = now + getRandomSendIntervalMs()
    return {
      ready: false,
      reason: `招呼语发送前等待 ${nextSendAt - now}ms`,
    }
  }

  if (now < nextSendAt) {
    return {
      ready: false,
      reason: `招呼语发送间隔中，剩余 ${nextSendAt - now}ms`,
    }
  }

  return { ready: true }
}

function scheduleNextSend() {
  nextSendAt = Date.now() + getRandomSendIntervalMs()
}

function getRandomSendIntervalMs() {
  return minSendIntervalMs + Math.floor(Math.random() * (maxSendIntervalMs - minSendIntervalMs + 1))
}

function withStatus(
  item: PendingGreeting,
  stage: PendingGreetingStatus['stage'],
  reason?: string,
  channel?: PendingGreetingStatus['channel'],
): PendingGreeting {
  return {
    ...item,
    status: {
      stage,
      reason,
      channel,
      pageUrl: location.href,
      observedAt: Date.now(),
    },
  }
}

function getChatReadiness() {
  if (!isGeekChatUrl(location.href)) {
    return {
      ready: false,
      reason: '当前页面不是聊天页，等待打开聊天页',
    }
  }

  const now = Date.now()
  if (lastChatUrl !== location.href) {
    lastChatUrl = location.href
    chatReadyAt = now + chatReadyDelayMs
    return {
      ready: false,
      reason: `目标聊天页刚打开，等待 ${chatReadyDelayMs}ms 后发送`,
    }
  }

  if (now < chatReadyAt) {
    return {
      ready: false,
      reason: `目标聊天页初始化中，剩余 ${chatReadyAt - now}ms`,
    }
  }

  const channel = getSendChannelReadiness()
  if (!channel.ready) {
    return channel
  }

  return { ready: true }
}

function getSendChannelReadiness() {
  const geekClient = window.GeekChatCore?.getInstance?.()?.getClient?.()?.client
  if (geekClient?.send != null) {
    return { ready: true }
  }

  if (window.ChatWebsocket?.send != null) {
    const client = window.ChatWebsocket.client
    if (client?.isConnected != null) {
      try {
        if (!client.isConnected()) {
          return { ready: false, reason: 'ChatWebsocket 尚未连接' }
        }
      } catch (e) {
        return {
          ready: false,
          reason:
            e instanceof Error
              ? `ChatWebsocket 连接状态异常：${e.message}`
              : 'ChatWebsocket 连接状态异常',
        }
      }
    }
    return { ready: true }
  }

  return { ready: false, reason: '聊天页暂无可用发送通道' }
}

export async function hasPendingGreeting(id: string): Promise<boolean> {
  return withPendingGreetingQueue(async () => {
    const queue = await getPendingGreetings()
    return queue.some((item) => item.id === id)
  })
}

export async function getPendingGreeting(
  id: string,
  expectedUid: string | number,
): Promise<PendingGreeting | undefined> {
  const normalizedExpectedUid = String(expectedUid)
  return withPendingGreetingQueue(async () => {
    const queue = await getPendingGreetings()
    if (!isCurrentUid(normalizedExpectedUid)) return undefined
    return queue.find((item) => item.id === id && item.fromUid === normalizedExpectedUid)
  })
}

export async function claimPendingGreetingForFallback(
  id: string,
  expectedUid: string | number,
): Promise<PendingGreeting | undefined> {
  const normalizedExpectedUid = String(expectedUid)
  return withPendingGreetingQueue(async () => {
    const queue = await getPendingGreetings()
    if (!isCurrentUid(normalizedExpectedUid)) return undefined
    const index = queue.findIndex(
      (item) => item.id === id && item.fromUid === normalizedExpectedUid,
    )
    if (index < 0) return undefined
    if (
      queue[index].status?.stage === 'sending' ||
      queue[index].status?.stage === 'sent' ||
      queue[index].status?.stage === 'cancelled'
    ) {
      return undefined
    }

    const [claimed] = queue.splice(index, 1)
    if (!isCurrentUid(normalizedExpectedUid)) return undefined
    await savePendingGreetings(queue)
    return claimed
  })
}

export async function removePendingGreeting(
  id: string,
  expectedUid: string | number,
): Promise<boolean> {
  const normalizedExpectedUid = String(expectedUid)
  return withPendingGreetingQueue(async () => {
    const queue = await getPendingGreetings()
    if (!isCurrentUid(normalizedExpectedUid)) return false
    const nextQueue = queue.filter(
      (item) => item.id !== id || item.fromUid !== normalizedExpectedUid,
    )
    if (nextQueue.length === queue.length) return false
    if (!isCurrentUid(normalizedExpectedUid)) return false
    await savePendingGreetings(nextQueue)
    return true
  })
}

export function startPendingGreetingConsumer(intervalMs = 800) {
  if (consumeTimer != null) return
  void consumePendingGreetings().catch(handlePendingGreetingConsumerError)
  consumeTimer = window.setInterval(() => {
    void consumePendingGreetings().catch(handlePendingGreetingConsumerError)
  }, intervalMs)
}

export function stopPendingGreetingConsumer() {
  if (consumeTimer == null) return
  window.clearInterval(consumeTimer)
  consumeTimer = undefined
}

function handlePendingGreetingConsumerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Extension context invalidated/i.test(message)) {
    stopPendingGreetingConsumer()
    logger.error('插件已更新，当前聊天页需刷新后才能继续发送招呼语', {
      code: 'EXTENSION_CONTEXT_INVALIDATED',
    })
    return
  }
  logger.error('待发送招呼语消费失败', error)
}

async function getPendingGreetings(): Promise<PendingGreeting[]> {
  const stored = await counter.storageGet<unknown>(pendingGreetingKey, [])
  if (!Array.isArray(stored)) {
    logger.warn('待发送招呼语队列格式损坏，已清理')
    await counter.storageRm(pendingGreetingKey)
    return []
  }

  const queue = stored.filter(isPendingGreeting)
  if (queue.length !== stored.length) {
    logger.warn('待发送招呼语队列包含损坏条目，已清理')
    await savePendingGreetings(queue)
  }
  return queue
}

async function savePendingGreetings(queue: PendingGreeting[]) {
  if (queue.length === 0) {
    await counter.storageRm(pendingGreetingKey)
    return
  }
  await counter.storageSet(pendingGreetingKey, queue)
}
