<script lang="ts" setup>
import { X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

import { useStatistics } from '@/composables/useStatistics'
import { buildDeliveryQueueConfigScope } from '@/delivery/configSnapshot'
import { useConf } from '@/stores/conf'
import { jobList } from '@/stores/jobs'
import { useLog } from '@/stores/log'
import { useUser } from '@/stores/user'
import { AgentMessage } from '@/ui/instrument'
import { parseAgentMessageBridgePayload, syncAgentMessageContainerHost } from '@/ui/message'
import {
  getConfigInitializationDiagnostic,
  initializeConfigWithRuntimeRetry,
  probeRuntimeWithRetry,
} from '@/utils/configInitialization'
import { getCurrentAppVersion } from '@/utils/extensionRuntimeHealth'
import {
  ExtensionRuntimeHealthError,
  getExtensionRuntimeHealthDiagnostic,
} from '@/utils/extensionRuntimeHealth'
import { logger } from '@/utils/logger'
import { JOB_UI_VISIBILITY_EVENT } from '@/utils/zhipinRoute'

import { usePager } from '../hooks/usePager'
import Config from './Config.vue'
import DeliveryRecords from './DeliveryRecords.vue'
import Logs from './Logs.vue'
import OperationPanel from './OperationPanel.vue'
import RuntimeSettingsDrawer from './RuntimeSettingsDrawer.vue'

const props = defineProps<{
  logoUrl: string
  personalUrl: string
}>()

// 侧栏这个编号原来写死成 071，和真实版本号对不上。真机上分不清装的是哪一版时，
// 第一眼看的就是它——写死的编号比没有更糟，它看起来像个可信的版本。
const railVersion = getCurrentAppVersion()

const user = useUser()
const logStore = useLog()
const statistics = useStatistics()
const { initPager } = usePager()
const conf = useConf()

const launcherRef = ref<HTMLButtonElement>()
const workspaceRef = ref<HTMLElement>()
const personalFrameRef = ref<HTMLIFrameElement>()
type WorkspaceSection = 'dashboard' | 'records' | 'filters' | 'settings' | 'personal' | 'logs'

const panelOpen = ref(false)
const activeSection = ref<WorkspaceSection>('dashboard')
const mountedSections = ref<Set<WorkspaceSection>>(new Set(['dashboard']))
const jobRuntimeReady = ref(false)
let sectionSelectionVersion = 0
let previouslyFocusedElement: HTMLElement | null = null
const navigation = [
  { id: 'dashboard', index: '01', label: '投递控制', eyebrow: 'DAILY DELIVERY / 150' },
  { id: 'records', index: '02', label: '投递记录', eyebrow: 'DELIVERY RECORDS' },
  { id: 'filters', index: '03', label: '岗位规则', eyebrow: 'JOB SOURCES / RULES' },
  { id: 'settings', index: '04', label: '运行配置', eyebrow: 'RUNTIME SETTINGS' },
  { id: 'personal', index: '05', label: '个人信息', eyebrow: 'PROFILE / AI / CONFIG' },
  { id: 'logs', index: '06', label: '运行日志', eyebrow: 'RUNTIME LOGS' },
] as const
const activeNavigationIndex = computed(() =>
  navigation.findIndex((item) => item.id === activeSection.value),
)
const panelTitle = computed(() => {
  return navigation.find((item) => item.id === activeSection.value)?.label ?? '投递控制'
})
const panelEyebrow = computed(() => {
  return navigation.find((item) => item.id === activeSection.value)?.eyebrow ?? 'CONTROL UNIT'
})
const systemReady = computed(
  () => conf.readiness?.aiFilteringReady !== false && conf.readiness?.aiGreetingReady !== false,
)
const systemStateLabel = computed(() => (systemReady.value ? '系统正常' : '需要配置'))
const personalFrameUrl = computed(() => {
  if (!props.personalUrl) return ''
  const uid = user.getUserId()
  if (uid == null) return props.personalUrl
  try {
    const url = new URL(props.personalUrl)
    url.searchParams.set('uid', String(uid))
    return url.toString()
  } catch {
    return props.personalUrl
  }
})
const personalFrameOrigin = computed(() => {
  try {
    const url = new URL(personalFrameUrl.value)
    return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin
  } catch {
    return ''
  }
})

onMounted(() => {
  syncAgentMessageContainerHost()
  window.addEventListener(JOB_UI_VISIBILITY_EVENT, handleJobUiVisibility)
  window.addEventListener('keydown', handleWorkspaceKeydown)
  window.addEventListener('message', handlePersonalFrameMessage)
})

onUnmounted(() => {
  window.removeEventListener(JOB_UI_VISIBILITY_EVENT, handleJobUiVisibility)
  window.removeEventListener('keydown', handleWorkspaceKeydown)
  window.removeEventListener('message', handlePersonalFrameMessage)
})

/**
 * 把错误压成一行可复制的文本。
 *
 * 原来是 logger.error('...', { error: e })：控制台里是个可展开对象，复制出来只有
 * [object Object]，用户能贴给我的那份诊断等于空的。出了事看不见是什么事，比没日志更糟。
 */
function describeInitFailure(error: unknown) {
  if (error instanceof ExtensionRuntimeHealthError) {
    return `[${error.code}] ${error.message}`
  }
  if (error instanceof Error) {
    return `[${error.name}] ${error.message}`
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

onMounted(async () => {
  // 通信桥要在最前面确认。后面每一步都靠它，桥断了或版本不一致时，最先炸的是账号数据，
  // 而那条错误只会说「账号数据加载失败」——真正的原因（该重开页面还是重载扩展）被盖住了。
  try {
    await probeRuntimeWithRetry({
      onRetry(diagnostic, nextAttempt, maxAttempts) {
        logger.warn(
          `插件后台尚未就绪，将进行第 ${nextAttempt}/${maxAttempts} 次探测 [${diagnostic.code}] ${diagnostic.message}`,
        )
      },
    })
  } catch (e) {
    const diagnostic = getExtensionRuntimeHealthDiagnostic(e)
    logger.error(`插件运行时不可用 [${diagnostic.code}] ${diagnostic.error}`)
    AgentMessage.error(
      e instanceof ExtensionRuntimeHealthError
        ? e.message
        : '插件运行时不可用，请重新打开 BOSS 页面后重试',
    )
    return
  }
  let currentUser
  try {
    currentUser = await user.initUser({ pollIntervalMs: 200, timeoutMs: 2_000 })
  } catch (e) {
    logger.error(`初始化用户信息失败：${describeInitFailure(e)}`)
  }
  const accountUid = currentUser?.userId ?? user.getUserId()
  if (accountUid == null) {
    logger.error('初始化账号数据失败：账号信息尚未就绪')
    AgentMessage.error('账号信息未就绪，请刷新后重试')
    return
  }
  try {
    await Promise.all([
      statistics.setAccountScope(accountUid),
      logStore.setAccountScope(accountUid),
      jobList.setAccountScope(accountUid),
    ])
  } catch (e) {
    logger.error(`初始化账号数据失败：${describeInitFailure(e)}`)
    AgentMessage.error('账号数据加载失败，请刷新后重试')
    return
  }
  try {
    await initializeConfigWithRuntimeRetry(() => conf.confInit(), {
      onRetry(diagnostic, nextAttempt, maxAttempts) {
        logger.warn(
          `配置初始化通信暂不可用，将进行第 ${nextAttempt}/${maxAttempts} 次尝试 [${diagnostic.code}] ${diagnostic.message}`,
        )
      },
    })
  } catch (e) {
    const diagnostic = getConfigInitializationDiagnostic(e)
    logger.error(`初始化配置失败 [${diagnostic.code}] ${diagnostic.message}`)
    AgentMessage.error(diagnostic.userMessage)
    return
  }
  try {
    jobList.setConfigScope?.(buildDeliveryQueueConfigScope(conf.formData))
    await jobList.initJobList(conf.formData)
  } catch (e) {
    logger.error(`初始化职位列表失败：${describeInitFailure(e)}`)
    AgentMessage.error('岗位列表初始化失败，请刷新后重试')
    return
  }

  try {
    await initPager()
    jobRuntimeReady.value = true
  } catch (e) {
    logger.error(`初始化分页器失败：${describeInitFailure(e)}`)
    AgentMessage.error('岗位分页初始化失败，请刷新后重试')
  }
})

async function openWorkspace() {
  previouslyFocusedElement = document.activeElement as HTMLElement | null
  panelOpen.value = true
  await nextTick()
  workspaceRef.value?.focus({ preventScroll: true })
}

function closeWorkspace() {
  hideWorkspace(true)
}

function hideWorkspace(restoreFocus: boolean) {
  sectionSelectionVersion += 1
  panelOpen.value = false
  if (!restoreFocus) return
  void nextTick(() => {
    const target = previouslyFocusedElement?.isConnected
      ? previouslyFocusedElement
      : launcherRef.value
    target?.focus({ preventScroll: true })
  })
}

async function selectSection(section: WorkspaceSection) {
  const selectionVersion = ++sectionSelectionVersion
  if (section === 'logs') {
    try {
      await Promise.all([logStore.hydrate(), logStore.hydrateRuntimeLogs()])
    } catch (e) {
      logger.error(`加载运行日志失败：${describeInitFailure(e)}`)
    }
  }
  if (selectionVersion !== sectionSelectionVersion) return
  if (!mountedSections.value.has(section)) {
    mountedSections.value = new Set([...mountedSections.value, section])
  }
  activeSection.value = section
}

function isSectionMounted(section: WorkspaceSection) {
  return mountedSections.value.has(section)
}

function handleJobUiVisibility(event: Event) {
  const detail = (event as CustomEvent<{ visible?: boolean }>).detail
  if (detail?.visible !== false) return
  hideWorkspace(false)
}

function handleWorkspaceKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !panelOpen.value) return
  event.preventDefault()
  closeWorkspace()
}

function handlePersonalFrameMessage(event: MessageEvent) {
  const frameWindow = personalFrameRef.value?.contentWindow
  if (
    frameWindow == null ||
    event.source !== frameWindow ||
    personalFrameOrigin.value === '' ||
    event.origin !== personalFrameOrigin.value
  ) {
    return
  }
  const payload = parseAgentMessageBridgePayload(event.data)
  if (payload == null) return
  AgentMessage[payload.type](payload.content, payload.duration)
}
</script>

<template>
  <button
    ref="launcherRef"
    v-show="!panelOpen"
    class="agent-delivery-launcher"
    type="button"
    title="打开 Easy Job"
    aria-label="打开 Easy Job"
    @click="openWorkspace"
  >
    <img
      class="agent-delivery-logo"
      :src="props.logoUrl"
      alt=""
      aria-hidden="true"
      draggable="false"
    />
  </button>

  <div
    v-show="panelOpen"
    class="agent-delivery-overlay"
    role="presentation"
    @mousedown.self="closeWorkspace"
  >
    <section
      ref="workspaceRef"
      class="agent-delivery-workspace"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-delivery-workspace-title"
      tabindex="-1"
    >
      <aside class="agent-delivery-workspace__rail" aria-label="当前功能位置">
        <div class="agent-delivery-workspace__rail-logo">
          <img
            class="agent-delivery-logo agent-delivery-workspace__brand-mark"
            :src="props.logoUrl"
            alt=""
            aria-hidden="true"
            draggable="false"
          />
        </div>
        <div class="agent-delivery-workspace__rail-scale" aria-hidden="true">
          <i
            v-for="(item, index) in navigation"
            :key="item.id"
            :class="{
              'is-current': activeSection === item.id,
              'is-complete': index < activeNavigationIndex,
            }"
          />
        </div>
        <div class="agent-delivery-workspace__rail-code">AGENT / {{ railVersion }}</div>
      </aside>

      <aside class="agent-delivery-workspace__menu">
        <div class="agent-delivery-workspace__menu-head">
          <strong>Easy Job</strong>
          <span>CONTROL UNIT</span>
        </div>

        <nav class="agent-delivery-workspace__nav" aria-label="插件功能菜单">
          <button
            v-for="item in navigation"
            :key="item.id"
            type="button"
            :class="[
              'agent-delivery-workspace__nav-item',
              { 'is-active': activeSection === item.id },
            ]"
            :title="item.label"
            :aria-label="item.label"
            :aria-current="activeSection === item.id ? 'page' : undefined"
            @click="selectSection(item.id)"
          >
            <span class="agent-delivery-workspace__nav-number">{{ item.index }}</span>
            <span>{{ item.label }}</span>
          </button>
        </nav>
        <div
          :class="[
            'agent-delivery-workspace__config-state',
            'agent-delivery-workspace__menu-status',
            { 'is-warning': !systemReady },
          ]"
          role="status"
          aria-live="polite"
          :aria-label="systemStateLabel"
          :title="systemStateLabel"
        >
          <i aria-hidden="true" />
          <span>{{ systemStateLabel }}</span>
        </div>
      </aside>

      <div class="agent-delivery-workspace__main">
        <header class="agent-delivery-workspace__header">
          <div class="agent-delivery-workspace__title-block">
            <span>{{ panelEyebrow }}</span>
            <h2 id="agent-delivery-workspace-title">{{ panelTitle }}</h2>
          </div>
          <div class="agent-delivery-workspace__header-actions">
            <button
              class="agent-delivery-workspace__close"
              type="button"
              title="关闭面板"
              aria-label="关闭面板"
              @click="closeWorkspace"
            >
              <X :size="22" />
            </button>
          </div>
        </header>

        <div class="agent-delivery-workspace__message-host" data-agent-message-host />

        <main class="agent-delivery-workspace__content">
          <section
            v-show="activeSection === 'dashboard'"
            class="agent-delivery-view agent-delivery-view--dashboard"
            data-view="dashboard"
          >
            <OperationPanel
              :runtime-ready="jobRuntimeReady"
              @open-settings="selectSection('settings')"
              @show-search="selectSection('filters')"
              @show-group="selectSection('filters')"
              @show-logs="selectSection('logs')"
            />
          </section>
          <section
            v-show="activeSection === 'records'"
            class="agent-delivery-view agent-delivery-view--records"
            data-view="records"
          >
            <DeliveryRecords
              v-if="isSectionMounted('records')"
              :visible="panelOpen && activeSection === 'records'"
            />
          </section>
          <section
            v-show="activeSection === 'filters'"
            class="agent-delivery-view agent-delivery-view--filters"
            data-view="filters"
          >
            <Config
              v-if="isSectionMounted('filters')"
              :visible="panelOpen && activeSection === 'filters'"
              section="filter"
            />
          </section>
          <section
            v-show="activeSection === 'settings'"
            class="agent-delivery-view agent-delivery-view--settings"
            data-view="settings"
          >
            <RuntimeSettingsDrawer v-if="isSectionMounted('settings')" />
          </section>
          <section
            v-show="activeSection === 'personal'"
            class="agent-delivery-view agent-delivery-view--personal"
            data-view="personal"
          >
            <iframe
              v-if="isSectionMounted('personal') && personalFrameUrl"
              ref="personalFrameRef"
              class="agent-delivery-personal-frame"
              :src="personalFrameUrl"
              title="个人信息与 AI 配置"
              referrerpolicy="no-referrer"
            />
          </section>
          <section
            v-show="activeSection === 'logs'"
            class="agent-delivery-view agent-delivery-view--logs"
            data-view="logs"
          >
            <Logs v-if="isSectionMounted('logs')" />
          </section>
        </main>
      </div>
    </section>
  </div>
</template>

<style src="./Ui.css"></style>
