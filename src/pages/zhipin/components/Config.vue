<script lang="ts" setup>
import { Layers3, RefreshCw, RotateCcw, Search, Sparkles } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

import formItem from '@/components/form/FormItem.vue'
import { useCommon } from '@/composables/useCommon'
import { formInfoData, useConf } from '@/stores/conf'
import { useUser } from '@/stores/user'
import type { FormData } from '@/types/formData'
import {
  AgentButton,
  AgentCheckbox,
  AgentForm,
  AgentFormItem,
  AgentInput,
  AgentInputNumber,
  AgentLink,
  AgentMessage,
  AgentSelect,
  AgentSwitch,
} from '@/ui/instrument'
import { jsonClone } from '@/utils/deepmerge'
import { logger } from '@/utils/logger'
import {
  bossCityOptions,
  bossDegreeOptions,
  bossExperienceOptions,
  bossJobTypeOptions,
  bossSalaryOptions,
  getBossSearchOptionLabel,
  MAX_SEARCH_DIRECTIONS,
  normalizeSearchConditions,
  type BossSearchOption,
} from '@/utils/searchConditions'

import {
  extractJobExpectations,
  getExpectationLabel,
  getInitialJobExpectation,
  rebindEnabledJobExpectations,
  type JobExpectation,
} from '../utils/jobExpectations'
import Ai from './Ai.vue'
import Appearance from './Appearance.vue'

const props = withDefaults(
  defineProps<{
    section?: 'all' | 'filter' | 'config' | 'ai' | 'settings'
    visible?: boolean
  }>(),
  {
    section: 'all',
    visible: true,
  },
)
const conf = useConf()
const user = useUser()

const { deliverLock } = useCommon()
const expectations = ref<JobExpectation[]>([])
const expectationsLoading = ref(false)
const expectationsError = ref('')
let expectationsRequestVersion = 0
const searchRuleKeys = ['searchConditions'] as const satisfies readonly (keyof FormData)[]
let filterRulesResetSnapshot: FormData['searchConditions'] | null = null
let persistedFilterRulesSnapshot: FormData['searchConditions'] | null = null
let filterRulesChangeVersion = 0

const searchRuleSummary = computed(() => {
  const conditions = conf.formData.searchConditions
  const parts = [`${conditions.directions.length} 个方向`]
  if (conditions.city) {
    parts.push(getBossSearchOptionLabel(bossCityOptions, conditions.city))
  }
  if (conditions.salary) {
    parts.push(getBossSearchOptionLabel(bossSalaryOptions, conditions.salary))
  }
  return parts.join(' · ')
})
const availableCityOptions = computed(() =>
  includeUnknownOptions(bossCityOptions, [conf.formData.searchConditions.city]),
)
const availableSalaryOptions = computed(() =>
  includeUnknownOptions(bossSalaryOptions, [conf.formData.searchConditions.salary]),
)
const availableExperienceOptions = computed(() =>
  includeUnknownOptions(bossExperienceOptions, conf.formData.searchConditions.experience),
)
const availableDegreeOptions = computed(() =>
  includeUnknownOptions(bossDegreeOptions, conf.formData.searchConditions.degree),
)
const availableJobTypeOptions = computed(() =>
  includeUnknownOptions(bossJobTypeOptions, conf.formData.searchConditions.jobType),
)
watch(
  () => [props.section, props.visible] as const,
  ([section, visible]) => {
    const showsJobRules = (section === 'filter' || section === 'all') && visible
    if (!showsJobRules) {
      filterRulesResetSnapshot = null
      persistedFilterRulesSnapshot = null
      return
    }

    filterRulesResetSnapshot = captureFilterRules()
    persistedFilterRulesSnapshot = captureFilterRules()
    void loadExpectations()
  },
  { immediate: true },
)

