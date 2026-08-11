<script lang="ts" setup>
import { Download, Inbox } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

import { useCommon } from '@/composables/useCommon'
import { useConf } from '@/stores/conf'
import { jobList, type MyJobListData } from '@/stores/jobs'
import type { DeliverySource, DeliveryStage, log, logData, logTraceStatus } from '@/stores/log'
import { useLog } from '@/stores/log'
import {
  AgentButton,
  AgentDrawer,
  AgentMessage,
  AgentPagination,
  AgentPopconfirm,
  AgentTag,
} from '@/ui/instrument'
import { exportJson } from '@/utils/jsonImportExport'
import { safeStringify, toSafeJsonValue } from '@/utils/safeJson'

import { useDeliver } from '../hooks/useDeliver'
import { classifyDeliveryFailure, type DeliveryFailureCategoryId } from '../utils/deliveryDashboard'
import { getDeliveryLimit, inferDeliveryLimitSource } from '../utils/deliveryLimit'
import { previewDeliveryQueue } from '../utils/deliveryQueue'
import { getJobSourceLabel } from '../utils/jobExpectations'
import InstrumentEmptyState from './InstrumentEmptyState.vue'

type TagType = 'primary' | 'success' | 'warning' | 'danger'
type RowStatusKey = 'pending' | 'processing' | 'delivered' | 'filtered' | 'failed'
type DeliveryRow =
  | {
      kind: 'pending'
      key: string
      job: MyJobListData
      source: DeliverySource
    }
  | {
      kind: 'record'
      key: string
      item: log
      job: MyJobListData
      source: DeliverySource
    }

interface RowStatus {
  key: RowStatusKey
  label: string
  stage: DeliveryStage
  type: TagType
}

const props = withDefaults(
  defineProps<{
    visible?: boolean
  }>(),
  {
    visible: true,
  },
)

const logStore = useLog()
const deliver = useDeliver()
const common = useCommon()
const conf = useConf()
const pageSize = 15
const queuePreviewBatchSize = 10
const queuePreviewLimit = 60
const deliveryProgressStepTotal = 8
const deliveryProgressStep: Partial<Record<DeliveryStage, number>> = {
  待处理: 1,
  JD筛选中: 2,
  正在建立沟通: 4,
  打招呼语生成中: 5,
  正在打招呼: 6,
  投递成功: 8,
}
const currentPage = ref(1)
const activeDetailRow = ref<DeliveryRow | null>(null)
const detailLoadError = ref('')
const filteredFailureCategories = new Set<DeliveryFailureCategoryId>([
  'jobFit',
  'hardFilter',
  'dedupe',
  'activity',
])

const fixedRecords = computed(() =>
  logStore.data.value
    .filter((item) => item.job != null || item.data?.listData != null)
    .slice()
    .sort((a, b) => getRecordSortTime(b) - getRecordSortTime(a)),
)

const latestRecordByJobId = computed(() => {
  const records = new Map<string, log>()
  for (const record of fixedRecords.value) {
    const job = getJob(record)
    if (!job || records.has(job.encryptJobId)) continue
    records.set(job.encryptJobId, record)
  }
  return records
})

const recordRows = computed<DeliveryRow[]>(() => {
  const rows: DeliveryRow[] = []
  const added = new Set<string>()

  for (const { job, source } of getCurrentPoolJobs()) {
    if (added.has(job.encryptJobId)) continue
    const record = latestRecordByJobId.value.get(job.encryptJobId)
    if (record) {
      rows.push({
        kind: 'record',
        key: `history-${record.createdAt}-${job.encryptJobId}`,
        item: record,
        job: mergeDisplayJob(job, record),
        source: record.data?.deliverySource ?? source,
      })
    } else {
      rows.push({
        kind: 'pending',
        key: `pending-${job.encryptJobId}`,
        job,
        source,
      })
    }
    added.add(job.encryptJobId)
  }

  for (const record of fixedRecords.value) {
    const job = getJob(record)
    if (!job || added.has(job.encryptJobId)) continue
    rows.push({
      kind: 'record',
      key: `history-${record.createdAt}-${job.encryptJobId}`,
      item: record,
      job,
      source: record.data?.deliverySource ?? 'search',
    })
    added.add(job.encryptJobId)
  }

  return rows
})

