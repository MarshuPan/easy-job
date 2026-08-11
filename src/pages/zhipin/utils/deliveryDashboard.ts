import type { Statistics } from '@/types/formData'

import type { DeliveryLimitSource } from './deliveryLimit'

export type DashboardSourceId = DeliveryLimitSource | 'unknown'

export type DeliveryFailureCategoryId =
  | 'jobFit'
  | 'hardFilter'
  | 'dedupe'
  | 'activity'
  | 'publish'
  | 'aiGreeting'

export interface DashboardJob {
  encryptJobId?: string
  jobName?: string
  brandName?: string
  status?: {
    status?: string
  }
}

export interface DashboardRecord {
  job?: DashboardJob
  title: string
  state: 'info' | 'success' | 'warning' | 'danger'
  state_name: string
  message?: string
  createdAt: number
  updatedAt?: number
  data?: {
    listData?: DashboardJob
    deliverySource?: DeliveryLimitSource
    deliveryStage?: string
    failureStage?: string
    failureReason?: string
    retryable?: boolean
    trace?: Array<{
      stage?: string
      message?: string
    }>
  }
}

export interface DeliveryDashboardArgs {
  dailyLimit: number
  pools: Record<DeliveryLimitSource, DashboardJob[]>
  records: DashboardRecord[]
  targetDate: string
  todayData: Statistics
  weights: Record<DeliveryLimitSource, number>
}

export interface DashboardSourceMetric {
  source: DashboardSourceId
  label: string
  fetched: number
  pending: number
  processed: number
  success: number
  filtered: number
  failed: number
  actualPercent: number
  successRate: number
  targetPercent: number
}

export const failureCategoryLabels: Record<DeliveryFailureCategoryId, string> = {
  jobFit: '岗位方向不符',
  hardFilter: '条件硬筛',
  dedupe: '去重/已沟通',
  activity: '活跃/猎头',
  publish: '接口/风控',
  aiGreeting: 'AI/招呼语',
}

const deliverySources: DeliveryLimitSource[] = ['group', 'search']
// 来源只有两个大类：求职期望和搜索。加「投递池」是把实现细节写进了用户看的标签里——
// 用户在这张表上看的是「哪个来源投得好」，不是「岗位存在哪个池子里」。
const sourceLabels: Record<DeliveryLimitSource, string> = {
  group: '求职期望',
  search: '搜索',
}

// 没有正在处理的岗位时不要编一个岗位名。原来的兜底是「AI 产品岗位」，
// 它看起来和真实岗位名没有区别，未开始投递时会让人以为已经在投某个岗位了。
export function buildDeliveryTaskTitle(jobName?: string, running = false) {
  const title = jobName?.trim()
  if (!title) return running ? '正在准备岗位' : '未开始投递'
  return title.endsWith('投递') ? title : `${title}投递`
}

