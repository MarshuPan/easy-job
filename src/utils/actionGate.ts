/**
 * 动作闸门：所有发往 BOSS 的动作都要先从这里取许可。
 *
 * 为什么不是继续加 delay：散在各处的 delay 只在「正常路径按顺序跑一遍」时成立，
 * 给的是统计保证。重试、任务恢复、页面刷新后重入、多个标签页、以后新增的调用点——
 * 任何一条绕过某个 delay 的路径，请求就直接出去了，而且没有任何东西约束一小时内的总量。
 *
 * 为什么是令牌桶而不是固定速率：匀速本身就是机器特征。恒定 4 次/分钟连跑三小时，
 * 这个平坦度就是签名。真人是爆发式的——打开 App 先快速扫一批，然后变慢，然后休息。
 *
 * 限额的取值按「人做得出来」定，不按「越慢越安全」定。慢不是防御：速率只是可检测的
 * 众多轴里的一条，压到极低只是变成一个慢的自动化，安全没买到，效率全赔进去。
 * 所以这里给每类动作一个「桶容量」（一口气能连做几个）和一个「补充速率」，
 * 并且补充速率随会话时长衰减：刚开工快，跑久了慢，歇一会儿再回到快。
 *
 * 会话不需要外部状态：动作记录里出现一段足够长的空白，就说明上一段会话结束了。
 * 歇够了曲线自然回到起点，这也正是「休息之后又能快起来」该有的样子。
 *
 * 桶之外还留了一层滑动窗口硬顶，不随曲线放大。它平时不该起作用，只在别的地方出 bug
 * 时兜住——曲线是让节奏像人，硬顶是保证再怎么错也跑不飞。
 */

export type BossActionKind = 'detail' | 'publish' | 'greeting' | 'pageNext' | 'navigate'

/**
 * 等到闸门超时。
 *
 * 定义在这里而不是持久化层：这个类型是调用方要判断的契约，放在会被 mock 掉的模块里，
 * instanceof 会在测试里静默变成对 undefined 取值。
 */
export class ActionGateTimeoutError extends Error {
  constructor(kind: BossActionKind, waitedMs: number) {
    super(`动作闸门等待超时：${kind} 已等待 ${Math.round(waitedMs / 1000)} 秒`)
    this.name = 'ActionGateTimeoutError'
  }
}

export interface ActionEvent {
  kind: BossActionKind
  at: number
}

/** 令牌桶：burst 是一口气能连做几个，refillPerMin 是稳态每分钟补几个。 */
export interface BucketRule {
  burst: number
  refillPerMin: number
}

/** 硬顶：不随曲线放大的滑动窗口上限。 */
export interface CeilingRule {
  windowMs: number
  max: number
}

export interface GateRules {
  buckets: Record<BossActionKind | 'total', BucketRule>
  ceilings: Partial<Record<BossActionKind | 'total', CeilingRule[]>>
}

const minute = 60_000
const hour = 60 * minute

/**
 * 动作记录里出现这么长的空白，就当作新会话开始，曲线重新从最快那一段算起。
 *
 * 必须小于批量休息的默认值（10 分钟），否则产品自带的那次休息刚好差一点触发不了重置，
 * 「歇够了又能快起来」就成了一句空话——两个机制各自成立，合起来不通。
 */
export const sessionGapMs = 8 * minute

/**
 * 节奏曲线。
 *
 * 刚开工的一段最快，之后逐级放慢。这既贴合真人（开头扫得快，越往后越挑剔、越慢），
 * 也贴合风控的实际形态：偶发的密集不敏感，持续的高频才是被抓的东西。
 *
 * 最慢的一档是 0.75 而不是更低：慢本身不是防御，一个慢的自动化还是自动化。降速只到
 * 「给会话一个自然的收尾压力」为止，真正的收尾由会话层负责，这里只保证不会一路冲到底。
 */
export function paceMultiplier(sessionElapsedMs: number): number {
  if (sessionElapsedMs < 10 * minute) return 1.8
  if (sessionElapsedMs < 25 * minute) return 1.35
  if (sessionElapsedMs < 45 * minute) return 1
  return 0.75
}

/**
 * 默认限额。
 *
 * 桶容量按「一个岗位完整走一遍要几个动作」来定：招呼语分三到五段，所以它的桶最大，
 * 否则一个岗位的招呼语自己就会把自己卡住。
 */
export const defaultGateRules: GateRules = {
  buckets: {
    detail: { burst: 6, refillPerMin: 5 },
    publish: { burst: 3, refillPerMin: 3 },
    greeting: { burst: 6, refillPerMin: 12 },
    pageNext: { burst: 2, refillPerMin: 2 },
    navigate: { burst: 3, refillPerMin: 2 },
    total: { burst: 14, refillPerMin: 12 },
  },
  ceilings: {
    // 详情这条是 BOSS 实测的接口配额，不是保险丝：两轮真机在第 6、第 7 次详情请求上
    // 拿到「您的环境存在异常」，而第二轮整整慢了一倍（158 秒对 76 秒）也只多撑了一次
    // ——所以它更像固定次数配额，不是速率限制。
    //
    // 放在硬顶而不是桶里，是因为它不该跟着会话曲线放大。曲线的目的是让节奏像人，
    // 而这是对方接口的硬性上限，开工阶段 1.8 倍恰恰是最容易撞上去的时候。
    //
    // 5 次 / 5 分钟约合每小时 60 次，跑满一天远超每日 150 的额度，够用。窗口取 5 分钟
    // 是待验证的猜测：如果照这个限额跑仍然在第 6 次上失败，说明配额不是按窗口滚动的，
    // 那要换一条路——减少每个岗位的详情请求，而不是继续降速。
    detail: [{ windowMs: 5 * minute, max: 5 }],
    publish: [{ windowMs: hour, max: 90 }],
    total: [{ windowMs: hour, max: 420 }],
  },
}

