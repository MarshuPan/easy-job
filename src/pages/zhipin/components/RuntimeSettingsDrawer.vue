<script lang="ts" setup>
import { watchDebounced } from '@vueuse/core'
import { RotateCcw } from 'lucide-vue-next'
import { nextTick, watch } from 'vue'

import {
  COMMUTE_FEATURE_AVAILABLE,
  CONFIG_LIMITS,
  DEFAULT_AI_GREETING_PROMPT,
} from '@/config/defaults'
import {
  GREETING_LENGTH_VARIANCE,
  GREETING_TARGET_MAX,
  GREETING_TARGET_MIN,
} from '@/config/greetingLength'
import { useConf } from '@/stores/conf'
import type { FormData } from '@/types/formData'
import {
  AgentButton,
  AgentMessage,
  AgentRadioButton,
  AgentRadioGroup,
  AgentSelect,
  AgentSwitch,
} from '@/ui/instrument'
import { jsonClone } from '@/utils/deepmerge'

const conf = useConf()
const runtimeConfigKeys = [
  'deliveryLimit',
  'delay',
  'friendStatus',
  'sameCompanyFilter',
  'sameHrFilter',
  'goldHunterFilter',
  'jobContent',
  'activityFilter',
  'amap',
] as const satisfies readonly (keyof FormData)[]
// AI 任务是全局数据，与按账号分区的运行配置分开保存（契约 §3）。
const aiTaskKeys = ['aiFiltering', 'aiGreeting'] as const satisfies readonly (keyof FormData)[]
type RuntimeConfigSnapshot = Pick<FormData, (typeof runtimeConfigKeys)[number]>
type AiTaskSnapshot = Pick<FormData, (typeof aiTaskKeys)[number]>

let runtimeResetSnapshot: RuntimeConfigSnapshot | null = null
let persistedRuntimeSnapshot: RuntimeConfigSnapshot | null = null
let autoSaveReady = false
let persistedAiTaskSnapshot: string | null = null
let aiTaskResetSnapshot: AiTaskSnapshot | null = null
let resetInProgress = false
let persistVersion = 0

function captureRuntimeConfig(): RuntimeConfigSnapshot {
  return jsonClone(
    Object.fromEntries(runtimeConfigKeys.map((key) => [key, conf.formData[key]])),
  ) as RuntimeConfigSnapshot
}

function restoreRuntimeConfig(snapshot: RuntimeConfigSnapshot) {
  Object.assign(conf.formData, jsonClone(snapshot))
}

function captureAiTasks(): AiTaskSnapshot {
  return jsonClone(
    Object.fromEntries(aiTaskKeys.map((key) => [key, conf.formData[key]])),
  ) as AiTaskSnapshot
}

function serializeAiTasks() {
  return JSON.stringify(aiTaskKeys.map((key) => conf.formData[key]))
}

function isSameRuntimeConfig(left: RuntimeConfigSnapshot, right: RuntimeConfigSnapshot) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function persistRuntimeConfig(
  candidate = captureRuntimeConfig(),
  rollback = persistedRuntimeSnapshot ?? captureRuntimeConfig(),
) {
  const changeVersion = ++persistVersion
  const saved = await conf.confPersist()
  if (saved) {
    persistedRuntimeSnapshot = candidate
    return true
  }
  if (changeVersion !== persistVersion) return false
  const lastPersisted = persistedRuntimeSnapshot ?? rollback
  persistedRuntimeSnapshot = lastPersisted
  restoreRuntimeConfig(lastPersisted)
  return false
}

async function resetRuntimeSettings() {
  if (runtimeResetSnapshot == null) return false
  const rollback = persistedRuntimeSnapshot ?? captureRuntimeConfig()
  const target = jsonClone(runtimeResetSnapshot)
  const aiTarget = aiTaskResetSnapshot == null ? null : jsonClone(aiTaskResetSnapshot)
  resetInProgress = true
  try {
    restoreRuntimeConfig(target)
    // AI 任务与运行配置显示在同一个面板，重置必须一并恢复，只是走各自的保存路径。
    if (aiTarget != null) Object.assign(conf.formData, aiTarget)
    await nextTick()
    const runtimeSaved = await persistRuntimeConfig(target, rollback)
    if (aiTarget == null) return runtimeSaved
    const aiSaved = await conf.persistAiTasks()
    if (aiSaved) persistedAiTaskSnapshot = serializeAiTasks()
    return runtimeSaved && aiSaved
  } finally {
    resetInProgress = false
  }
}

