import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const deliveryLimitSource = await readFile(
  new URL('../src/pages/zhipin/utils/deliveryLimit.ts', import.meta.url),
  'utf8',
)
const deliverSource = await readFile(
  new URL('../src/pages/zhipin/hooks/useDeliver.ts', import.meta.url),
  'utf8',
)
const operationSource = await readFile(
  new URL('../src/pages/zhipin/components/OperationPanel.vue', import.meta.url),
  'utf8',
)
const pagerSource = await readFile(
  new URL('../src/pages/zhipin/hooks/usePager.ts', import.meta.url),
  'utf8',
)
const uiSource = await readFile(
  new URL('../src/pages/zhipin/components/Ui.vue', import.meta.url),
  'utf8',
)
const statisticsSource = await readFile(
  new URL('../src/composables/useStatistics.ts', import.meta.url),
  'utf8',
)

assert.match(
  deliveryLimitSource,
  /DAILY_DELIVERY_LIMIT\s*=\s*150/,
  'daily delivery limit should be a shared hard cap',
)
assert.match(
  deliveryLimitSource,
  /hasDailyDeliveryRemaining/,
  'daily limit helper should exist for both operation panel and delivery hook',
)
assert.match(
  deliverSource,
  /hasDailyDeliveryRemaining\(statistics\.todayData\)/,
  'delivery hook should stop before starting a JD when daily limit is reached',
)
assert.match(
  deliverSource,
  /statistics\.todayData\.success\s*>=\s*DAILY_DELIVERY_LIMIT/,
  'delivery hook should stop immediately after the 150th successful greeting',
)
assert.match(
  deliverSource,
  /countUnknownCommunication\(ctx\)/,
  'an unconfirmed dispatched publish should conservatively consume daily capacity',
)
assert.match(
  operationSource,
  /hasDailyDeliveryRemaining\(todayData\)/,
  'operation panel should not create or continue tasks after daily limit is reached',
)
assert.match(
  operationSource,
  /flushRunState/,
  'operation panel should flush logs and statistics before pause or navigation',
)
assert.match(
  statisticsSource,
  /async function flush\(\)/,
  'statistics store should expose an explicit flush function',
)
assert.match(
  deliverSource,
  /flushJobRunStatePart\([\s\S]*?统计保存[\s\S]*?\(\)\s*=>\s*statistics\.flush\(\)/,
  'delivery hook should flush statistics after each processed JD',
)
assert.match(pagerSource, /ready/, 'pager should expose an explicit ready flag')
assert.match(pagerSource, /assertReady/, 'pager navigation should fail before initialization')
assert.match(
  operationSource,
  /watch\([\s\S]*?props\.runtimeReady[\s\S]*?activateOperationRuntime\(\)/,
  'operation panel should activate only after the host runtime is ready',
)
assert.match(
  operationSource,
  /function activateOperationRuntime\(\)[\s\S]*?if \(operationRuntimeActivated\) return[\s\S]*?resumeDeliveryTask\('mounted'\)/,
  'operation panel runtime activation should be idempotent and resume persisted work once',
)
assert.match(
  operationSource,
  /pendingManualPause = \{ accountUid, taskId \}[\s\S]*?scheduleDeliveryResumeAt\(Date\.now\(\) \+ deliveryReconnectRetryMs\)[\s\S]*?async function retryPendingManualPause\(\)/,
  'a pause RPC interruption should retain and automatically retry the pause intent',
)
assert.match(
  operationSource,
  /const currentStep = getCurrentTaskStep\(task\)[\s\S]*const currentSource = currentStep\?\.source[\s\S]*if \(isSameTaskStep\(nextStep, currentStep\)\)[\s\S]*return false/,
  'same-source page continuation should stay in the current run and advance via pager',
)
assert.match(
  operationSource,
  /nextStep\.source === currentSource && isSameNavigationLocation\(location\.href, nextStep\.url\)[\s\S]*return false/,
  'same-location steps should switch in place without restarting the run',
)
assert.match(
  uiSource,
  /await jobList\.initJobList\(conf\.formData\)[\s\S]*?await initPager\(\)[\s\S]*?jobRuntimeReady\.value = true/,
  'UI should mark the runtime ready only after job list and pager initialization',
)
assert.match(
  uiSource,
  /<OperationPanel[\s\S]*?:runtime-ready="jobRuntimeReady"/,
  'UI should pass explicit runtime readiness into the always-mounted delivery controller',
)
assert.doesNotMatch(
  operationSource,
  /setTimeout\(\(\) => \{\s*void resumeDeliveryTask\(\)\s*\}, 2500\)/s,
  'resume should not be driven by a fixed timer',
)

console.log('daily delivery safety checks passed')
