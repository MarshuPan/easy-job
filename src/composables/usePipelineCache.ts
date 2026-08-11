import { ref } from 'vue'

import { counter } from '@/message'
import type { JobStatus } from '@/stores/jobs'
import type {
  PipelineCache,
  PipelineCacheConfig,
  PipelineCacheItem,
  ProcessorType,
} from '@/types/pipelineCache'
import { AgentMessage } from '@/ui/instrument'
import { isPlainObject, jsonClone } from '@/utils/deepmerge'
import { logger } from '@/utils/logger'
// 默认处理器配置
const DEFAULT_PROCESSOR_CONFIGS: Record<ProcessorType, { expireTime: number }> = {
  aiFiltering: { expireTime: 7 * 24 * 60 * 60 * 1000 }, // 7天
  amap: { expireTime: 5 * 24 * 60 * 60 * 1000 }, // 5天
  basic: { expireTime: 3 * 24 * 60 * 60 * 1000 }, // 3天
}

function isPipelineCacheItem(value: unknown): value is PipelineCacheItem {
  if (!isPlainObject(value)) return false
  return (
    typeof value.encryptJobId === 'string' &&
    typeof value.jobName === 'string' &&
    typeof value.brandName === 'string' &&
    typeof value.status === 'string' &&
    typeof value.message === 'string' &&
    typeof value.expireAt === 'number' &&
    Number.isFinite(value.expireAt) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.lastAccessed === 'number' &&
    Number.isFinite(value.lastAccessed) &&
    typeof value.hitCount === 'number' &&
    Number.isFinite(value.hitCount) &&
    ['aiFiltering', 'amap', 'basic'].includes(String(value.processorType))
  )
}

function normalizePersistedCache(value: unknown): PipelineCache | null {
  if (
    !isPlainObject(value) ||
    !isPlainObject(value.data) ||
    typeof value.lastCleanup !== 'number' ||
    !Number.isFinite(value.lastCleanup)
  ) {
    return null
  }

  const data: Record<string, PipelineCacheItem> = {}
  for (const [key, item] of Object.entries(value.data)) {
    if (key.startsWith('v2:') && isPipelineCacheItem(item)) {
      data[key] = item
    }
  }
  return { data, lastCleanup: value.lastCleanup }
}

/**
 * Pipeline缓存管理器
 */
export class PipelineCacheManager {
  private cache = ref<PipelineCache>({
    data: {},
    lastCleanup: Date.now(),
  })

  private config: Required<PipelineCacheConfig>
  private readonly initialization: Promise<void>
  private saveQueue: Promise<void> = Promise.resolve()

  private getCacheKey(encryptJobId: string, scope: string) {
    return `v2:${scope.length}:${scope}:${encryptJobId}`
  }

  constructor(config: PipelineCacheConfig = {}) {
    this.config = {
      expireDays: config.expireDays ?? 3,
      cleanupInterval: config.cleanupInterval ?? 6 * 60 * 60 * 1000, // 6小时
      storageKey: config.storageKey ?? 'local:pipeline-cache',
      // 缓存自身最长过期时间是 7 天（aiFiltering），按每日上限 150 计算 2000 条已覆盖
      // 约 13 天，比任何条目的存活期都长。更大的上限只会挤占 chrome.storage.local
      // 的 10 MiB 总配额（实测 10000 条约 3.2 MB），不会提升命中率。
      maxCacheSize: config.maxCacheSize ?? 2000,
      processorConfigs: config.processorConfigs ?? DEFAULT_PROCESSOR_CONFIGS,
    }

    this.initialization = this.initCache()
  }

  async ready() {
    await this.initialization
  }

  /**
   * 初始化缓存，从存储加载数据
   */
  private async initCache() {
    try {
      const cached = await counter.storageGet<PipelineCache>(this.config.storageKey)
      if (cached) {
        const normalized = normalizePersistedCache(cached)
        if (normalized == null) {
          logger.warn('缓存持久数据格式损坏，已回退空缓存')
          this.cache.value = { data: {}, lastCleanup: Date.now() }
          await this.saveCache()
        } else {
          this.cache.value = normalized
          if (Object.keys(normalized.data).length !== Object.keys(cached.data).length) {
            await this.saveCache()
          }
        }
        logger.debug('缓存数据加载成功', {
          total: Object.keys(this.cache.value.data).length,
        })
      }
      // 检查是否需要清理过期数据
      await this.cleanupIfNeeded()
      await this.evictLRUIfNeeded()
    } catch (error) {
      logger.error('初始化缓存失败', error)
    }
  }

  /**
   * 根据消息内容推断处理器类型
   */
  private inferProcessorType(message: string): ProcessorType {
    if (message.includes('AI') || message.includes('分数')) {
      return 'aiFiltering'
    }
    if (message.includes('地址') || message.includes('距离') || message.includes('地图')) {
      return 'amap'
    }
    return 'basic'
  }

  /**
   * 检查缓存是否有效
   */
  isValidCache(encryptJobId: string, scope: string): boolean {
    const cacheKey = this.getCacheKey(encryptJobId, scope)
    const item = this.cache.value.data[cacheKey]
    if (!item) return false

    if (this.isUnreliableCachedResult(item)) {
      logger.debug('缓存结果不可靠，已忽略', { encryptJobId, item })
      delete this.cache.value.data[cacheKey]
      void this.saveCache()
      return false
    }

    // 检查是否过期
    if (Date.now() > item.expireAt) {
      logger.debug('缓存已过期', { encryptJobId })
      return false
    }

    return true
  }