export function getMaxWindowMs(rules: GateRules = defaultGateRules) {
  let max = sessionGapMs * 2
  for (const windows of Object.values(rules.ceilings)) {
    for (const window of windows ?? []) {
      if (window.windowMs > max) max = window.windowMs
    }
  }
  return max
}

export function pruneEvents(
  events: readonly ActionEvent[],
  now: number,
  rules: GateRules = defaultGateRules,
) {
  const cutoff = now - getMaxWindowMs(rules)
  return events.filter((event) => event.at > cutoff)
}

function sortedTimes(events: readonly ActionEvent[]) {
  return events.map((event) => event.at).sort((a, b) => a - b)
}

/**
 * 当前会话是什么时候开始的。
 *
 * 从最近一段连续动作往前找：一旦相邻两次动作之间的空白超过 sessionGapMs，
 * 之前的就属于上一段会话了。没有动作记录就是现在开始。
 */
export function getSessionStartedAt(
  events: readonly ActionEvent[],
  now: number,
  gapMs: number = sessionGapMs,
) {
  const times = sortedTimes(events)
  if (times.length === 0) return now
  // 最后一次动作离现在太久，说明已经歇过了，这一次算新会话的第一个动作。
  if (now - times[times.length - 1] > gapMs) return now
  let start = times[0]
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > gapMs) start = times[i]
  }
  return start
}

export function getSessionElapsedMs(
  events: readonly ActionEvent[],
  now: number,
  gapMs: number = sessionGapMs,
) {
  return Math.max(0, now - getSessionStartedAt(events, now, gapMs))
}

/**
 * 按事件流回放一个令牌桶，算出此刻还剩多少令牌。
 *
 * 补充速率随会话时长衰减，所以每一段间隔要用那一段所处阶段的倍率来补——
 * 用当前倍率一把算完会把开头那段的快补错误地摊到整个会话上。
 */
function tokensAvailable(
  times: readonly number[],
  bucket: BucketRule,
  now: number,
  sessionStartedAt: number,
) {
  let level = bucket.burst
  let cursor = times.length > 0 ? Math.min(times[0], sessionStartedAt) : now
  const refillFor = (from: number, to: number) => {
    if (to <= from) return 0
    const multiplier = paceMultiplier(Math.max(0, from - sessionStartedAt))
    return ((to - from) / minute) * bucket.refillPerMin * multiplier
  }
  for (const at of times) {
    level = Math.min(bucket.burst, level + refillFor(cursor, at)) - 1
    cursor = at
  }
  return Math.min(bucket.burst, level + refillFor(cursor, now))
}

function waitForBucket(
  times: readonly number[],
  bucket: BucketRule,
  now: number,
  sessionStartedAt: number,
) {
  if (bucket.burst <= 0 || bucket.refillPerMin <= 0) return Number.POSITIVE_INFINITY
  const level = tokensAvailable(times, bucket, now, sessionStartedAt)
  if (level >= 1) return 0
  const multiplier = paceMultiplier(Math.max(0, now - sessionStartedAt))
  return Math.ceil(((1 - level) / (bucket.refillPerMin * multiplier)) * minute)
}

function waitForCeilings(times: readonly number[], windows: readonly CeilingRule[], now: number) {
  let wait = 0
  for (const window of windows) {
    if (window.max <= 0) return Number.POSITIVE_INFINITY
    const inWindow = times.filter((at) => at > now - window.windowMs)
    if (inWindow.length < window.max) continue
    const sorted = [...inWindow].sort((a, b) => a - b)
    const releaseAt = sorted[inWindow.length - window.max] + window.windowMs
    wait = Math.max(wait, releaseAt - now)
  }
  return Math.max(0, wait)
}

/** 还要等多久，毫秒。0 表示现在就能发。 */
export function waitMsFor(
  events: readonly ActionEvent[],
  kind: BossActionKind,
  now: number,
  rules: GateRules = defaultGateRules,
) {
  const sessionStartedAt = getSessionStartedAt(events, now)
  const ofKind = sortedTimes(events.filter((event) => event.kind === kind))
  const all = sortedTimes(events)
  return Math.max(
    waitForBucket(ofKind, rules.buckets[kind], now, sessionStartedAt),
    waitForBucket(all, rules.buckets.total, now, sessionStartedAt),
    waitForCeilings(ofKind, rules.ceilings[kind] ?? [], now),
    waitForCeilings(all, rules.ceilings.total ?? [], now),
  )
}
