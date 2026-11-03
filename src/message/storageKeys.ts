/**
 * 页面（MAIN world）能经 content script 读写的扩展存储键。
 *
 * 白名单单独成模块，是为了让存储层的测试能直接用它：存储在测试里是 mock 的，
 * 不拿真实白名单核对，新加的键漏在白名单外也照样全绿——1.3.7 就是这样上的真机。
 */
export const LAUNCHER_POSITION_STORAGE_KEY = 'local:launcher-position'

const allowedStorageKeySet = new Set([
  LAUNCHER_POSITION_STORAGE_KEY,
  'boss-protocol',
  'local:pipeline-cache',
  'local:pending-greetings',
  'local:sameCompany',
  'local:sameHr',
  'local:sameHrResetVersion',
  'local:web-geek-job-DeliveryLogs',
  'local:web-geek-job-FormData',
  'local:web-geek-job-SourcePools',
  'local:web-geek-job-Statistics',
  'local:web-geek-job-StatisticsEpoch',
  'local:web-geek-job-Today',
  'local:boss-action-gate',
  'local:risk-backoff',
  'appearance-conf',
  'theme-dark',
])

const legacyTaskStoragePrefix = `local:${['boss', 'helper'].join('-')}-task-v1:`
const allowedStorageKeyPrefixes = [
  'local:alert:',
  'local:agent-delivery-task-v1:',
  legacyTaskStoragePrefix,
]
const allowedAccountStorageKeyPattern =
  /^local:web-geek-job-(?:DeliveryLogs|SearchRotation|SourcePools|Statistics|StatisticsEpoch|Today):[A-Za-z0-9_-]{1,128}$/
const allowedRuntimeLogStorageKeyPattern =
  /^local:agent-delivery-runtime-logs:[A-Za-z0-9_-]{1,128}$/
// 岗位记录按账号、按天存（外加一个日期索引），运行日志按账号存。两者从旧的共享日志键拆出来，
// 键名变了就必须在这里放行——漏了的后果是静默的：页面上一切正常，一刷新记录全没了。
const allowedDeliveryLogStorageKeyPattern =
  /^local:(?:agent-delivery-records:[A-Za-z0-9_-]{1,128}:(?:\d{4}-\d{2}-\d{2}|days)|agent-delivery-run-events:[A-Za-z0-9_-]{1,128})$/

export function assertAllowedStorageKey(key: string) {
  if (
    allowedStorageKeySet.has(key) ||
    allowedAccountStorageKeyPattern.test(key) ||
    allowedRuntimeLogStorageKeyPattern.test(key) ||
    allowedDeliveryLogStorageKeyPattern.test(key) ||
    allowedStorageKeyPrefixes.some((prefix) => key.startsWith(prefix))
  )
    return
  throw new Error(`storage key is not allowed: ${key}`)
}
