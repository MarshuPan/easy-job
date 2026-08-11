<script lang="ts" setup>
import { Download, Eye, EyeOff, FileUp, LoaderCircle, Save, Wifi } from 'lucide-vue-next'
import { computed, onMounted, ref, watch } from 'vue'

import { createBlankAiModel } from '@/config/aiConfiguration'
import {
  ConfigClientError,
  getConfigBundle,
  importConfigJson,
  saveAiConfiguration,
  saveProfileAndExtract,
  testAiModel,
} from '@/config/client'
import { CONFIG_LIMITS } from '@/config/defaults'
import {
  requestModelOriginPermission,
  requestModelOriginPermissions,
} from '@/config/modelPermission'
import type { AiModelConfig, ConfigBundleV1 } from '@/config/types'
import { isResumeEvidenceStale } from '@/profile/resumeExtraction'
import { AgentMessage } from '@/ui/instrument'

const uid = new URLSearchParams(location.search).get('uid')?.trim() ?? ''
const bundle = ref<ConfigBundleV1 | null>(null)
const loading = ref(true)
const busy = ref('')
const importInput = ref<HTMLInputElement>()
const keyVisible = ref(false)
const modelTest = ref<{ tone: 'success' | 'error'; text: string } | null>(null)
const loadedResumeMarkdown = ref('')
const resumeFeedback = ref<{ tone: 'success' | 'error'; text: string } | null>(null)

const primaryModel = computed(() => bundle.value?.models[0] ?? null)
const resumeStatus = computed(() => {
  if (busy.value === 'save-resume') return { tone: 'loading' as const, text: '解析中' }
  if (resumeFeedback.value) return resumeFeedback.value
  const resume = bundle.value?.profile.resume
  if (!resume?.markdown) return { tone: 'idle' as const, text: '未填写' }
  if (resume.markdown !== loadedResumeMarkdown.value || isResumeEvidenceStale(resume)) {
    return { tone: 'idle' as const, text: '待解析' }
  }
  return {
    tone: 'success' as const,
    text: '解析成功',
  }
})
onMounted(load)

async function load() {
  if (!uid) {
    loading.value = false
    AgentMessage.error('未识别当前 BOSS 账号，请重新打开个人信息')
    return
  }
  loading.value = true
  try {
    const value = await getConfigBundle(uid)
    if (value.models.length === 0) value.models = [createBlankAiModel()]
    loadedResumeMarkdown.value = value.profile.resume.markdown
    bundle.value = value
  } catch {
    AgentMessage.error('配置读取失败，请重新打开个人信息')
  } finally {
    loading.value = false
  }
}

watch(
  () => bundle.value?.profile.resume.markdown ?? '',
  (markdown) => {
    if (!loading.value && markdown !== loadedResumeMarkdown.value) {
      resumeFeedback.value = null
    }
  },
)

watch(
  () => {
    const model = primaryModel.value
    return model
      ? [model.protocol, model.url, model.apiKey, model.model, model.reasoningEffort]
      : null
  },
  () => {
    modelTest.value = null
  },
)

function prepareModel(model: AiModelConfig) {
  model.name = model.model.trim() || 'AI 模型'
  if (model.protocol !== 'openai-responses') model.responsesBackground = 'off'
  return model
}

async function saveModel() {
  if (!bundle.value || !primaryModel.value) return
  busy.value = 'save-model'
  try {
    const model = prepareModel(primaryModel.value)
    let permissionGranted = true
    try {
      permissionGranted = await requestModelOriginPermissions([model.url])
    } catch {
      // The canonical validator reports malformed URLs with their exact field path.
    }
    await saveAiConfiguration([model])
    if (permissionGranted) AgentMessage.success('模型已保存')
    else AgentMessage.warning('模型已保存，但地址权限未开启')
    await load()
  } catch {
    AgentMessage.error('模型保存失败，请检查配置')
  } finally {
    busy.value = ''
  }
}

async function testModel() {
  if (!primaryModel.value) return
  const model = prepareModel(primaryModel.value)
  busy.value = 'test-model'
  modelTest.value = null
  try {
    const granted = await requestModelOriginPermission(model.url)
    if (!granted) {
      modelTest.value = { tone: 'error', text: '连接失败' }
      return
    }
    await testAiModel(uid, model)
    modelTest.value = { tone: 'success', text: '连接成功' }
  } catch {
    modelTest.value = { tone: 'error', text: '连接失败' }
  } finally {
    busy.value = ''
  }
}

