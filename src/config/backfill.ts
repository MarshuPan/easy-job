import deepmerge, { isPlainObject, jsonClone } from '@/utils/deepmerge'

import {
  createDefaultAiTasks,
  createDefaultDeliverySettings,
  createDefaultProfile,
} from './defaults'

/**
 * 给已存的配置补上后来新增的字段。
 *
 * 为什么需要这一层：配置校验对必填字段是严格的，而新增一个必填字段时，用户机器上早就
 * 写好的那份配置里没有它。没有这一层，加字段这个动作会让所有老用户的配置在读取时直接
 * 判定为损坏——而配置读不出来意味着面板根本起不来，等于把扩展变砖。这不是假设：
 * greetingSegmentSeconds 就是这样，加在 0.9.37，把 0.9.36 之前存过配置的账号全卡死了。
 *
 * 只补「缺失」，不改「已有」：缺字段是版本差异，值不对是真损坏。所以这里用默认值兜底，
 * 校验仍然在后面照常跑——补完还不合法的，就该报错。
 *
 * 整块不是对象时不补：字段缺了补默认是恢复，整块坏了套默认是把用户的配置悄悄换成空的。
 * 后者宁可让校验失败，也不能假装没事。
 */
export function backfillStoredConfigState(stored: unknown): unknown {
  if (!isPlainObject(stored)) return stored
  const next = jsonClone(stored) as Record<string, unknown>

  if (isPlainObject(next.profile)) next.profile = fill(createDefaultProfile(), next.profile)
  if (isPlainObject(next.tasks)) next.tasks = fill(createDefaultAiTasks(), next.tasks)

  if (isPlainObject(next.accountSettings)) {
    const accountSettings = next.accountSettings as Record<string, unknown>
    for (const [uid, settings] of Object.entries(accountSettings)) {
      if (!isPlainObject(settings)) continue
      accountSettings[uid] = pruneRemovedFilters(fill(createDefaultDeliverySettings(), settings))
    }
  }

  return next
}

/**
 * 已经从产品里移除的过滤器。它们的配置字段还留在老用户的存储里。
 *
 * 校验用 exactKeys，多出来的键会被判成「未知字段」——删字段和加字段一样能把配置判成
 * 损坏，面板照样起不来。所以移除一个字段必须配一次清理，方向和上面的补齐正好相反。
 *
 * 这几个是走查后确认不再开放的：白名单式的岗位名穷举不完、漏了还不知道漏了什么；
 * 薪资和公司名在搜索条件里已有更合适的位置；地址由通勤覆盖；HR 职位没有实际用途。
 * 岗位方向的判断交给 JD 与简历的实时匹配。
 */
const REMOVED_FILTER_KEYS = ['salaryRange', 'company', 'hrPosition', 'jobAddress', 'jobTitle']

function pruneRemovedFilters<T>(settings: T): T {
  const record = settings as unknown as Record<string, unknown>
  const filters = record.filters
  if (!isPlainObject(filters)) return settings
  for (const key of REMOVED_FILTER_KEYS) delete (filters as Record<string, unknown>)[key]
  return settings
}

/** 默认值打底，已存的值覆盖上去。数组整个替换，不逐项合并。 */
function fill<T>(defaults: T, stored: Record<keyof never, unknown>): T {
  return deepmerge(defaults, stored)
}
