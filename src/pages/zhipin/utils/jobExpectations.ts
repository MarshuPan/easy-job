export interface JobExpectation {
  id: string
  index: number
  positionName: string
  locationName: string
  salaryDesc: string
}

export interface NativeJobExpectationOption {
  active: boolean
  element: HTMLElement
  id: string
  index: number
  text: string
  type: 'recommend' | 'expectation'
}

export const RECOMMENDATION_EXPECTATION_ID = 'recommend'

export function getRecommendationJobExpectation(): JobExpectation {
  return {
    id: RECOMMENDATION_EXPECTATION_ID,
    index: -1,
    positionName: '推荐',
    locationName: '',
    salaryDesc: 'BOSS 推荐岗位',
  }
}

export function isRecommendationExpectation(expectation?: Pick<JobExpectation, 'id'> | null) {
  return expectation?.id === RECOMMENDATION_EXPECTATION_ID
}

export function extractJobExpectations(data?: Pick<bossZpResumeData, 'expectList'> | null) {
  const seen = new Set<string>()
  const expectations: JobExpectation[] = []
  for (const item of data?.expectList ?? []) {
    const id = String(item?.id ?? '').trim()
    if (item?.positionType !== 0 || !id || seen.has(id)) continue
    seen.add(id)
    expectations.push({
      id,
      index: expectations.length,
      positionName: String(item.positionName ?? '').trim() || '未命名求职期望',
      locationName: String(item.locationName ?? '').trim(),
      salaryDesc: String(item.salaryDesc ?? '').trim(),
    })
  }
  return expectations
}

export function getExpectationLabel(expectation: JobExpectation) {
  return [expectation.positionName, expectation.locationName && `(${expectation.locationName})`]
    .filter(Boolean)
    .join('')
}

export function getEnabledJobExpectations(
  expectations: JobExpectation[],
  enabledExpectIds: readonly string[],
) {
  const enabled = new Set(enabledExpectIds.map(String))
  return expectations.filter((item) => enabled.has(item.id))
}

export function rebindEnabledJobExpectations(
  configured: readonly JobExpectationConfig[],
  available: readonly JobExpectation[],
) {
  const claimedIds = new Set<string>()
  const matched: JobExpectation[] = []
  const unmatched: JobExpectationConfig[] = []

  for (const source of configured) {
    const idMatch = available.find((item) => item.id === source.id && !claimedIds.has(item.id))
    if (idMatch) {
      claimedIds.add(idMatch.id)
      matched.push(idMatch)
      continue
    }

    const semanticMatches = available.filter(
      (item) => !claimedIds.has(item.id) && isSemanticExpectationMatch(source, item),
    )
    if (semanticMatches.length !== 1) {
      unmatched.push(source)
      continue
    }
    claimedIds.add(semanticMatches[0].id)
    matched.push(semanticMatches[0])
  }

  return {
    enabledIds: matched.map((item) => item.id),
    matched,
    unmatched,
  }
}

export function getInitialJobExpectation(
  expectations: JobExpectation[],
  root: ParentNode | null = document.querySelector('.c-expect-select'),
) {
  if (root) {
    const active = expectations.find((expectation) => {
      return findNativeJobExpectationOption(root, expectation)?.active === true
    })
    if (active) return active
  }
  return expectations[0] ?? null
}

export function filterJobsByExpectIds<T extends { expectId?: number | string }>(
  jobs: readonly T[],
  enabledExpectIds: readonly string[],
) {
  const enabled = new Set(enabledExpectIds.map(String))
  if (enabled.size === 0) return []
  return jobs.filter((item) => enabled.has(String(item.expectId ?? '')))
}

export function filterJobsByGroupTargets<
  T extends { expectId?: number | string; deliveryGroupTargetIds?: string[] },
>(jobs: readonly T[], enabledExpectIds: readonly string[], recommendEnabled: boolean) {
  const enabled = new Set(enabledExpectIds.map(String))
  return jobs.filter((item) => {
    const targetIds = getJobGroupTargetIds(item)
    return targetIds.some((targetId) =>
      targetId === RECOMMENDATION_EXPECTATION_ID ? recommendEnabled : enabled.has(targetId),
    )
  })
}

export function getJobGroupTargetIds(item: {
  expectId?: number | string
  deliveryGroupTargetIds?: string[]
}) {
  const capturedIds = Array.from(
    new Set(
      (item.deliveryGroupTargetIds ?? [])
        .map((targetId) => String(targetId).trim())
        .filter(Boolean),
    ),
  )
  if (capturedIds.length > 0) return capturedIds
  const expectId = String(item.expectId ?? '').trim()
  if (!expectId) return []
  return [expectId === '0' ? RECOMMENDATION_EXPECTATION_ID : expectId]
}

export function getJobGroupTargetId(item: {
  expectId?: number | string
  deliveryGroupTargetIds?: string[]
}) {
  return getJobGroupTargetIds(item)[0] ?? null
}