function getResumeParsingErrorMessage(error: unknown) {
  if (!(error instanceof ConfigClientError)) {
    return '简历已保存，但解析失败，请重试'
  }
  if (error.code === 'MODEL_AUTH_FAILED') return '简历已保存，但解析失败：请检查 API Key'
  if (error.code === 'MODEL_RATE_LIMITED') return '简历已保存，但解析失败：模型服务繁忙'
  if (error.code === 'MODEL_TIMEOUT') return '简历已保存，但解析失败：模型请求超时'
  if (error.code === 'CONFIG_REQUEST_TIMEOUT') {
    return '简历已保存，但解析等待超时，请查看运行日志'
  }
  if (error.code === 'CONFIG_BACKGROUND_DISCONNECTED') {
    return '简历已保存，但插件后台连接中断，请查看运行日志后重试'
  }
  if (error.code === 'MODEL_NETWORK_OR_PERMISSION') {
    return '简历已保存，但解析失败：模型网络连接异常'
  }
  if (error.code === 'MODEL_TASK_FAILED') {
    return `简历已保存，但解析失败：${error.message}`
  }
  if (error.code === 'MODEL_RESPONSE_INVALID') {
    return '简历已保存，但解析失败：模型返回格式无效'
  }
  if (error.code === 'MODEL_HTTP_FAILED') {
    return `简历已保存，但解析失败：${error.message}`
  }
  if (error.code === 'CONFIG_VALIDATION_FAILED') {
    return '简历已保存，但解析结果不符合事实校验要求'
  }
  return '简历已保存，但解析失败，请重试'
}

async function saveResume() {
  if (!bundle.value) return
  const markdown = bundle.value.profile.resume.markdown
  if (markdown.trim().length === 0) {
    AgentMessage.warning('请填写简历内容')
    return
  }
  if (bundle.value.profile.displayName.length > CONFIG_LIMITS.displayNameCharacters) {
    AgentMessage.warning(`姓名最多输入 ${CONFIG_LIMITS.displayNameCharacters} 个字`)
    return
  }
  if (markdown.length > CONFIG_LIMITS.resumeCharacters) {
    AgentMessage.warning(`简历最多输入 ${CONFIG_LIMITS.resumeCharacters} 个字`)
    return
  }
  busy.value = 'save-resume'
  resumeFeedback.value = null
  try {
    const model = primaryModel.value
    if (!model) {
      throw new ConfigClientError('尚未配置模型', 'MODEL_NOT_CONFIGURED')
    }
    const granted = await requestModelOriginPermission(model.url)
    if (!granted) {
      throw new ConfigClientError('模型地址权限未开启', 'MODEL_NETWORK_OR_PERMISSION')
    }
    await saveProfileAndExtract(uid, bundle.value.profile.displayName, markdown, model)
    resumeFeedback.value = {
      tone: 'success',
      text: '解析成功',
    }
    AgentMessage.success('简历保存并解析成功')
    await load()
  } catch (error) {
    resumeFeedback.value = { tone: 'error', text: '解析失败' }
    AgentMessage.error(getResumeParsingErrorMessage(error))
    await load()
  } finally {
    busy.value = ''
  }
}

async function exportBundle() {
  if (!confirm('导出文件包含明文 API Key、个人简历和地址配置。确认继续导出？')) return
  busy.value = 'export'
  try {
    const current = await getConfigBundle(uid)
    const text = `${JSON.stringify(current, null, 2)}\n`
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '-').slice(0, 15)
    link.href = url
    link.download = `agent-delivery-config-${timestamp}.json`
    link.click()
    URL.revokeObjectURL(url)
    AgentMessage.success('导出成功')
  } catch {
    AgentMessage.error('导出失败，请稍后重试')
  } finally {
    busy.value = ''
  }
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > CONFIG_LIMITS.importFileBytes) {
    AgentMessage.warning('配置文件不能超过 2 MB')
    return
  }
  if (!confirm('导入会完整覆盖个人配置和当前 BOSS 账号的运行配置。确认继续？')) return
  busy.value = 'import'
  try {
    await importConfigJson(uid, await file.text(), file.size)
    resumeFeedback.value = null
    await load()
    let permissionGranted = true
    try {
      permissionGranted = await requestModelOriginPermissions(
        bundle.value?.models.map((model) => model.url) ?? [],
      )
    } catch {
      permissionGranted = false
    }
    if (permissionGranted) AgentMessage.success('导入成功')
    else AgentMessage.warning('导入成功，但模型地址权限未开启')
  } catch (error) {
    AgentMessage.error(getImportErrorMessage(error))
  } finally {
    busy.value = ''
  }
}

