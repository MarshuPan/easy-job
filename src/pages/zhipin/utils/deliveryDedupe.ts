/**
 * 入池前的去重预判与同公司限量。
 *
 * 同公司、同 HR、已沟通这三条判定所需的字段（encryptBrandId、encryptBossId、contact）
 * 在岗位列表数据里就有，不需要取详情。过去它们只在处理岗位时才判，于是必然投不出去的岗位
 * 照样占着投递池的名额。
 *
 * 这不只是浪费。投递池的水位用「状态为待处理」来算，而一个还没处理的重复岗位状态就是待处理，
 * 于是水位被这些死岗位撑在低水位线之上，补池永远不触发——真机上出现过一批 30 个岗位里
 * 只有 10 个能投，却因为水位显示 30 而始终不去翻新页面，整轮跑完 0 投递。
 *
 * 去重集合是跨天累积的，投得越多，每一页里已联系过的公司占比越高，这个问题只会越来越重。
 *
 * 预判不追求完全准确：集合在运行中会随着投递成功而增长，处理岗位时的那道判定仍然是权威。
 * 这里少拦一个只是让它多占一会儿名额，误拦才是要避免的，所以只在信息明确时才排除。
 *
 * 限量是另一半。上面那道判定只认「已经投过的公司」，对一家还没投过、却一口气发了 20 个 JD
 * 的公司完全无效：20 个全部入池、全部占名额，投出去第一个之后剩下 19 个才变成死数据。
 * 所以入池时还要按公司限量——同一家公司只留够数的候选，多的不进来。
 */

/**
 * 同一家公司最多占几个投递池名额。
 *
 * 为什么不是 1：同公司去重开着的时候，一家公司最终也只会投出去一个，但第一个候选可能被
 * AI 打分或岗位规则筛掉，留几个是后备。为什么不是 20：一家公司刷屏式发的 JD 会把整个池子
 * 的名额吃光，水位看着满，能投的只有一个。
 */
export const sameCompanyPoolQuota = 3

export interface DeliveredKeys {
  companies: ReadonlySet<string>
  bosses: ReadonlySet<string>
}

export interface DedupeSettings {
  sameCompany: boolean
  sameHr: boolean
  friendStatus: boolean
}

export interface DedupeCandidate {
  encryptBrandId?: string
  encryptBossId?: string
  contact?: boolean
}

/**
 * 这个岗位为什么不可能被投出去，没有理由就是还有机会。
 *
 * 措辞跟处理岗位时抛出的 RepeatError 保持一致，因为预判命中的时候会直接把岗位标成已过滤，
 * 用户在记录里看到的理由必须和真正走完流程时看到的是同一句。
 */
export function explainImpossibleDelivery(
  job: DedupeCandidate,
  settings: DedupeSettings,
  delivered: DeliveredKeys,
): string | null {
  if (settings.friendStatus && job.contact === true) return '已经沟通过'
  const brandId = job.encryptBrandId
  if (
    settings.sameCompany &&
    brandId != null &&
    brandId !== '' &&
    delivered.companies.has(brandId)
  ) {
    return '相同公司已投递'
  }
  const bossId = job.encryptBossId
  if (settings.sameHr && bossId != null && bossId !== '' && delivered.bosses.has(bossId)) {
    return '相同hr已投递'
  }
  return null
}

/** 这个岗位在当前去重设置下还有没有可能被投出去。 */
export function canPossiblyDeliver(
  job: DedupeCandidate,
  settings: DedupeSettings,
  delivered: DeliveredKeys,
) {
  return explainImpossibleDelivery(job, settings, delivered) == null
}

export interface PoolAdmissionOptions {
  settings: DedupeSettings
  delivered: DeliveredKeys
  /** 池子里已经占着名额的岗位，用来算每家公司还剩几个位置。 */
  pooled: readonly DedupeCandidate[]
  /** 同一家公司的名额上限，缺省用 sameCompanyPoolQuota。 */
  companyQuota?: number
}

/**
 * 造一个「能不能进池」的判据。
 *
 * 返回的函数带状态：每放行一个岗位就占掉它所属公司的一个名额，所以只能按顺序对候选各调用
 * 一次（filter 正好是这个用法）。名额从池子里已有的岗位算起，因此翻页补池不会让同一家公司
 * 一次又一次地拿满配额。
 */
export function createPoolAdmission(options: PoolAdmissionOptions) {
  const quota = options.companyQuota ?? sameCompanyPoolQuota
  const used = new Map<string, number>()
  for (const job of options.pooled) {
    const brandId = job.encryptBrandId
    if (brandId == null || brandId === '') continue
    used.set(brandId, (used.get(brandId) ?? 0) + 1)
  }

  return (job: DedupeCandidate) => {
    if (!canPossiblyDeliver(job, options.settings, options.delivered)) return false
    const brandId = job.encryptBrandId
    // 认不出是哪家公司就不限量：宁可让它占个名额，也不能凭猜测把岗位挡在外面。
    if (brandId == null || brandId === '') return true
    const taken = used.get(brandId) ?? 0
    if (taken >= quota) return false
    used.set(brandId, taken + 1)
    return true
  }
}