watch(
  () => conf.isLoaded,
  (loaded) => {
    autoSaveReady = false
    if (!loaded) {
      runtimeResetSnapshot = null
      persistedRuntimeSnapshot = null
      aiTaskResetSnapshot = null
      persistedAiTaskSnapshot = null
      return
    }
    const snapshot = captureRuntimeConfig()
    runtimeResetSnapshot = snapshot
    persistedRuntimeSnapshot = jsonClone(snapshot)
    // 建立 AI 任务的基线，避免加载完成后立刻触发一次无变化的保存。
    aiTaskResetSnapshot = captureAiTasks()
    persistedAiTaskSnapshot = serializeAiTasks()
    void nextTick(() => {
      if (conf.isLoaded) autoSaveReady = true
    })
  },
  { immediate: true, flush: 'sync' },
)

watchDebounced(
  () => runtimeConfigKeys.map((key) => conf.formData[key]),
  () => {
    if (!autoSaveReady || resetInProgress) return
    const candidate = captureRuntimeConfig()
    if (persistedRuntimeSnapshot && isSameRuntimeConfig(candidate, persistedRuntimeSnapshot)) return
    void persistRuntimeConfig(candidate)
  },
  { deep: true, debounce: 250, maxWait: 1_000 },
)

watchDebounced(
  () => aiTaskKeys.map((key) => conf.formData[key]),
  () => {
    if (!autoSaveReady || resetInProgress) return
    const candidate = serializeAiTasks()
    if (candidate === persistedAiTaskSnapshot) return
    persistedAiTaskSnapshot = candidate
    void conf.persistAiTasks()
  },
  { deep: true, debounce: 250, maxWait: 1_000 },
)

function setJobContentEnabled(value: string | number | boolean) {
  conf.formData.jobContent.enable = Boolean(value)
}

function ensureAiPrerequisites(task: 'filtering' | 'greeting') {
  if (!conf.readiness?.modelReady) {
    AgentMessage.warning('模型未配置，请先配置')
    return false
  }
  if (!conf.readiness.resumeReady) {
    AgentMessage.warning(
      conf.readiness.resumeStatus === 'error' ? '个人简历尚未解析成功' : '请先填写并保存个人简历',
    )
    return false
  }
  if (task === 'greeting' && conf.readiness.displayNameReady === false) {
    AgentMessage.warning('请先填写姓名或对外称呼')
    return false
  }
  return true
}

function setAiFilteringEnabled(value: string | number | boolean) {
  const enabled = Boolean(value)
  if (enabled && !ensureAiPrerequisites('filtering')) return
  conf.formData.aiFiltering.enable = enabled
}

function setAiGreetingEnabled(value: string | number | boolean) {
  const enabled = Boolean(value)
  if (enabled && !ensureAiPrerequisites('greeting')) return
  if (!enabled) {
    // 关闭是即时安全控制：先让界面和执行链路立刻停用，再异步落盘，
    // 不等网络往返。投递运行中也必须生效，因此走专用入口而不是常规保存。
    conf.formData.aiGreeting.enable = false
    persistedAiTaskSnapshot = serializeAiTasks()
    void conf.disableAiGreetingNow()
    return
  }
  conf.formData.aiGreeting.enable = enabled
}

function setCommuteEnabled(value: string | number | boolean) {
  const enabled = Boolean(value)
  if (enabled && !COMMUTE_FEATURE_AVAILABLE) {
    conf.formData.amap.enable = false
    AgentMessage.warning('该功能暂未开放')
    return
  }
  conf.formData.amap.enable = enabled
}

function restoreGreetingPrompt() {
  conf.formData.aiGreeting.prompt = DEFAULT_AI_GREETING_PROMPT
}

defineExpose({ resetRuntimeSettings })
</script>