const clampedCurrentPage = computed(() => {
  const maxPage = Math.max(1, Math.ceil(recordRows.value.length / pageSize))
  return Math.min(currentPage.value, maxPage)
})

const pagedRows = computed(() => {
  const start = (clampedCurrentPage.value - 1) * pageSize
  return recordRows.value.slice(start, start + pageSize)
})

function setPage(page: number) {
  currentPage.value = page
}

function getCurrentPoolJobs() {
  const rows: Array<{ job: MyJobListData; source: DeliverySource }> = []
  const added = new Set<string>()
  const push = (job: MyJobListData, source: DeliverySource) => {
    if (added.has(job.encryptJobId)) return
    rows.push({ job, source })
    added.add(job.encryptJobId)
  }

  for (const { item, source } of previewDeliveryQueue({
    batchSize: queuePreviewBatchSize,
    getItemKey: (job) => job.encryptJobId,
    getItemOrder: (job) => job.deliveryQueueOrder,
    getItemSource: (job) => job.deliveryQueueSource,
    limit: queuePreviewLimit,
    pools: {
      group: jobList.listBySource('group'),
      search: jobList.listBySource('search'),
    },
    weights: {
      group: getDeliveryLimit(conf.formData, 'group'),
      search: getDeliveryLimit(conf.formData, 'search'),
    },
  })) {
    push(item, source)
  }

  const currentSource = inferDeliveryLimitSource()
  for (const job of jobList.list) push(job, currentSource)

  return rows
}

function getJob(item: log) {
  return mergeJobCard(item.job, item.data?.listData)
}

function mergeDisplayJob(job: MyJobListData, record: log) {
  return mergeJobCard(job, getJob(record)) ?? job
}

function mergeJobCard(primary?: MyJobListData, fallback?: MyJobListData) {
  if (!primary) return fallback
  const fallbackCard = fallback?.card
  if (!fallbackCard) return primary
  return {
    ...primary,
    card: primary.card ? { ...fallbackCard, ...primary.card } : fallbackCard,
  } as MyJobListData
}

function getRecordSortTime(item: log) {
  return item.updatedAt ?? item.createdAt
}

function buildRowStatus(row: DeliveryRow): RowStatus {
  if (row.kind === 'pending') {
    return { key: 'pending', label: '未投递', stage: '待处理', type: 'primary' }
  }

  const data = row.item.data
  const stage = inferRecordStage(row.item, data)
  if (isProcessingStage(stage)) {
    return { key: 'processing', label: '处理中', stage, type: 'warning' }
  }
  if (stage === '投递成功') {
    return { key: 'delivered', label: '已投递', stage, type: 'success' }
  }
  if (stage === '已过滤' || isFilteredFailure(row)) {
    return { key: 'filtered', label: '已过滤', stage, type: 'danger' }
  }
  return { key: 'failed', label: '异常', stage, type: 'danger' }
}

function inferRecordStage(item: log, data?: logData): DeliveryStage {
  if (data?.deliveryStage) return data.deliveryStage
  if (item.state === 'success' && data?.greetingSend?.ok === true) return '投递成功'
  if (item.state === 'success') return '投递失败'
  if (item.state === 'warning' || item.state === 'danger') return '投递失败'
  return '待处理'
}

function isProcessingStage(stage: DeliveryStage) {
  return (
    stage === '待处理' ||
    stage === 'JD筛选中' ||
    stage === '打招呼语生成中' ||
    stage === '正在建立沟通' ||
    stage === '正在打招呼'
  )
}

function isActiveProcessingStage(stage: DeliveryStage) {
  return (
    stage === 'JD筛选中' ||
    stage === '打招呼语生成中' ||
    stage === '正在建立沟通' ||
    stage === '正在打招呼'
  )
}