async function loadExpectations(forceRefresh = false) {
  const requestVersion = ++expectationsRequestVersion
  expectationsLoading.value = true
  expectationsError.value = ''
  try {
    const resume = await user.getUserResumeData(forceRefresh)
    if (requestVersion !== expectationsRequestVersion) return
    const previousJobSources = jsonClone(conf.formData.jobSources)
    expectations.value = extractJobExpectations(resume)
    if (!conf.formData.jobSources.expectationsInitialized) {
      const initialExpectation = getInitialJobExpectation(expectations.value)
      conf.formData.jobSources.enabledExpectIds = initialExpectation ? [initialExpectation.id] : []
      conf.formData.jobSources.expectationsInitialized = true
    } else {
      const configured = conf.formData.jobSources.enabledExpectIds.map(
        (id) =>
          conf.availableJobExpectations.find((item) => item.id === id) ?? {
            id,
            positionName: '',
            locationName: '',
            salaryDesc: '',
          },
      )
      const rebound = rebindEnabledJobExpectations(configured, expectations.value)
      conf.formData.jobSources.enabledExpectIds = rebound.enabledIds
      if (rebound.unmatched.length > 0) {
        logger.warn('部分已配置求职期望无法唯一匹配，已保持关闭', {
          unmatchedCount: rebound.unmatched.length,
        })
      }
    }
    conf.setAvailableJobExpectations(expectations.value)
    if (JSON.stringify(previousJobSources) !== JSON.stringify(conf.formData.jobSources)) {
      await conf.confPersist()
    }
  } catch (error) {
    if (requestVersion !== expectationsRequestVersion) return
    expectations.value = []
    expectationsError.value = error instanceof Error ? error.message : String(error)
    logger.error('读取求职期望失败', error)
  } finally {
    if (requestVersion === expectationsRequestVersion) expectationsLoading.value = false
  }
}

function isExpectationEnabled(expectId: string) {
  return conf.formData.jobSources.enabledExpectIds.includes(expectId)
}

async function setSearchEnabled(value: string | number | boolean) {
  const enabled = Boolean(value)
  if (enabled && conf.formData.searchConditions.directions.length === 0) {
    AgentMessage.warning('请先添加至少一个岗位方向')
    return
  }
  if (
    !enabled &&
    !conf.formData.jobSources.recommendEnabled &&
    conf.formData.jobSources.enabledExpectIds.length === 0
  ) {
    AgentMessage.warning('至少开启一个岗位来源')
    return
  }
  const previous = conf.formData.jobSources.searchEnabled
  conf.formData.jobSources.searchEnabled = enabled
  if (!(await conf.confPersist())) {
    conf.formData.jobSources.searchEnabled = previous
    return
  }
}

async function setRecommendEnabled(value: string | number | boolean) {
  const enabled = Boolean(value)
  if (
    !enabled &&
    !conf.formData.jobSources.searchEnabled &&
    conf.formData.jobSources.enabledExpectIds.length === 0
  ) {
    AgentMessage.warning('至少开启一个岗位来源')
    return
  }
  const previous = conf.formData.jobSources.recommendEnabled
  conf.formData.jobSources.recommendEnabled = enabled
  if (!(await conf.confPersist())) {
    conf.formData.jobSources.recommendEnabled = previous
  }
}

async function setExpectationEnabled(
  expectation: JobExpectation,
  value: string | number | boolean,
) {
  const enabled = Boolean(value)
  const previousIds = [...conf.formData.jobSources.enabledExpectIds]
  const previousInitialized = conf.formData.jobSources.expectationsInitialized
  const current = new Set(conf.formData.jobSources.enabledExpectIds)
  if (enabled) current.add(expectation.id)
  else current.delete(expectation.id)
  if (
    !conf.formData.jobSources.searchEnabled &&
    !conf.formData.jobSources.recommendEnabled &&
    current.size === 0
  ) {
    AgentMessage.warning('至少开启一个岗位来源')
    return
  }
  conf.formData.jobSources.enabledExpectIds = [...current]
  conf.formData.jobSources.expectationsInitialized = true
  if (!(await conf.confPersist())) {
    conf.formData.jobSources.enabledExpectIds = previousIds
    conf.formData.jobSources.expectationsInitialized = previousInitialized
  }
}