  private isUnreliableCachedResult(item: PipelineCacheItem) {
    if (item.status === 'error') return true
    if (item.status !== 'warn') return false

    const message = item.message.trim()
    if (this.isRetryableMessage(message)) return true
    if (item.processorType !== 'aiFiltering') return false
    return (
      message === 'AI匹配度' ||
      message.includes('Provider unavailable') ||
      message.includes('heartbeat') ||
      message.includes('请求超时') ||
      message.includes('服务异常')
    )
  }

  private isRetryableMessage(message: string) {
    return [
      'Provider unavailable',
      'heartbeat',
      '请求超时',
      '超时',
      '服务异常',
      '接口异常',
      'api数据异常',
      '没有获取到',
      '未获取到',
      '无活跃内容',
      '无活跃信息',
      '请检查',
      '待重试',
      '不可用',
    ].some((keyword) => message.includes(keyword))
  }

  /**
   * 获取缓存结果
   */
  getCachedResult(encryptJobId: string, scope: string): PipelineCacheItem | null {
    const cacheKey = this.getCacheKey(encryptJobId, scope)
    const item = this.cache.value.data[cacheKey]
    if (!item || Date.now() > item.expireAt) {
      if (item) {
        delete this.cache.value.data[cacheKey]
        void this.saveCache()
      }
      return null
    }

    // 更新LRU信息
    item.lastAccessed = Date.now()
    item.hitCount++

    // logger.debug('当前职位缓存命中次数', {
    //   currentName: `${item.brandName} - ${item.jobName}`,
    //   count: item.hitCount,
    // })

    void this.saveCache()
    return item
  }

  /**
   * 设置缓存结果
   */
  async setCacheResult(
    encryptJobId: string,
    jobName: string,
    brandName: string,
    status: JobStatus,
    message: string,
    scope: string,
    processorType?: ProcessorType,
  ): Promise<void> {
    if (status === 'error' || (status === 'warn' && this.isRetryableMessage(message))) {
      // 不缓存错误或无法判断的待重试状态
      return
    }
    try {
      const now = Date.now()
      const inferredProcessorType = processorType || this.inferProcessorType(message)
      const processorConfig = this.config.processorConfigs[inferredProcessorType]
      const expireAt = now + processorConfig.expireTime

      const cacheItem: PipelineCacheItem = {
        encryptJobId,
        jobName,
        brandName,
        status,
        message,
        expireAt,
        createdAt: now,
        lastAccessed: now,
        hitCount: 0,
        processorType: inferredProcessorType,
      }

      this.cache.value.data[this.getCacheKey(encryptJobId, scope)] = jsonClone(cacheItem)

      // logger.debug('缓存结果已保存', {
      //   encryptJobId,
      //   jobName,
      //   processorType: inferredProcessorType,
      // })

      await this.evictLRUIfNeeded()
      await this.saveCache()
    } catch (error) {
      logger.error('保存缓存结果失败', error)
    }
  }

  /**
   * 保存缓存到存储
   */
  private async saveCache(): Promise<void> {
    const cacheData = jsonClone(this.cache.value)
    const save = this.saveQueue.then(async () => {
      await counter.storageSet(this.config.storageKey, cacheData)
    })
    this.saveQueue = save.then(
      () => undefined,
      () => undefined,
    )
    try {
      await save
    } catch (error) {
      logger.error('保存缓存到存储失败', error)
    }
  }

  /**
   * 清理过期数据
   */
  private async cleanupExpired(): Promise<void> {
    const now = Date.now()
    const data = this.cache.value.data
    let expiredCount = 0

    for (const [key, item] of Object.entries(data)) {
      if (now > item.expireAt) {
        delete data[key]
        expiredCount++
      }
    }

    if (expiredCount > 0) {
      this.cache.value.lastCleanup = now
      await this.saveCache()
      logger.info('清理过期缓存完成', { expiredCount })
    }
  }

  /**
   * LRU淘汰机制 - 当缓存数量超过最大限制时淘汰最少使用的缓存
   */
  private async evictLRUIfNeeded(): Promise<void> {
    const data = this.cache.value.data
    const cacheCount = Object.keys(data).length

    if (cacheCount <= this.config.maxCacheSize) {
      return
    }

    const evictCount = cacheCount - this.config.maxCacheSize
    const items = Object.entries(data).sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed)

    for (let i = 0; i < evictCount; i++) {
      delete data[items[i][0]]
    }

    logger.info('LRU淘汰完成', { evicted: evictCount })
    await this.saveCache()
  }

  /**
   * 如果需要则清理过期数据
   */
  private async cleanupIfNeeded(): Promise<void> {
    const now = Date.now()
    if (now - this.cache.value.lastCleanup > this.config.cleanupInterval) {
      logger.debug('开始清理过期缓存')
      await this.cleanupExpired()
    }
  }

  /**
   * 清空所有缓存
   */
  async clearCache(): Promise<void> {
    this.cache.value.data = {}
    await this.saveCache()
    AgentMessage.success('缓存已清空')
  }
}