<template>
  <section class="runtime-settings">
    <div class="runtime-settings__toolbar instrument-view-toolbar">
      <strong>运行配置</strong>
      <AgentButton
        data-test="reset-runtime-settings"
        plain
        size="small"
        :disabled="!conf.isLoaded"
        @click="resetRuntimeSettings"
      >
        <RotateCcw :size="14" aria-hidden="true" />
        重置
      </AgentButton>
    </div>

    <div class="runtime-settings__frame instrument-frame">
      <section class="instrument-setting-section" data-test="queue-and-pace-settings">
        <div class="instrument-setting-title">队列与节奏</div>
        <div>
          <div class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>搜索来源比例</strong>
              <span>搜索岗位在投递队列中的占比</span>
            </span>
            <label class="runtime-settings__unit-field">
              <input
                v-model.number="conf.formData.deliveryLimit.search"
                type="number"
                inputmode="numeric"
                aria-label="搜索来源比例"
                min="0"
                max="100"
                step="5"
              />
              <span>%</span>
            </label>
          </div>

          <div class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>求职期望来源比例</strong>
              <span>求职期望岗位在投递队列中的占比</span>
            </span>
            <label class="runtime-settings__unit-field">
              <input
                v-model.number="conf.formData.deliveryLimit.group"
                type="number"
                inputmode="numeric"
                aria-label="求职期望来源比例"
                min="0"
                max="100"
                step="5"
              />
              <span>%</span>
            </label>
          </div>

          <div class="instrument-setting-row">
            <div class="instrument-setting-copy">
              <strong>单 JD 耗时</strong>
              <span>典型值 / 九成不超过；刚开工更快，跑久了变慢</span>
            </div>
            <div class="runtime-settings__compound-field">
              <input
                v-model.number="conf.formData.delay.deliveryInterval"
                type="number"
                inputmode="numeric"
                aria-label="单个岗位最短处理间隔"
                min="20"
                max="180"
                step="5"
              />
              <span>至</span>
              <input
                v-model.number="conf.formData.delay.deliveryIntervalMax"
                type="number"
                inputmode="numeric"
                aria-label="单个岗位最长处理间隔"
                min="30"
                max="240"
                step="5"
              />
              <span>秒</span>
            </div>
          </div>

          <div class="instrument-setting-row">
            <div class="instrument-setting-copy">
              <strong>招呼语分段间隔</strong>
              <span>多段招呼语之间的基础间隔，实际会按字数加打字时间并随机抖动</span>
            </div>
            <div class="runtime-settings__compound-field">
              <input
                v-model.number="conf.formData.delay.greetingSegment"
                type="number"
                inputmode="numeric"
                aria-label="招呼语分段基础间隔秒数"
                min="0"
                max="120"
                step="1"
              />
              <span>秒</span>
            </div>
          </div>

          <div class="instrument-setting-row">
            <div class="instrument-setting-copy">
              <strong>批量休息</strong>
              <span>达到指定成功数后暂停</span>
            </div>
            <div class="runtime-settings__compound-field">
              <input
                v-model.number="conf.formData.delay.batchSize"
                type="number"
                inputmode="numeric"
                aria-label="批量岗位数量"
                min="5"
                max="80"
                step="5"
              />
              <span>个 /</span>
              <input
                v-model.number="conf.formData.delay.batchRestMinutes"
                type="number"
                inputmode="numeric"
                aria-label="批量休息分钟数"
                min="1"
                max="60"
                step="1"
              />
              <span>分钟</span>
            </div>
          </div>
        </div>
      </section>

      <section class="instrument-setting-section" data-test="job-card-filters">
        <div class="instrument-setting-title">岗位过滤</div>
        <div>
          <label class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>已沟通 / 好友状态</strong>
              <span>跳过已建立过沟通关系的岗位</span>
            </span>
            <AgentSwitch v-model="conf.formData.friendStatus.value" />
          </label>

          <label class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>同公司去重</strong>
              <span>当天不重复投递同一家公司</span>
            </span>
            <AgentSwitch v-model="conf.formData.sameCompanyFilter.value" />
          </label>

          <label class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>同 HR 去重</strong>
              <span>当天不重复触达同一招聘者</span>
            </span>
            <AgentSwitch v-model="conf.formData.sameHrFilter.value" />
          </label>

          <label class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>猎头岗位</strong>
              <span>跳过列表中标记为猎头发布的岗位</span>
            </span>
            <AgentSwitch v-model="conf.formData.goldHunterFilter.value" />
          </label>
        </div>
      </section>

      <section class="instrument-setting-section" data-test="job-detail-filters">
        <div class="instrument-setting-title">岗位详情</div>
        <div>
          <div class="instrument-setting-row" data-test="job-content-toggle-row">
            <div class="instrument-setting-copy">
              <strong>工作内容</strong>
              <span>基于完整 JD 的关键词规则</span>
            </div>
            <AgentSwitch
              :model-value="conf.formData.jobContent.enable"
              aria-label="启用工作内容筛选"
              @change="setJobContentEnabled"
            />
          </div>

          <div
            v-if="conf.formData.jobContent.enable"
            class="runtime-settings__keyword-panel"
            data-test="job-content-keyword-panel"
          >
            <div class="instrument-setting-row runtime-settings__keyword-rule-row">
              <div class="instrument-setting-copy runtime-settings__keyword-rule-copy">
                <AgentRadioGroup
                  v-model="conf.formData.jobContent.include"
                  class="runtime-settings__keyword-mode"
                  data-test="job-content-mode"
                  aria-label="工作内容匹配方式"
                >
                  <AgentRadioButton :value="true" label="包含" />
                  <AgentRadioButton :value="false" label="排除" />
                </AgentRadioGroup>
              </div>
              <AgentSelect
                v-model="conf.formData.jobContent.value"
                class="runtime-settings__keyword-select"
                data-test="job-content-keywords"
                multiple
                filterable
                allow-create
                collapse-tags
                :max-collapse-tags="2"
                placeholder="输入关键词后回车"
              />
            </div>
          </div>

          <label class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>招聘者活跃度</strong>
              <span>跳过7日内不活跃的招聘者</span>
            </span>
            <AgentSwitch v-model="conf.formData.activityFilter.value" />
          </label>

          <label class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>通勤距离</strong>
              <span>该功能暂未开放</span>
            </span>
            <AgentSwitch
              :model-value="COMMUTE_FEATURE_AVAILABLE && conf.formData.amap.enable"
              aria-label="启用通勤距离"
              aria-disabled="true"
              @update:model-value="setCommuteEnabled"
            />
          </label>

          <div
            v-if="COMMUTE_FEATURE_AVAILABLE && conf.formData.amap.enable"
            class="runtime-settings__commute-panel"
          >
            <label class="runtime-settings__text-field">
              <span>高德 Web 服务 Key</span>
              <input
                v-model.trim="conf.formData.amap.key"
                type="password"
                autocomplete="off"
                aria-label="高德 Web 服务 Key"
              />
            </label>
            <label class="runtime-settings__text-field">
              <span>通勤起点</span>
              <input
                v-model.trim="conf.formData.amap.origins"
                type="text"
                aria-label="通勤起点"
                placeholder="地址或经度,纬度"
              />
            </label>
            <div class="runtime-settings__threshold-grid">
              <label>
                <span>直线 km</span>
                <input
                  v-model.number="conf.formData.amap.straightDistance"
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  aria-label="直线距离上限"
                />
              </label>
              <label>
                <span>驾车 km</span>
                <input
                  v-model.number="conf.formData.amap.drivingDistance"
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  aria-label="驾车距离上限"
                />
              </label>
              <label>
                <span>驾车 min</span>
                <input
                  v-model.number="conf.formData.amap.drivingDuration"
                  type="number"
                  min="0"
                  max="1440"
                  step="5"
                  aria-label="驾车时间上限"
                />
              </label>
              <label>
                <span>步行 km</span>
                <input
                  v-model.number="conf.formData.amap.walkingDistance"
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  aria-label="步行距离上限"
                />
              </label>
              <label>
                <span>步行 min</span>
                <input
                  v-model.number="conf.formData.amap.walkingDuration"
                  type="number"
                  min="0"
                  max="1440"
                  step="5"
                  aria-label="步行时间上限"
                />
              </label>
            </div>
          </div>
        </div>
      </section>

      <section class="instrument-setting-section" data-test="ai-runtime-settings">
        <div class="instrument-setting-title">AI 与招呼语</div>
        <div>
          <label class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>AI 匹配</strong>
              <span>基于完整 JD 与简历证据做最终判断</span>
            </span>
            <AgentSwitch
              :model-value="conf.formData.aiFiltering.enable"
              aria-label="启用 AI 匹配"
              @update:model-value="setAiFilteringEnabled"
            />
          </label>

          <div
            v-if="conf.formData.aiFiltering.enable"
            class="runtime-settings__ai-threshold-panel"
            data-test="ai-threshold-panel"
          >
            <div class="instrument-setting-row runtime-settings__ai-threshold-row">
              <span class="instrument-setting-copy">
                <strong>最低匹配度</strong>
                <span>AI 分数达到该值才继续投递</span>
              </span>
              <label class="runtime-settings__unit-field">
                <input
                  v-model.number="conf.formData.aiFiltering.score"
                  type="number"
                  inputmode="numeric"
                  aria-label="最低匹配度"
                  min="0"
                  max="100"
                  step="1"
                />
                <span>%</span>
              </label>
            </div>
          </div>

          <label class="instrument-setting-row">
            <span class="instrument-setting-copy">
              <strong>AI 招呼语</strong>
              <span>
                使用完整 JD 与简历证据生成招呼语（开启需关闭自动打招呼 -
                <a
                  class="runtime-settings__external-link"
                  href="https://www.zhipin.com/web/geek/notify-set?type=greetSet"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click.stop
                >
                  前往
                </a>
                ）
              </span>
            </span>
            <AgentSwitch
              :model-value="conf.formData.aiGreeting.enable"
              aria-label="启用 AI 招呼语"
              @update:model-value="setAiGreetingEnabled"
            />
          </label>

          <div
            v-if="conf.formData.aiGreeting.enable"
            class="runtime-settings__greeting-panel"
            data-test="ai-greeting-panel"
          >
            <div class="instrument-setting-row runtime-settings__greeting-row">
              <span class="instrument-setting-copy">
                <strong>单次消息条数</strong>
                <span>每次建立沟通后发送的消息数量</span>
              </span>
              <label class="runtime-settings__unit-field">
                <input
                  v-model.number="conf.formData.aiGreeting.messageCount"
                  type="number"
                  inputmode="numeric"
                  aria-label="AI 招呼语消息条数"
                  min="1"
                  max="5"
                  step="1"
                />
                <span>条</span>
              </label>
            </div>

            <div class="instrument-setting-row runtime-settings__greeting-row">
              <span class="instrument-setting-copy">
                <strong>目标总字数</strong>
                <span>
                  {{ conf.formData.aiGreeting.targetTotalCharacters - GREETING_LENGTH_VARIANCE }}-{{
                    conf.formData.aiGreeting.targetTotalCharacters + GREETING_LENGTH_VARIANCE
                  }}
                  字
                </span>
              </span>
              <label class="runtime-settings__unit-field">
                <input
                  v-model.number="conf.formData.aiGreeting.targetTotalCharacters"
                  type="number"
                  inputmode="numeric"
                  aria-label="AI 招呼语目标总字数"
                  :min="GREETING_TARGET_MIN"
                  :max="GREETING_TARGET_MAX"
                  step="5"
                />
                <span>字</span>
              </label>
            </div>

            <label class="runtime-settings__prompt-field">
              <span class="runtime-settings__prompt-head">
                <span>用户 Prompt</span>
                <button
                  type="button"
                  title="恢复默认用户 Prompt"
                  aria-label="恢复默认 AI 招呼语用户 Prompt"
                  @click="restoreGreetingPrompt"
                >
                  <RotateCcw :size="14" />
                </button>
              </span>
              <textarea
                v-model="conf.formData.aiGreeting.prompt"
                data-test="ai-greeting-prompt"
                aria-label="AI 招呼语用户 Prompt"
                rows="7"
                :maxlength="CONFIG_LIMITS.promptCharacters"
              />
            </label>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.runtime-settings {
  min-height: 0;
}