export function buildDeliveryDashboard(args: DeliveryDashboardArgs) {
  const fetchedKeys: Record<DeliveryLimitSource, Set<string>> = {
    group: new Set(),
    search: new Set(),
  }
  const pendingKeys: Record<DeliveryLimitSource, Set<string>> = {
    group: new Set(),
    search: new Set(),
  }
  const unknownFetchedKeys = new Set<string>()
  const globallyFetchedKeys = new Set<string>()
  const globallyPendingKeys = new Set<string>()
  const failedBySource: Record<DeliveryLimitSource, number> = {
    group: 0,
    search: 0,
  }
  const filteredBySource: Record<DeliveryLimitSource, number> = {
    group: 0,
    search: 0,
  }
  const successBySource: Record<DeliveryLimitSource, number> = {
    group: 0,
    search: 0,
  }
  let unknownFailed = 0
  let unknownFiltered = 0
  let unknownSuccess = 0
  const failureCounts: Record<DeliveryFailureCategoryId, number> = {
    jobFit: 0,
    hardFilter: 0,
    dedupe: 0,
    activity: 0,
    publish: 0,
    aiGreeting: 0,
  }
  let retryableFailures = 0

  for (const source of deliverySources) {
    for (const item of args.pools[source]) {
      const key = getJobKey(item)
      if (key && !globallyFetchedKeys.has(key)) {
        globallyFetchedKeys.add(key)
        fetchedKeys[source].add(key)
      }
      if (key && isDeliverableJob(item) && !globallyPendingKeys.has(key)) {
        globallyPendingKeys.add(key)
        pendingKeys[source].add(key)
      }
    }
  }

  const targetRecords = dedupeRecordsByJob(
    args.records.filter((record) => getLocalDate(new Date(record.createdAt)) === args.targetDate),
  )
  for (const record of targetRecords) {
    const source = resolveRecordSource(record.data?.deliverySource)
    if (isSuccessRecord(record)) {
      if (source) successBySource[source] += 1
      else unknownSuccess += 1
      continue
    }
    if (!isFailureRecord(record)) continue

    if (record.data?.retryable) retryableFailures += 1
    const category = classifyDeliveryFailure(record)
    if (category) failureCounts[category] += 1
    const isFiltered =
      record.data?.deliveryStage === '已过滤' ||
      (category != null && isFilteredFailureCategory(category))
    if (source) {
      if (isFiltered) filteredBySource[source] += 1
      else failedBySource[source] += 1
    } else if (isFiltered) {
      unknownFiltered += 1
    } else {
      unknownFailed += 1
    }
  }

  const totalWeight = deliverySources.reduce(
    (total, source) => total + Math.max(0, Number(args.weights[source]) || 0),
    0,
  )
  const sources = Object.fromEntries(
    deliverySources.map((source) => {
      // 表格恒定用投递记录：成功、过滤、异常三列必须同源，否则各列之间自己就对不上。
      const success = successBySource[source]
      const filtered = filteredBySource[source]
      const failed = failedBySource[source]
      const processed = (success ?? 0) + filtered + failed
      const pending = pendingKeys[source].size
      return [
        source,
        {
          source,
          label: sourceLabels[source],
          fetched: fetchedKeys[source].size,
          pending,
          processed,
          success: success ?? 0,
          filtered,
          failed,
          actualPercent: 0,
          successRate: percentage(success ?? 0, processed),
          targetPercent:
            totalWeight > 0
              ? percentage(Math.max(0, Number(args.weights[source]) || 0), totalWeight)
              : 0,
        },
      ]
    }),
  ) as Record<DeliveryLimitSource, DashboardSourceMetric>

  const unknownSource: DashboardSourceMetric = {
    source: 'unknown',
    label: '未归因来源',
    fetched: unknownFetchedKeys.size,
    pending: 0,
    processed: unknownSuccess + unknownFiltered + unknownFailed,
    success: unknownSuccess,
    filtered: unknownFiltered,
    failed: unknownFailed,
    actualPercent: 0,
    successRate: percentage(unknownSuccess, unknownSuccess + unknownFiltered + unknownFailed),
    targetPercent: 0,
  }
  const sourceRows = [
    ...deliverySources.map((source) => sources[source]),
    ...(unknownSource.fetched > 0 || unknownSource.processed > 0 ? [unknownSource] : []),
  ]

  const fetched = sourceRows.reduce((total, source) => total + source.fetched, 0)
  const pending = sourceRows.reduce((total, source) => total + source.pending, 0)
  for (const source of sourceRows) {
    source.actualPercent = percentage(source.fetched, fetched)
  }

  // 摘要恒定用统计计数器，和顶部「今日已投递 / 上限」同源。
  //
  // 之前这里按「今天有没有成功记录」在统计和记录两个数据源之间切换，于是同一个面板会
  // 因为一个不相干的条件给出两套数字。两者本来就答不同的问题：统计是全量累计，
  // 投递记录只保留最近 200 条，是一个窗口，不可能长期相等，选哪个都不该随条件跳。
  const processed = args.todayData.total
  const success = args.todayData.success
  const failed = Math.max(0, processed - success)
  const remaining = Math.max(0, args.dailyLimit - success)
  return {
    summary: {
      fetched,
      pending,
      processed,
      success,
      failed,
      retryableFailures,
      remaining,
      successRate: percentage(success, processed),
      estimatedRequiredProcessed:
        remaining === 0
          ? 0
          : success > 0 && processed > 0
            ? Math.ceil((remaining * processed) / success)
            : null,
    },
    sources,
    sourceRows,
    failureCategories: Object.entries(failureCategoryLabels).map(([id, label]) => ({
      id: id as DeliveryFailureCategoryId,
      label,
      count: failureCounts[id as DeliveryFailureCategoryId],
    })),
  }
}