function getImportErrorMessage(error: unknown) {
  const issues =
    typeof error === 'object' && error != null && 'issues' in error
      ? (error as { issues?: Array<{ path?: string }> }).issues
      : undefined
  if (issues?.some((issue) => issue.path?.includes('displayName'))) {
    return `姓名最多输入 ${CONFIG_LIMITS.displayNameCharacters} 个字`
  }
  if (issues?.some((issue) => issue.path?.includes('resume.markdown'))) {
    return `简历最多输入 ${CONFIG_LIMITS.resumeCharacters} 个字`
  }
  return '导入失败，请检查配置文件'
}
</script>

<template>
  <main class="profile-page">
    <div v-if="loading" class="profile-loading">
      <LoaderCircle :size="18" class="is-spinning" />
      正在读取配置
    </div>

    <template v-else-if="bundle && primaryModel">
      <div class="profile-toolbar instrument-view-toolbar">
        <strong>个人信息</strong>
      </div>

      <div class="profile-frame instrument-frame">
        <section class="instrument-setting-section" aria-labelledby="resume-title">
          <div id="resume-title" class="instrument-setting-title">个人简历</div>
          <div class="instrument-setting-body">
            <label class="instrument-setting-row">
              <span class="instrument-setting-copy">
                <strong>姓名或对外称呼</strong>
                <span>用于 AI 判断与生成内容时识别候选人</span>
              </span>
              <input
                v-model.trim="bundle.profile.displayName"
                class="profile-control"
                type="text"
                :maxlength="CONFIG_LIMITS.displayNameCharacters"
              />
            </label>

            <label class="instrument-setting-row profile-editor-row">
              <span class="instrument-setting-copy">
                <strong>简历内容</strong>
                <span>Markdown 纯文本，供 AI 匹配与招呼语共用</span>
              </span>
              <textarea
                v-model="bundle.profile.resume.markdown"
                class="profile-control resume-editor"
                rows="16"
                :maxlength="CONFIG_LIMITS.resumeCharacters"
              />
            </label>

            <footer class="instrument-setting-actions">
              <span
                :class="[
                  'status-line',
                  'resume-status',
                  resumeStatus.tone === 'loading'
                    ? 'is-loading'
                    : resumeStatus.tone === 'success'
                      ? 'is-success'
                      : resumeStatus.tone === 'error'
                        ? 'is-error'
                        : '',
                ]"
              >
                <LoaderCircle
                  v-if="resumeStatus.tone === 'loading'"
                  :size="14"
                  class="is-spinning"
                />
                {{ resumeStatus.text }}
              </span>
              <span class="profile-character-count">
                {{ bundle.profile.resume.markdown.length }} /
                {{ CONFIG_LIMITS.resumeCharacters }}
              </span>
              <button
                type="button"
                class="control-button is-primary"
                :disabled="busy === 'save-resume'"
                @click="saveResume"
              >
                <LoaderCircle v-if="busy === 'save-resume'" :size="15" class="is-spinning" />
                <Save v-else :size="15" />
                {{ busy === 'save-resume' ? '解析中' : '保存并解析' }}
              </button>
            </footer>
          </div>
        </section>

        <section class="instrument-setting-section" aria-labelledby="model-title">
          <div id="model-title" class="instrument-setting-title">AI 模型</div>
          <div class="instrument-setting-body">
            <label class="instrument-setting-row">
              <span class="instrument-setting-copy">
                <strong>请求协议</strong>
                <span>选择模型服务使用的请求规范</span>
              </span>
              <select
                v-model="primaryModel.protocol"
                class="profile-control"
                data-test="model-protocol"
              >
                <option value="openai-chat-completions">Chat Completions</option>
                <option value="openai-responses">Responses</option>
                <option value="anthropic-messages">Anthropic Messages</option>
              </select>
            </label>

            <label class="instrument-setting-row">
              <span class="instrument-setting-copy">
                <strong>模型 ID</strong>
                <span>填写服务端实际接受的模型名称</span>
              </span>
              <input
                v-model.trim="primaryModel.model"
                class="profile-control"
                data-test="model-id"
                type="text"
              />
            </label>

            <label class="instrument-setting-row">
              <span class="instrument-setting-copy">
                <strong>请求 URL</strong>
                <span>可填写基础地址或完整请求地址</span>
              </span>
              <input
                v-model.trim="primaryModel.url"
                class="profile-control"
                data-test="model-url"
                type="url"
              />
            </label>

            <label class="instrument-setting-row">
              <span class="instrument-setting-copy">
                <strong>API Key</strong>
                <span>仅保存在当前扩展的本地配置中</span>
              </span>
              <span class="key-control profile-control">
                <input
                  v-model="primaryModel.apiKey"
                  :type="keyVisible ? 'text' : 'password'"
                  data-test="model-key"
                  autocomplete="new-password"
                />
                <button
                  type="button"
                  :title="keyVisible ? '隐藏 Key' : '显示 Key'"
                  :aria-label="keyVisible ? '隐藏 Key' : '显示 Key'"
                  @click="keyVisible = !keyVisible"
                >
                  <EyeOff v-if="keyVisible" :size="15" />
                  <Eye v-else :size="15" />
                </button>
              </span>
            </label>

            <label class="instrument-setting-row">
              <span class="instrument-setting-copy">
                <strong>思考强度</strong>
                <span>按所选模型支持的值填写，例如 max</span>
              </span>
              <input
                v-model.trim="primaryModel.reasoningEffort"
                class="profile-control"
                data-test="model-effort"
                type="text"
                placeholder="例如 max"
              />
            </label>

            <footer class="instrument-setting-actions">
              <span
                v-if="modelTest"
                :class="['status-line', modelTest.tone === 'success' ? 'is-success' : 'is-error']"
              >
                {{ modelTest.text }}
              </span>
              <button
                type="button"
                class="control-button"
                :disabled="busy === 'test-model'"
                @click="testModel"
              >
                <LoaderCircle
                  v-if="busy === 'test-model'"
                  :size="15"
                  class="is-spinning"
                  aria-hidden="true"
                />
                <Wifi v-else :size="15" aria-hidden="true" />
                {{ busy === 'test-model' ? '测试中' : '测试连接' }}
              </button>
              <button
                type="button"
                class="control-button is-primary"
                data-test="save-model"
                :disabled="busy === 'save-model'"
                @click="saveModel"
              >
                <Save :size="15" />保存模型
              </button>
            </footer>
          </div>
        </section>

        <section class="instrument-setting-section" aria-labelledby="config-title">
          <div id="config-title" class="instrument-setting-title">个人配置</div>
          <div class="instrument-setting-body">
            <div class="instrument-setting-row">
              <span class="instrument-setting-copy">
                <strong>配置格式</strong>
                <span>导入时会校验结构并覆盖当前账号配置</span>
              </span>
              <code class="profile-schema">SCHEMA V{{ bundle.schemaVersion }}</code>
            </div>

            <div class="instrument-setting-row">
              <span class="instrument-setting-copy">
                <strong>导入与导出</strong>
                <span>一个 JSON 文件包含全部个人配置项</span>
              </span>
              <div class="config-actions">
                <button
                  type="button"
                  class="control-button is-primary"
                  :disabled="busy === 'import'"
                  @click="importInput?.click()"
                >
                  <FileUp :size="15" />导入配置
                </button>
                <button
                  type="button"
                  class="control-button"
                  :disabled="busy === 'export'"
                  @click="exportBundle"
                >
                  <Download :size="15" />导出配置
                </button>
                <input
                  ref="importInput"
                  class="visually-hidden"
                  type="file"
                  accept="application/json,.json"
                  @change="importFile"
                />
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>
  </main>
</template>