export function isGroupExpectationListReady(args: {
  active: boolean
  currentFirstJobId: string
  currentTargetIds: ReadonlySet<string>
  expectationId: string
  listLength: number
  previousFirstJobId: string
  waitedMs: number
  wasAlreadyActive: boolean
}) {
  if (args.currentTargetIds.has(args.expectationId)) return true
  if (!args.active || args.listLength <= 0) return false
  if (args.wasAlreadyActive) return true
  if (args.currentFirstJobId.length > 0 && args.currentFirstJobId !== args.previousFirstJobId) {
    return true
  }
  return args.currentTargetIds.size === 0 && args.waitedMs >= 2_000
}

/**
 * 来源分两个大类：求职期望和搜索。搜索直接叫「搜索」；求职期望要说清是哪一个分组
 * （「推荐」或用户自己的期望名），因为用户配了多个期望时，笼统的「求职期望」等于没说。
 *
 * 优先用入池时刻在岗位上的名字：expectations 只包含「当前启用」的期望，期望一旦被停用，
 * 靠 id 反查就查不到了，只能退回笼统的「求职期望」——而那正是要避免的。
 */
export function getJobSourceLabel(
  source: 'group' | 'search',
  item: {
    expectId?: number | string
    deliveryGroupName?: string
    deliveryGroupTargetIds?: string[]
  },
  expectations: readonly Pick<JobExpectation, 'id' | 'positionName'>[] = [],
) {
  if (source === 'search') return '搜索'
  const targetIds = getJobGroupTargetIds(item)
  if (targetIds.includes(RECOMMENDATION_EXPECTATION_ID)) return '推荐'
  return (
    expectations.find((expectation) => targetIds.includes(expectation.id))?.positionName.trim() ||
    item.deliveryGroupName?.trim() ||
    '求职期望'
  )
}

export function readNativeJobExpectationOptions(root: ParentNode) {
  const recommendation = root.querySelector<HTMLElement>('.synthesis')
  const elements = Array.from(
    root.querySelectorAll<HTMLElement>('.expect-list .expect-item, .expect-item'),
  )
  const options = elements.map<NativeJobExpectationOption>((element, index) => ({
    active:
      element.classList.contains('active') ||
      element.classList.contains('selected') ||
      element.querySelector('.active, .selected') != null,
    element,
    id: readNativeExpectationId(element),
    index,
    text:
      element.querySelector<HTMLElement>('.text-content')?.textContent?.trim() ||
      element.textContent?.replace(/\s+/g, ' ').trim() ||
      '未知求职期望',
    type: 'expectation' as const,
  }))
  if (recommendation) {
    options.unshift({
      active: recommendation.classList.contains('active'),
      element: recommendation,
      id: RECOMMENDATION_EXPECTATION_ID,
      index: -1,
      text: recommendation.textContent?.replace(/\s+/g, ' ').trim() || '推荐',
      type: 'recommend',
    })
  }
  return options
}

export function findNativeJobExpectationOption(root: ParentNode, expectation: JobExpectation) {
  const options = readNativeJobExpectationOptions(root)
  const idMatch = options.find((item) => item.id && item.id === expectation.id)
  if (idMatch) return idMatch

  const expectationOptions = options.filter((item) => item.type === 'expectation')

  const position = normalizeExpectationText(expectation.positionName)
  const location = normalizeLocation(expectation.locationName)
  const textMatches = expectationOptions.filter((item) => {
    const text = normalizeExpectationText(item.text)
    if (position && !text.includes(position)) return false
    return !location || normalizeLocation(item.text).includes(location)
  })
  if (textMatches.length === 1) return textMatches[0]

  const positionMatches = expectationOptions.filter((item) => {
    return position && normalizeExpectationText(item.text).includes(position)
  })
  if (positionMatches.length === 1) return positionMatches[0]

  return expectationOptions[expectation.index] ?? null
}

function readNativeExpectationId(element: HTMLElement) {
  const candidates = [
    element.dataset.expectId,
    element.dataset.id,
    element.getAttribute('data-expect-id'),
    element.getAttribute('data-id'),
    element.getAttribute('value'),
  ]
  return candidates.find((value) => value?.trim())?.trim() ?? ''
}

function normalizeExpectationText(value: string) {
  return value.toLocaleLowerCase().replace(/[\s()（）【】[\]「」《》,，/｜|·・_-]/g, '')
}

function normalizeLocation(value: string) {
  return normalizeExpectationText(value).replace(/省|市|自治区|特别行政区/g, '')
}

function isSemanticExpectationMatch(configured: JobExpectationConfig, available: JobExpectation) {
  const position = normalizeExpectationText(configured.positionName)
  if (!position || position !== normalizeExpectationText(available.positionName)) return false

  const location = normalizeLocation(configured.locationName)
  if (location && location !== normalizeLocation(available.locationName)) return false

  const salary = normalizeExpectationText(configured.salaryDesc)
  if (salary && salary !== normalizeExpectationText(available.salaryDesc)) return false
  return true
}
import type { JobExpectationConfig } from '@/config/types'