.runtime-settings__toolbar {
  width: 100%;
}

.runtime-settings__frame {
  min-height: 0;
  overflow: visible;
}

.runtime-settings__unit-field,
.runtime-settings__compound-field,
.runtime-settings__text-field input,
.runtime-settings__threshold-grid input {
  min-height: 34px;
  border: 1px solid var(--instrument-charcoal);
  border-radius: 0;
  color: var(--agent-text);
  background: #fff;
  font: inherit;
  font-variant-numeric: tabular-nums;
}

.runtime-settings__unit-field,
.runtime-settings__compound-field {
  display: grid;
  width: 170px;
  align-items: center;
}

.runtime-settings__unit-field {
  grid-template-columns: minmax(0, 1fr) auto;
  padding-right: 9px;
}

.runtime-settings__compound-field {
  min-width: 0;
  grid-template-columns: minmax(32px, 1fr) auto minmax(32px, 1fr) auto;
  gap: 5px;
  padding: 0 8px;
}

.runtime-settings__unit-field span,
.runtime-settings__compound-field span,
.runtime-settings__text-field span,
.runtime-settings__threshold-grid span {
  color: var(--agent-muted);
  font-size: 12px;
  white-space: nowrap;
}

.runtime-settings__unit-field input,
.runtime-settings__compound-field input {
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0;
  border: 0;
  outline: 0;
  color: var(--agent-text);
  background: transparent;
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.runtime-settings__external-link {
  color: var(--agent-primary-hover);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.runtime-settings__external-link:hover {
  color: var(--agent-primary);
}

.runtime-settings__unit-field:focus-within,
.runtime-settings__compound-field:focus-within,
.runtime-settings__text-field input:focus,
.runtime-settings__threshold-grid input:focus {
  border-color: var(--agent-brand-strong);
  outline: 0;
  box-shadow: inset 0 0 0 1px var(--agent-brand);
}

.runtime-settings__keyword-mode {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-self: start;
}

.runtime-settings__keyword-mode :deep(.agent-ui-radio-button) {
  border-color: var(--instrument-line);
  color: var(--agent-muted);
  background: #fff;
}

.runtime-settings__keyword-mode :deep(.agent-ui-radio-button.is-active) {
  border-color: var(--agent-primary);
  color: var(--agent-primary-hover);
  background: var(--agent-primary-soft);
  box-shadow: inset 0 0 0 1px var(--agent-primary);
}

.runtime-settings__keyword-select,
.runtime-settings__text-field input {
  width: min(560px, 64%);
  min-width: 0;
}

.runtime-settings__keyword-select :deep(.agent-ui-select__wrapper) {
  height: 34px;
  min-height: 34px;
}

.runtime-settings__keyword-panel,
.runtime-settings__commute-panel,
.runtime-settings__ai-threshold-panel,
.runtime-settings__greeting-panel {
  display: grid;
  gap: 12px;
  padding: 14px 16px;
  border-top: 1px solid var(--agent-border);
  background: #f7f8f7;
}

.runtime-settings__keyword-panel .runtime-settings__keyword-rule-row,
.runtime-settings__ai-threshold-panel .runtime-settings__ai-threshold-row,
.runtime-settings__greeting-panel .runtime-settings__greeting-row {
  min-height: 0;
  align-items: center;
  padding: 0;
  border-bottom: 0;
}

.runtime-settings__keyword-rule-copy {
  display: flex;
  align-items: center;
}

.runtime-settings__text-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.runtime-settings__text-field input {
  padding: 0 10px;
}

.runtime-settings__prompt-field {
  display: grid;
  min-width: 0;
  gap: 6px;
}

.runtime-settings__prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--agent-muted);
  font-size: 12px;
}

