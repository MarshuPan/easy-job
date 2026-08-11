/**
 * 拟人化节奏。
 *
 * 慢不是防御。速率只要进入「人类可能的范围」就够了，再慢一分钱都买不到安全——
 * 一个慢的自动化还是自动化。所以这里不追求把间隔拉长，追求的是间隔的形状对。
 *
 * 形状有两个要点：
 *
 * 一是不能为零，也不能精确相等。0 间隔和精确 60.000 秒的周期是同一类破绽。
 *
 * 二是分布要对。原来用的是均匀抖动（目标值的 70%~140%），那是个矩形分布，本身就有签名；
 * 真人的动作间隔是重尾的——大部分很短，偶尔特别长（走神、认真读了一段）。
 * 换成对数正态之后中位数明显低于均匀分布的均值，长尾只占少数，所以既更像人也更快。
 * 这两件事在这里不冲突。
 */

/** 打字速度：每个字约 45 毫秒，接近中文输入法下的正常手速。 */
const msPerChar = 45

/** 分段间隔的兜底下限，避免用户把基础值设成 0 之后又变成连发。 */
const minGreetingSegmentMs = 1500

/** 单次等待的上限，防止配置写错或长尾抽得太夸张，让投递看起来像卡死。 */
const maxGreetingSegmentMs = 90_000

/** 没给 p90 时的默认离散度。0.5 大致对应「p90 是中位数的 1.9 倍」。 */
const defaultSpread = 0.5

/** 标准正态的 90 分位。用它把「p90 是多少」换算成对数正态的 sigma。 */
const z90 = 1.2816

function gaussian(random: () => number) {
  let u = 0
  let v = 0
  while (u === 0) u = random()
  while (v === 0) v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export interface HumanDelayOptions {
  /** 十次里大约九次不超过这个值。给了它就用它反推离散度。 */
  p90Ms?: number
  minMs?: number
  maxMs?: number
}

/**
 * 抽一个拟人的间隔。
 *
 * typicalMs 是中位数——一半的间隔比它短。这和「最小值」是两回事：按最小值理解会把
 * 整体均值抬到区间中点，那正是均匀抖动损失效率的地方。
 */
export function sampleHumanDelayMs(
  typicalMs: number,
  options: HumanDelayOptions = {},
  random: () => number = Math.random,
) {
  const median = Math.max(0, typicalMs)
  if (median === 0 && options.minMs == null) return 0
  const p90 = options.p90Ms
  const sigma =
    p90 != null && p90 > median && median > 0 ? Math.log(p90 / median) / z90 : defaultSpread
  const sampled = median * Math.exp(sigma * gaussian(random))
  const lower = options.minMs ?? 0
  const upper = options.maxMs ?? Number.POSITIVE_INFINITY
  return Math.round(Math.min(upper, Math.max(lower, sampled)))
}

/**
 * 两段招呼语之间该等多久。
 *
 * 基础值由用户配置，再加上这一段本身的「打字时间」——长句子理应比短句子晚一点发出来，
 * 这比所有段落等长的固定间隔更难被当成脚本。
 */
export function greetingSegmentDelayMs(
  contentLength: number,
  baseSeconds: number,
  random: () => number = Math.random,
) {
  const base = Math.max(0, Number(baseSeconds) || 0) * 1000
  const typing = Math.max(0, contentLength) * msPerChar
  return sampleHumanDelayMs(
    base + typing,
    { minMs: minGreetingSegmentMs, maxMs: maxGreetingSegmentMs },
    random,
  )
}
