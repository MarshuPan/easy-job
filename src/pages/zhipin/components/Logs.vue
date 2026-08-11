<script lang="ts" setup>
import { ChevronRight, Copy, ScrollText, Trash2 } from 'lucide-vue-next'
import { computed, ref } from 'vue'

import type { log, logData } from '@/stores/log'
import { newestDeliveryLogs, useLog } from '@/stores/log'
import { AgentButton, AgentMessage, AgentTag } from '@/ui/instrument'
import { safeStringify } from '@/utils/safeJson'

import InstrumentEmptyState from './InstrumentEmptyState.vue'

const logStore = useLog()
const logs = computed(() =>
  newestDeliveryLogs([...logStore.data.value, ...(logStore.runtimeData?.value ?? [])]),
)
const expandedEntries = ref<Set<number>>(new Set())

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

function formatLogDetail(data?: logData) {
  if (!data) return []

  const lines: string[] = []
  if (data.trace?.length) {
    lines.push(sectionText('流程追踪', data.trace.map(formatTrace).join('\n')))
  }
  if (data.publish) lines.push(sectionText('投递接口', stringify(data.publish)))
  if (data.greetingSend) lines.push(sectionText('招呼语发送', stringify(data.greetingSend)))
  if (data.state) lines.push(`状态: ${data.state}`)
  if (data.message) lines.push(`消息: ${data.message}`)
  if (data.err) lines.push(`错误: ${data.err}`)
  if (data.aiFilteringR) lines.push(sectionText('AI匹配度思考', data.aiFilteringR))
  if (data.aiFilteringAtext) lines.push(sectionText('AI匹配度响应', data.aiFilteringAtext))
  if (data.aiFilteringAjson)
    lines.push(sectionText('AI匹配度JSON', stringify(data.aiFilteringAjson)))
  if (data.aiGreetingR) lines.push(sectionText('AI招呼语思考', data.aiGreetingR))
  if (data.aiGreetingA) lines.push(sectionText('AI招呼语响应', data.aiGreetingA))
  if (data.aiGreetingMessages?.length) {
    lines.push(
      sectionText(
        'AI招呼语拆分',
        data.aiGreetingMessages.map((item, index) => `${index + 1}. ${item}`).join('\n'),
      ),
    )
  }
  if (data.greetingWarning) lines.push(`招呼语状态: ${data.greetingWarning}`)
  lines.push(sectionText('原始数据', stringify(data)))

  return lines
}

function formatTrace(item: NonNullable<logData['trace']>[number]) {
  const time = formatTime(item.at)
  const detail = item.detail == null ? '' : `\n${stringify(item.detail)}`
  return `[${time}] ${item.status} / ${item.stage}: ${item.message}${detail}`
}

function sectionText(title: string, content: string) {
  return `--- ${title} ---\n${content}`
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