.runtime-settings__prompt-head button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  padding: 0;
  border: 1px solid var(--instrument-line);
  border-radius: 2px;
  color: var(--agent-muted);
  background: #fff;
  cursor: pointer;
}

.runtime-settings__prompt-field textarea {
  width: 100%;
  min-height: 132px;
  padding: 9px 10px;
  border: 1px solid var(--instrument-charcoal);
  border-radius: 0;
  outline: 0;
  color: var(--agent-text);
  background: #fff;
  font: inherit;
  line-height: 1.55;
  resize: vertical;
}

.runtime-settings__prompt-field textarea:focus {
  border-color: var(--agent-brand-strong);
  box-shadow: inset 0 0 0 1px var(--agent-brand);
}

.runtime-settings__threshold-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(92px, 1fr));
  gap: 8px;
}

.runtime-settings__threshold-grid label {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.runtime-settings__threshold-grid input {
  width: 100%;
  min-width: 0;
  padding: 0 8px;
}

.runtime-settings__unit-field input::-webkit-inner-spin-button,
.runtime-settings__unit-field input::-webkit-outer-spin-button,
.runtime-settings__compound-field input::-webkit-inner-spin-button,
.runtime-settings__compound-field input::-webkit-outer-spin-button,
.runtime-settings__threshold-grid input::-webkit-inner-spin-button,
.runtime-settings__threshold-grid input::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

@media (max-width: 760px) {
  .runtime-settings__unit-field,
  .runtime-settings__compound-field {
    flex: 0 0 170px;
  }

  .runtime-settings__text-field {
    align-items: stretch;
    flex-direction: column;
    gap: 5px;
  }

  .runtime-settings__keyword-panel .runtime-settings__keyword-rule-row,
  .runtime-settings__ai-threshold-panel .runtime-settings__ai-threshold-row,
  .runtime-settings__greeting-panel .runtime-settings__greeting-row {
    align-items: stretch;
    flex-direction: column;
  }

  .runtime-settings__ai-threshold-panel .runtime-settings__unit-field {
    width: 100%;
    flex-basis: auto;
  }

  .runtime-settings__keyword-select,
  .runtime-settings__text-field input {
    width: 100%;
  }

  .runtime-settings__threshold-grid {
    grid-template-columns: repeat(2, minmax(92px, 1fr));
  }
}
</style>