function isFilteredFailure(row: DeliveryRow) {
  if (row.kind !== 'record') return false
  const category = classifyDeliveryFailure(row.item)
  return category != null && filteredFailureCategories.has(category)
}

function traceStatusName(status: logTraceStatus) {
  const map: Record<logTraceStatus, string> = {
    info: '处理中',
    success: '通过',
    warning: '跳过',
    danger: '失败',
  }
  return map[status]
}

function formatSource(row: DeliveryRow) {
  const storedName = row.kind === 'record' ? row.item.data?.deliverySourceName?.trim() : undefined
  if (storedName) return storedName
  return getJobSourceLabel(row.source, row.job, conf.availableJobExpectations)
}

function formatCompany(job: MyJobListData) {
  return job.brandName || '-'
}

function formatCompanyMeta(job: MyJobListData) {
  return job.brandScaleName || '-'
}

function formatJobName(job: MyJobListData) {
  return job.jobName || '-'
}

function formatSalary(job: MyJobListData) {
  return job.card?.salaryDesc ?? job.salaryDesc ?? '-'
}

function formatRequirements(job: MyJobListData) {
  return [
    job.cityName,
    job.card?.experienceName ?? job.jobExperience,
    job.card?.degreeName ?? job.jobDegree,
  ]
    .filter(Boolean)
    .join(' · ')
}

function formatHrName(job: MyJobListData) {
  return job.card?.bossName ?? job.bossName ?? '-'
}

function formatHrTitle(job: MyJobListData) {
  return job.card?.bossTitle ?? job.bossTitle ?? '-'
}

function formatProgressStep(row: DeliveryRow) {
  if (row.kind === 'pending') return '-'

  const status = buildRowStatus(row)
  const stage =
    status.stage === '投递失败' || status.stage === '已过滤'
      ? row.item.data?.failureStage
      : status.stage
  const step = stage ? deliveryProgressStep[stage] : undefined
  return step == null ? '-' : `${step}/${deliveryProgressStepTotal}`
}

function formatMatchPercent(row: DeliveryRow) {
  if (row.kind === 'pending') return '-'
  const data = row.item.data
  if (typeof data?.matchPercent === 'number') return `${data.matchPercent}%`
  const raw = data?.aiFilteringAjson as { matchPercent?: unknown; score?: unknown } | undefined
  const value = Number(raw?.matchPercent ?? raw?.score)
  return Number.isFinite(value) ? `${Math.round(value)}%` : '-'
}

function formatUnknown(value: unknown) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return safeStringify(value)
  } catch {
    return String(value)
  }
}

function formatTrace(row: DeliveryRow) {
  if (row.kind === 'pending') return '-'
  const trace = row.item.data?.trace ?? []
  if (trace.length === 0) return '-'

  return trace
    .map((entry, index) => {
      const detail = formatUnknown(entry.detail)
      const line = `${index + 1}. [${new Date(entry.at).toLocaleTimeString('zh-CN', {
        hour12: false,
      })}] ${entry.stage} / ${traceStatusName(entry.status)} / ${entry.message}`
      return detail ? `${line}\n${detail}` : line
    })
    .join('\n\n')
}

function formatGreetingJson(row: DeliveryRow) {
  if (row.kind === 'pending') return '-'
  const data = row.item.data
  if (data?.aiGreetingA) return data.aiGreetingA
  if (data?.aiGreetingMessages?.length) {
    return safeStringify({ messages: data.aiGreetingMessages })
  }
  return '-'
}

function formatJdDescription(row: DeliveryRow) {
  return row.job.card?.postDescription || '-'
}

function formatFailureReason(row: DeliveryRow) {
  if (row.kind === 'pending') return '-'
  const status = buildRowStatus(row)
  if (status.key !== 'filtered' && status.key !== 'failed') return '-'
  const data = row.item.data
  const reason = data?.failureReason || row.item.message || data?.err || ''
  const stage = data?.failureStage ? `失败阶段：${data.failureStage}` : ''
  const stateName = row.item.state_name ? `失败类型：${row.item.state_name}` : ''
  const retry = data?.retryable ? '可重试：是' : '可重试：否'
  return [stage, stateName, reason ? `原因：${reason}` : '', retry].filter(Boolean).join('\n')
}