function resolveRecordSource(source?: DeliveryLimitSource) {
  return source === 'group' || source === 'search' ? source : null
}

export function classifyDeliveryFailure(record: DashboardRecord): DeliveryFailureCategoryId | null {
  if (!isFailureRecord(record)) return null
  const text = [
    record.state_name,
    record.message,
    record.data?.deliveryStage,
    record.data?.failureStage,
    record.data?.failureReason,
    ...(record.data?.trace ?? []).flatMap((item) => [item.stage, item.message]),
  ]
    .filter(Boolean)
    .join(' ')

  if (/重复|同公司|同HR|沟通过|好友/.test(text)) return 'dedupe'
  if (/猎头|活跃/.test(text)) return 'activity'
  if (/招呼语|AI请求异常|AI招呼语|AI返回|AI生成/.test(text)) return 'aiGreeting'
  if (
    /投递出错|投递接口|建立沟通|接口|限制|上限|频率|操作频繁|token|风控|BOSS|boss|Provider|心跳|通信/.test(
      text,
    )
  ) {
    return 'publish'
  }
  // 下面两条里的岗位名、公司名、薪资、工作地址、HR职位已经不再产生新记录——对应的过滤器
  // 已从产品移除。但投递记录是持久化的，老记录里还存着这些失败原因，归因表要能继续分对，
  // 所以这些词留着，不是死代码。
  if (/AI匹配度|匹配度|岗位名|岗位名称|岗位方向|工作内容|JD筛选|岗位名硬筛/.test(text)) {
    return 'jobFit'
  }
  if (/公司名|公司规模|薪资|工作地址|地址|Hr职位|HR职位/.test(text)) return 'hardFilter'
  return 'publish'
}

function isFilteredFailureCategory(category: DeliveryFailureCategoryId) {
  return (
    category === 'jobFit' ||
    category === 'hardFilter' ||
    category === 'dedupe' ||
    category === 'activity'
  )
}

function getRecordJob(record: DashboardRecord) {
  return record.job ?? record.data?.listData
}

function getLocalDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dedupeRecordsByJob(records: DashboardRecord[]) {
  const recordsByJob = new Map<string, DashboardRecord>()
  const recordsWithoutJob: DashboardRecord[] = []
  for (const record of records) {
    const key = getJobKey(getRecordJob(record))
    if (!key) {
      recordsWithoutJob.push(record)
      continue
    }
    const previous = recordsByJob.get(key)
    const previousAt = previous == null ? -1 : (previous.updatedAt ?? previous.createdAt)
    const currentAt = record.updatedAt ?? record.createdAt
    if (currentAt >= previousAt) recordsByJob.set(key, record)
  }
  return [...recordsByJob.values(), ...recordsWithoutJob]
}

function getJobKey(job?: DashboardJob) {
  if (!job) return ''
  return job.encryptJobId || [job.brandName, job.jobName].filter(Boolean).join(':')
}

function isSuccessRecord(record: DashboardRecord) {
  return (
    getRecordJob(record) != null &&
    (record.state === 'success' || record.data?.deliveryStage === '投递成功')
  )
}

function isFailureRecord(record: DashboardRecord) {
  return (
    getRecordJob(record) != null &&
    (record.state === 'warning' ||
      record.state === 'danger' ||
      record.data?.deliveryStage === '已过滤' ||
      record.data?.deliveryStage === '投递失败' ||
      Boolean(record.data?.failureReason))
  )
}

// 与 getDeliverableJobs 保持同一套判定：已过滤的岗位不再是待处理，
// 否则「投递池待处理」会把早已判掉的岗位一直算进去。
function isDeliverableJob(job: DashboardJob) {
  const status = job.status?.status
  return status === 'pending' || status === 'wait' || status === 'running'
}

function percentage(value: number, total: number) {
  if (total <= 0) return 0
  return Number(((value / total) * 100).toFixed(1))
}