function captureFilterRules() {
  return jsonClone(conf.formData.searchConditions)
}

function restoreFilterRules(snapshot: FormData['searchConditions']) {
  Object.assign(conf.formData.searchConditions, jsonClone(snapshot))
}

async function resetFilterRules() {
  if (filterRulesResetSnapshot == null) return
  restoreFilterRules(filterRulesResetSnapshot)
  await persistFilterRules()
}

async function persistFilterRules() {
  const changeVersion = ++filterRulesChangeVersion
  const previous = persistedFilterRulesSnapshot ?? captureFilterRules()
  if (conf.formData.searchConditions.directions.length > MAX_SEARCH_DIRECTIONS) {
    restoreFilterRules(previous)
    AgentMessage.warning(`搜索词最多支持 ${MAX_SEARCH_DIRECTIONS} 个`)
    return false
  }
  const normalized = normalizeSearchConditions(conf.formData.searchConditions)
  if (normalized.directions.length === 0 && conf.formData.jobSources.searchEnabled) {
    restoreFilterRules(previous)
    AgentMessage.warning('请至少保留一个岗位方向')
    return false
  }
  Object.assign(conf.formData.searchConditions, normalized)
  const candidate = captureFilterRules()
  const saved = await conf.confPersist()
  if (saved) {
    persistedFilterRulesSnapshot = candidate
    return true
  }
  if (changeVersion !== filterRulesChangeVersion) return false
  restoreFilterRules(persistedFilterRulesSnapshot ?? previous)
  return false
}

function includeUnknownOptions(options: BossSearchOption[], values: string[]) {
  const result = [...options]
  const known = new Set(options.map((item) => item.value))
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    if (!known.has(value)) result.push({ value, label: value })
  }
  return result
}
</script>