async function copyText(text: string, label: string) {
  try {
    if (navigator.clipboard?.writeText != null) {
      await navigator.clipboard.writeText(text)
    } else {
      fallbackCopy(text)
    }
    AgentMessage.success(`${label}已复制`)
  } catch {
    fallbackCopy(text)
    AgentMessage.success(`${label}已复制`)
  }
}

function fallbackCopy(text: string) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function canRetry(row: DeliveryRow) {
  const status = buildRowStatus(row).key
  return (
    row.kind === 'record' &&
    (status === 'filtered' || status === 'failed') &&
    row.item.data?.retryable &&
    typeof row.job.status?.setStatus === 'function'
  )
}

function isActiveProcessing(row: DeliveryRow) {
  if (row.kind !== 'record') return false
  return isActiveProcessingStage(buildRowStatus(row).stage)
}

function removeRow(row: DeliveryRow) {
  jobList.remove(row.job.encryptJobId)
  if (row.kind === 'record') logStore.remove(row.item)
}

async function deliverRow(row: DeliveryRow) {
  await deliver.deliverOne(row.job, row.source)
}

async function retryRow(row: DeliveryRow) {
  if (row.kind !== 'record') return
  await deliver.retryRecord(row.item)
}

async function openDetail(row: DeliveryRow) {
  detailLoadError.value = ''
  activeDetailRow.value = row
  if (row.job.card?.postDescription || typeof row.job.getCard !== 'function') return
  const detailKey = row.key
  try {
    const card = (await row.job.getCard()) as MyJobListData['card']
    row.job.card = card
    if (activeDetailRow.value?.key === detailKey) {
      activeDetailRow.value = { ...row, job: { ...row.job, card } } as DeliveryRow
    }
  } catch {
    if (activeDetailRow.value?.key !== detailKey) return
    detailLoadError.value = 'JD 读取失败，请稍后重试'
    AgentMessage.warning('JD 读取失败，请稍后重试')
  }
}

function closeDetail() {
  activeDetailRow.value = null
  detailLoadError.value = ''
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) closeDetail()
  },
)

function formatDetailText(row: DeliveryRow) {
  return [
    `岗位：${formatJobName(row.job)}`,
    `公司：${formatCompany(row.job)}`,
    `薪资：${formatSalary(row.job)}`,
    `HR：${formatHrName(row.job)} · ${formatHrTitle(row.job)}`,
    `状态：${buildRowStatus(row).label}`,
    `进度：${formatProgressStep(row)}`,
    `匹配度：${formatMatchPercent(row)}`,
    '',
    `JD 描述：\n${[detailLoadError.value, formatJdDescription(row)].filter(Boolean).join('\n')}`,
    '',
    `流程日志：\n${formatTrace(row)}`,
    '',
    `打招呼语：\n${formatGreetingJson(row)}`,
    '',
    `失败/过滤原因：\n${formatFailureReason(row)}`,
  ].join('\n')
}

function buildExportRow(row: DeliveryRow) {
  const data = row.kind === 'record' ? row.item.data : undefined
  const status = buildRowStatus(row)
  return {
    exportedAt: new Date().toISOString(),
    source: row.source,
    sourceName: formatSource(row),
    status: status.label,
    deliveryStage: status.stage,
    progress: formatProgressStep(row),
    createdAt: row.kind === 'record' ? row.item.createdAt : undefined,
    updatedAt: row.kind === 'record' ? row.item.updatedAt : undefined,
    matchPercent: row.kind === 'record' ? data?.matchPercent : undefined,
    failure:
      row.kind === 'record' && (status.stage === '投递失败' || status.stage === '已过滤')
        ? formatFailureReason(row)
        : '',
    job: {
      encryptJobId: row.job.encryptJobId,
      jobName: row.job.jobName,
      cityName: row.job.cityName,
      salaryDesc: formatSalary(row.job),
      experienceName: row.job.card?.experienceName ?? row.job.jobExperience,
      degreeName: row.job.card?.degreeName ?? row.job.jobDegree,
      brandName: row.job.brandName,
      brandScaleName: row.job.brandScaleName,
      bossName: row.job.card?.bossName ?? row.job.bossName,
      bossTitle: row.job.card?.bossTitle ?? row.job.bossTitle,
      jobLabels: row.job.card?.jobLabels ?? row.job.jobLabels,
    },
    jd: {
      description: row.job.card?.postDescription ?? '',
    },
    trace: row.kind === 'record' ? toSafeJsonValue(data?.trace ?? []) : [],
    greeting: {
      rawJson: data?.aiGreetingA ?? '',
      messages: data?.aiGreetingMessages ?? [],
      send: toSafeJsonValue(data?.greetingSend),
    },
  }
}

