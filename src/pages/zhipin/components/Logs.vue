<script lang="ts" setup>
import { ChevronRight, Copy, ScrollText, Trash2 } from 'lucide-vue-next'
import { computed, ref } from 'vue'

import type { log, logData } from '@/stores/log'
import { isDiagnosticsEnabled, newestRunEvents, setDiagnosticsEnabled, useLog } from '@/stores/log'
import { AgentButton, AgentMessage, AgentSwitch, AgentTag } from '@/ui/instrument'
import { safeStringify } from '@/utils/safeJson'

import InstrumentEmptyState from './InstrumentEmptyState.vue'

// 运行日志只展示运行事件和 AI 请求诊断；岗位的处理过程在「投递记录」里看。
const logStore = useLog()
const logs = computed(() =>
  newestRunEvents([...logStore.events.value, ...(logStore.runtimeData?.value ?? [])]),
)
const expandedEntries = ref<Set<number>>(new Set())
const diagnostics = ref(isDiagnosticsEnabled())

function toggleDiagnostics(value: boolean) {
  diagnostics.value = value
  setDiagnosticsEnabled(value)
}

function stateType(state: log['state']) {
  return state === 'info' ? 'primary' : state
}

function formatTime(createdAt: number) {
  return new Date(createdAt).toLocaleTimeString('zh-CN', { hour12: false })
}

function logLines(item: log) {
  const lines = [
    `[${formatTime(item.createdAt)}] ${item.state_name} ${item.title}`,
    item.message,
  ].filter(Boolean)

  const detailLines = formatLogDetail(item.publicData)
  if (detailLines.length > 0) {
    lines.push('', ...detailLines)
  }

  return lines.join('\n')
}

function allLogLines() {
  const entries = logs.value.map((item, index) =>
    [`# ${index + 1} / ${logs.value.length}`, logLines(item)].join('\n'),
  )
  return [`运行日志（共 ${logs.value.length} 条）`, '', ...entries].join('\n\n')
}

async function copyAllLogs() {
  if (logs.value.length === 0) {
    AgentMessage.info('暂无日志可复制')
    return
  }
  await copyText(allLogLines())
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText != null) {
      await navigator.clipboard.writeText(text)
    } else {
      fallbackCopy(text)
    }
    AgentMessage.success('日志已复制')
  } catch (e) {
    fallbackCopy(text)
    AgentMessage.success('日志已复制')
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

/** 只有后台 AI 请求诊断带过程明细；运行事件的内容全在 message 里。 */
function formatLogDetail(data?: logData) {
  if (!data?.trace?.length) return []
  return [data.trace.map(formatTrace).join('\n')]
}

function formatTrace(item: NonNullable<logData['trace']>[number]) {
  const time = formatTime(item.at)
  const detail = item.detail == null ? '' : `\n${stringify(item.detail)}`
  return `[${time}] ${item.status} / ${item.stage}: ${item.message}${detail}`
}

function stringify(value: unknown) {
  return safeStringify(value)
}

function isExpanded(index: number) {
  return expandedEntries.value.has(index)
}

function toggleEntry(index: number) {
  const next = new Set(expandedEntries.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  expandedEntries.value = next
}

function clearLogs() {
  expandedEntries.value = new Set()
  logStore.clear()
}
</script>

<template>
  <div class="console-log">
    <div class="console-log__toolbar instrument-view-toolbar">
      <strong class="console-log__count">运行日志 · {{ logs.length }}</strong>
      <div class="console-log__actions">
        <label
          class="console-log__diagnostics"
          title="记录分页、心跳、运行时检查等实现细节，排查问题时再打开"
        >
          <AgentSwitch
            :model-value="diagnostics"
            size="small"
            @update:model-value="toggleDiagnostics(Boolean($event))"
          />
          诊断模式
        </label>
        <AgentButton
          size="small"
          aria-label="复制全部日志"
          :disabled="logs.length === 0"
          @click="copyAllLogs"
        >
          <Copy :size="14" aria-hidden="true" />
          复制全部
        </AgentButton>
        <AgentButton size="small" @click="clearLogs">
          <Trash2 :size="14" aria-hidden="true" />
          清空
        </AgentButton>
      </div>
    </div>

    <InstrumentEmptyState v-if="logs.length === 0" title="暂无运行日志">
      <template #icon><ScrollText :size="20" /></template>
    </InstrumentEmptyState>
    <div v-else class="console-log__body instrument-frame">
      <article
        v-for="(item, index) in logs"
        :key="`${item.createdAt}-${index}`"
        class="console-log__entry"
        :class="{ 'is-expanded': isExpanded(index) }"
      >
        <button
          class="console-log__summary"
          type="button"
          :aria-expanded="isExpanded(index)"
          @click="toggleEntry(index)"
        >
          <ChevronRight class="console-log__chevron" :size="16" aria-hidden="true" />
          <span class="console-log__time">{{ formatTime(item.createdAt) }}</span>
          <AgentTag :type="stateType(item.state)" size="small" :title="item.state_name">
            {{ item.state_name }}
          </AgentTag>
          <span class="console-log__summary-copy">
            <strong class="console-log__title">{{ item.title }}</strong>
            <span v-if="item.message" class="console-log__message">{{ item.message }}</span>
          </span>
        </button>
        <pre v-if="isExpanded(index)" class="console-log__detail">{{ logLines(item) }}</pre>
      </article>
    </div>
  </div>
</template>

<style src="./Logs.css" scoped></style>