<template>
  <div :class="['config-panel', { 'config-panel--filter': props.section === 'filter' }]">
    <AgentForm
      class="config-form"
      inline
      label-position="left"
      label-width="auto"
      :model="conf.formData"
      :disabled="deliverLock"
    >
      <template v-if="props.section === 'filter' || props.section === 'all'">
        <div class="config-panel__toolbar instrument-view-toolbar">
          <strong>岗位规则</strong>
          <div class="config-panel__toolbar-actions">
            <AgentButton
              plain
              :disabled="expectationsLoading || deliverLock"
              @click="loadExpectations(true)"
            >
              <RefreshCw :size="15" :class="{ 'is-spinning': expectationsLoading }" />
              刷新求职期望
            </AgentButton>
          </div>
        </div>

        <section class="filter-section instrument-frame" data-test="job-source-rules">
          <section class="instrument-setting-section">
            <div class="instrument-setting-title">搜索</div>
            <div class="search-source-content">
              <div class="instrument-setting-row job-source-row" data-source="search">
                <span class="job-source-row__icon" aria-hidden="true">
                  <Search :size="16" />
                </span>
                <div class="instrument-setting-copy">
                  <strong>搜索</strong>
                  <span>{{ searchRuleSummary }}</span>
                </div>
                <div class="job-source-row__actions">
                  <AgentButton
                    data-test="reset-search-rules"
                    plain
                    size="small"
                    :disabled="deliverLock || expectationsLoading"
                    @click="resetFilterRules"
                  >
                    <RotateCcw :size="14" aria-hidden="true" />
                    重置
                  </AgentButton>
                  <AgentSwitch
                    :model-value="conf.formData.jobSources.searchEnabled"
                    aria-label="开启搜索来源"
                    :disabled="deliverLock || expectationsLoading"
                    @change="setSearchEnabled"
                  />
                </div>
              </div>

              <div
                v-if="conf.formData.jobSources.searchEnabled"
                class="search-rules-module"
                data-test="search-rules-module"
              >
                <section class="instrument-setting-section">
                  <div class="search-rules-fields">
                    <div class="instrument-setting-row">
                      <div class="instrument-setting-copy">
                        <strong>搜索词</strong>
                        <span>每个方向分别获取岗位，统一写入搜索投递池</span>
                      </div>
                      <AgentSelect
                        v-model="conf.formData.searchConditions.directions"
                        class="search-condition-control search-direction-control"
                        data-test="search-directions"
                        multiple
                        filterable
                        allow-create
                        collapse-tags
                        :max-collapse-tags="2"
                        placeholder="输入岗位方向后回车"
                        @change="persistFilterRules"
                      />
                    </div>
                  </div>
                </section>

                <section class="instrument-setting-section">
                  <div class="search-rules-fields">
                    <div class="instrument-setting-row">
                      <div class="instrument-setting-copy">
                        <strong>城市</strong>
                        <span>不选择时由 BOSS 使用当前城市</span>
                      </div>
                      <AgentSelect
                        v-model="conf.formData.searchConditions.city"
                        class="search-condition-control"
                        data-test="search-city"
                        :options="availableCityOptions"
                        clearable
                        filterable
                        placeholder="不限"
                        @change="persistFilterRules"
                      />
                    </div>

                    <div class="instrument-setting-row">
                      <div class="instrument-setting-copy">
                        <strong>薪资待遇</strong>
                        <span>按 BOSS 搜索档位获取岗位</span>
                      </div>
                      <AgentSelect
                        v-model="conf.formData.searchConditions.salary"
                        class="search-condition-control"
                        data-test="search-salary"
                        :options="availableSalaryOptions"
                        clearable
                        placeholder="不限"
                        @change="persistFilterRules"
                      />
                    </div>

                    <div class="instrument-setting-row">
                      <div class="instrument-setting-copy">
                        <strong>工作经验</strong>
                        <span>可多选</span>
                      </div>
                      <AgentSelect
                        v-model="conf.formData.searchConditions.experience"
                        class="search-condition-control"
                        data-test="search-experience"
                        :options="availableExperienceOptions"
                        multiple
                        clearable
                        placeholder="不限"
                        @change="persistFilterRules"
                      />
                    </div>

                    <div class="instrument-setting-row">
                      <div class="instrument-setting-copy">
                        <strong>学历要求</strong>
                        <span>可多选</span>
                      </div>
                      <AgentSelect
                        v-model="conf.formData.searchConditions.degree"
                        class="search-condition-control"
                        data-test="search-degree"
                        :options="availableDegreeOptions"
                        multiple
                        clearable
                        placeholder="不限"
                        @change="persistFilterRules"
                      />
                    </div>

                    <div class="instrument-setting-row">
                      <div class="instrument-setting-copy">
                        <strong>求职类型</strong>
                        <span>全职、兼职或实习，可多选</span>
                      </div>
                      <AgentSelect
                        v-model="conf.formData.searchConditions.jobType"
                        class="search-condition-control"
                        data-test="search-job-type"
                        :options="availableJobTypeOptions"
                        multiple
                        clearable
                        placeholder="不限"
                        @change="persistFilterRules"
                      />
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </section>

          <section class="instrument-setting-section">
            <div class="instrument-setting-title">求职期望</div>
            <div class="job-expectation-list">
              <label class="instrument-setting-row job-source-row" data-source="recommend">
                <span class="job-source-row__icon" aria-hidden="true">
                  <Sparkles :size="16" />
                </span>
                <span class="instrument-setting-copy">
                  <strong>推荐</strong>
                  <span>按 BOSS 推荐列表获取岗位</span>
                </span>
                <AgentSwitch
                  :model-value="conf.formData.jobSources.recommendEnabled"
                  aria-label="开启推荐来源"
                  :disabled="deliverLock"
                  @change="setRecommendEnabled"
                />
              </label>
              <div v-if="expectationsLoading" class="instrument-setting-row job-source-state">
                正在读取求职期望…
              </div>
              <div
                v-else-if="expectationsError"
                class="instrument-setting-row job-source-state is-error"
              >
                <span>求职期望读取失败</span>
                <button class="job-source-retry" type="button" @click="loadExpectations(true)">
                  重试
                </button>
              </div>
              <div
                v-else-if="expectations.length === 0"
                class="instrument-setting-row job-source-state"
              >
                当前账号没有可用的求职期望
              </div>
              <template v-else>
                <label
                  v-for="expectation in expectations"
                  :key="expectation.id"
                  class="instrument-setting-row job-source-row"
                  :data-expect-id="expectation.id"
                >
                  <span class="job-source-row__icon" aria-hidden="true">
                    <Layers3 :size="16" />
                  </span>
                  <span class="instrument-setting-copy">
                    <strong>{{ getExpectationLabel(expectation) }}</strong>
                    <span>{{ expectation.salaryDesc || 'BOSS 求职期望' }}</span>
                  </span>
                  <AgentSwitch
                    :model-value="isExpectationEnabled(expectation.id)"
                    :aria-label="`开启求职期望 ${getExpectationLabel(expectation)}`"
                    @change="setExpectationEnabled(expectation, $event)"
                  />
                </label>
              </template>
            </div>
          </section>
        </section>
      </template>

      <template
        v-if="props.section === 'ai' || props.section === 'config' || props.section === 'all'"
      >
        <section class="config-section">
          <div class="config-section__header">
            <div>
              <h3>招呼语</h3>
            </div>
            <AgentLink
              href="https://www.zhipin.com/web/geek/notify-set?type=greetSet"
              target="_blank"
              type="primary"
            >
              BOSS 招呼语设置
            </AgentLink>
          </div>
          <div class="config-row config-row--greeting">
            <form-item
              v-bind="formInfoData.customGreeting"
              v-model:enable="conf.formData.customGreeting.enable"
            >
              <AgentInput
                v-model.lazy="conf.formData.customGreeting.value"
                type="textarea"
                :rows="4"
              />
            </form-item>
          </div>
        </section>

        <section class="config-section">
          <div class="config-section__header">
            <div>
              <h3>AI 能力</h3>
            </div>
          </div>
          <Ai />
        </section>
      </template>

      <template
        v-if="props.section === 'settings' || props.section === 'config' || props.section === 'all'"
      >
        <section class="config-section">
          <div class="config-section__header">
            <div>
              <h3>外观</h3>
            </div>
          </div>
          <Appearance />
        </section>

        <section class="config-section">
          <div class="config-section__header">
            <div>
              <h3>高级</h3>
            </div>
          </div>
          <AgentCheckbox
            v-bind="formInfoData.useCache"
            v-model="conf.formData.useCache.value"
            border
          />
          <div class="delay-grid">
            <AgentFormItem v-bind="formInfoData.delay.deliveryInterval">
              <AgentInputNumber
                v-model.lazy="conf.formData.delay.deliveryInterval"
                :min="0"
                :max="600"
                :step="5"
              />
            </AgentFormItem>
            <AgentFormItem v-bind="formInfoData.delay.deliveryIntervalMax">
              <AgentInputNumber
                v-model.lazy="conf.formData.delay.deliveryIntervalMax"
                :min="conf.formData.delay.deliveryInterval"
                :max="900"
                :step="5"
              />
            </AgentFormItem>
            <AgentFormItem v-bind="formInfoData.delay.batchSize">
              <AgentInputNumber
                v-model.lazy="conf.formData.delay.batchSize"
                :min="0"
                :max="200"
                :step="5"
              />
            </AgentFormItem>
            <AgentFormItem v-bind="formInfoData.delay.batchRestMinutes">
              <AgentInputNumber
                v-model.lazy="conf.formData.delay.batchRestMinutes"
                :min="0"
                :max="60"
                :step="1"
              />
            </AgentFormItem>
          </div>
        </section>
      </template>
    </AgentForm>

    <div
      v-if="props.section === 'settings' || props.section === 'config' || props.section === 'all'"
      class="config-save-actions"
    >
      <AgentButton type="success" @click="conf.confSaving"> 保存配置 </AgentButton>
      <AgentButton type="warning" @click="conf.confReload"> 重载配置 </AgentButton>
      <AgentButton type="danger" @click="conf.confDelete"> 清空配置 </AgentButton>
    </div>
  </div>
</template>

<style src="./Config.css" scoped></style>