function exportRecords() {
  exportJson(
    {
      exportedAt: new Date().toISOString(),
      count: recordRows.value.length,
      records: recordRows.value.map(buildExportRow),
    },
    `投递记录-${new Date().toISOString().slice(0, 10)}`,
  )
}
</script>

<template>
  <section class="delivery-records">
    <div class="delivery-records__head instrument-view-toolbar">
      <div class="delivery-records__count">
        <strong>投递记录 · {{ recordRows.length }}</strong>
        <span>第 {{ clampedCurrentPage }} 页</span>
      </div>
      <div class="delivery-records__actions">
        <AgentButton size="small" :disabled="recordRows.length === 0" @click="exportRecords">
          <Download :size="14" aria-hidden="true" />
          导出记录
        </AgentButton>
      </div>
    </div>

    <InstrumentEmptyState v-if="recordRows.length === 0" title="暂无投递记录">
      <template #icon><Inbox :size="20" /></template>
    </InstrumentEmptyState>
    <div v-else class="delivery-records__table-wrap instrument-frame">
      <table class="delivery-records__table">
        <colgroup>
          <col class="delivery-records__col-job" />
          <col class="delivery-records__col-salary" />
          <col class="delivery-records__col-source" />
          <col class="delivery-records__col-match" />
          <col class="delivery-records__col-status" />
          <col class="delivery-records__col-progress" />
          <col class="delivery-records__col-action" />
        </colgroup>
        <thead>
          <tr>
            <th>岗位 / 公司</th>
            <th>薪资 / 要求</th>
            <th>来源</th>
            <th>匹配度</th>
            <th>状态</th>
            <th>进度</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in pagedRows" :key="row.key">
            <td>
              <div class="delivery-records__job-cell">
                <AgentButton
                  class="delivery-records__jd-button"
                  size="small"
                  link
                  :title="formatJdDescription(row)"
                  @click="openDetail(row)"
                >
                  {{ formatJobName(row.job) }}
                </AgentButton>
                <div class="delivery-records__secondary">
                  {{ formatCompany(row.job) }} · {{ formatCompanyMeta(row.job) }}
                </div>
              </div>
            </td>
            <td>
              <div class="delivery-records__salary">{{ formatSalary(row.job) }}</div>
              <div class="delivery-records__secondary">{{ formatRequirements(row.job) }}</div>
            </td>
            <td>{{ formatSource(row) }}</td>
            <td>{{ formatMatchPercent(row) }}</td>
            <td>
              <AgentTag :type="buildRowStatus(row).type" size="small">
                {{ buildRowStatus(row).label }}
              </AgentTag>
            </td>
            <td class="delivery-records__progress">{{ formatProgressStep(row) }}</td>
            <td>
              <div class="delivery-records__row-actions">
                <AgentButton
                  v-if="row.kind === 'pending'"
                  type="success"
                  link
                  :disabled="common.deliverLock"
                  @click="deliverRow(row)"
                >
                  投递
                </AgentButton>
                <AgentButton
                  v-if="canRetry(row)"
                  type="warning"
                  link
                  :disabled="common.deliverLock"
                  @click="retryRow(row)"
                >
                  重试
                </AgentButton>
                <AgentButton v-if="isActiveProcessing(row)" link disabled>处理中</AgentButton>
                <AgentPopconfirm
                  title="确认移除这条JD？"
                  confirm-button-text="移除"
                  cancel-button-text="取消"
                  popper-class="instrument-popconfirm"
                  @confirm="removeRow(row)"
                >
                  <template #reference>
                    <AgentButton type="danger" link :disabled="isActiveProcessing(row)"
                      >移除</AgentButton
                    >
                  </template>
                </AgentPopconfirm>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="recordRows.length > pageSize" class="delivery-records__pager">
      <AgentPagination
        background
        layout="prev, pager, next"
        :current-page="clampedCurrentPage"
        :page-size="pageSize"
        :total="recordRows.length"
        @current-change="setPage"
      />
    </div>

    <AgentDrawer
      class="delivery-records__process-drawer"
      :model-value="activeDetailRow != null"
      :title="activeDetailRow ? `${formatJobName(activeDetailRow.job)} · 流程详情` : '流程详情'"
      size="560px"
      @update:model-value="closeDetail"
    >
      <div v-if="activeDetailRow" class="delivery-records__drawer">
        <section class="delivery-records__detail-summary">
          <div>
            <span>公司</span>
            <strong>{{ formatCompany(activeDetailRow.job) }}</strong>
          </div>
          <div>
            <span>薪资</span>
            <strong>{{ formatSalary(activeDetailRow.job) }}</strong>
          </div>
          <div>
            <span>HR</span>
            <strong>
              {{ formatHrName(activeDetailRow.job) }} · {{ formatHrTitle(activeDetailRow.job) }}
            </strong>
          </div>
          <div>
            <span>状态</span>
            <strong>{{ buildRowStatus(activeDetailRow).label }}</strong>
          </div>
          <div>
            <span>匹配度</span>
            <strong>{{ formatMatchPercent(activeDetailRow) }}</strong>
          </div>
          <div>
            <span>来源</span>
            <strong>{{ formatSource(activeDetailRow) }}</strong>
          </div>
        </section>

        <div class="delivery-records__detail-toolbar">
          <AgentButton
            size="small"
            type="primary"
            @click="copyText(formatDetailText(activeDetailRow), '全部详情')"
          >
            复制全部详情
          </AgentButton>
        </div>
        <div v-if="detailLoadError" class="delivery-records__detail-error">
          {{ detailLoadError }}
        </div>

        <section class="delivery-records__detail-card">
          <div class="delivery-records__detail-card-head">
            <h4>JD 描述</h4>
            <AgentButton
              size="small"
              link
              type="primary"
              @click="copyText(formatJdDescription(activeDetailRow), 'JD描述')"
            >
              复制
            </AgentButton>
          </div>
          <pre>{{ formatJdDescription(activeDetailRow) }}</pre>
        </section>
        <section class="delivery-records__detail-card">
          <div class="delivery-records__detail-card-head">
            <h4>流程日志</h4>
            <AgentButton
              size="small"
              link
              type="primary"
              @click="copyText(formatTrace(activeDetailRow), '流程日志')"
            >
              复制
            </AgentButton>
          </div>
          <pre>{{ formatTrace(activeDetailRow) }}</pre>
        </section>
        <section class="delivery-records__detail-card">
          <div class="delivery-records__detail-card-head">
            <h4>打招呼语</h4>
            <AgentButton
              size="small"
              link
              type="primary"
              @click="copyText(formatGreetingJson(activeDetailRow), '打招呼语')"
            >
              复制
            </AgentButton>
          </div>
          <pre>{{ formatGreetingJson(activeDetailRow) }}</pre>
        </section>
        <section class="delivery-records__detail-card">
          <div class="delivery-records__detail-card-head">
            <h4>失败/过滤原因</h4>
            <AgentButton
              size="small"
              link
              type="primary"
              @click="copyText(formatFailureReason(activeDetailRow), '失败原因')"
            >
              复制
            </AgentButton>
          </div>
          <pre>{{ formatFailureReason(activeDetailRow) }}</pre>
        </section>
      </div>
    </AgentDrawer>
  </section>
</template>

<style src="./DeliveryRecords.css" scoped></style>
