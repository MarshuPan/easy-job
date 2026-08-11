import bossCityCodeData from '@/data/boss-city-codes.json'
import cityData from '@/data/cities.json'
import type { FormDataSearchConditions } from '@/types/formData'

export interface BossSearchOption {
  value: string
  label: string
}

type CityDataItem = { code: string; name: string; provinceCode: string }

const municipalityLabels: Record<string, string> = {
  '11': '北京',
  '12': '天津',
  '31': '上海',
  '50': '重庆',
}

function normalizeCityName(value: string) {
  return value
    .trim()
    .replace(/市辖区|省直辖县级行政区划|自治区直辖县级行政区划/g, '')
    .replace(/(?:自治州|自治县|地区|盟|市|县|区)$/, '')
}

function buildBossCityOptions() {
  const codeByName = new Map(
    Object.entries(bossCityCodeData as Record<string, string>).map(([name, value]) => [
      normalizeCityName(name),
      String(value),
    ]),
  )
  const options: BossSearchOption[] = []
  const seenCodes = new Set<string>()
  const append = (label: string, value?: string) => {
    const code = value?.trim()
    if (!code || seenCodes.has(code)) return
    seenCodes.add(code)
    options.push({ value: code, label })
  }

  for (const city of cityData as CityDataItem[]) {
    const municipality = municipalityLabels[city.provinceCode]
    if (municipality && ['11', '12', '31'].includes(city.provinceCode)) {
      append(municipality, codeByName.get(municipality))
      continue
    }
    if (municipality && city.code.startsWith('500')) {
      append(municipality, codeByName.get(municipality))
      continue
    }
    if (/直辖县级行政区划/.test(city.name)) continue
    const normalizedName = normalizeCityName(city.name)
    append(normalizedName || city.name, codeByName.get(normalizedName))
  }

  // The supplied administrative catalog intentionally omits BOSS's county-level
  // and special-region entries; append those static BOSS options as well.
  for (const [name, code] of Object.entries(bossCityCodeData as Record<string, string>)) {
    if (name === '全国') continue
    append(name, code)
  }
  return options
}

export const bossCityOptions: BossSearchOption[] = buildBossCityOptions()

export const bossSalaryOptions: BossSearchOption[] = [
  { value: '402', label: '3K 以下' },
  { value: '403', label: '3-5K' },
  { value: '404', label: '5-10K' },
  { value: '405', label: '10-20K' },
  { value: '406', label: '20-50K' },
  { value: '407', label: '50K 以上' },
]

export const bossExperienceOptions: BossSearchOption[] = [
  { value: '101', label: '经验不限' },
  { value: '108', label: '在校生' },
  { value: '102', label: '应届生' },
  { value: '103', label: '1 年以内' },
  { value: '104', label: '1-3 年' },
  { value: '105', label: '3-5 年' },
  { value: '106', label: '5-10 年' },
  { value: '107', label: '10 年以上' },
]

export const bossDegreeOptions: BossSearchOption[] = [
  { value: '209', label: '初中及以下' },
  { value: '208', label: '中专/中技' },
  { value: '206', label: '高中' },
  { value: '202', label: '大专' },
  { value: '203', label: '本科' },
  { value: '204', label: '硕士' },
  { value: '205', label: '博士' },
]

export const bossJobTypeOptions: BossSearchOption[] = [
  { value: '1901', label: '全职' },
  { value: '1903', label: '兼职' },
  { value: '1902', label: '实习' },
]

const defaultSearchUrl = 'https://www.zhipin.com/web/geek/job'
export const MAX_SEARCH_DIRECTIONS = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function cleanString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanStringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((item): item is string | number => {
          return typeof item === 'string' || typeof item === 'number'
        })
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

function splitSearchParam(value: string | null) {
  return value == null ? [] : cleanStringArray(value.split(','))
}

function directionKey(value: string) {
  return value.replace(/\s+/g, '').toLocaleLowerCase()
}

export function normalizeSearchDirections(value: unknown) {
  const result: string[] = []
  const keys = new Set<string>()
  for (const direction of cleanStringArray(value)) {
    const normalized = direction.replace(/\s+/g, ' ').trim()
    const key = directionKey(normalized)
    if (!key || keys.has(key)) continue
    keys.add(key)
    result.push(normalized)
  }
  return result.slice(0, MAX_SEARCH_DIRECTIONS)
}

export function parseSearchConditionsFromUrl(searchUrl?: string): FormDataSearchConditions {
  let url: URL | null = null
  try {
    url = searchUrl ? new URL(searchUrl, defaultSearchUrl) : null
  } catch {
    url = null
  }
  const params = url?.searchParams
  return {
    directions: normalizeSearchDirections(params?.get('query') ? [params.get('query')] : []),
    city: cleanString(params?.get('city')),
    businessDistricts: [],
    salary: cleanString(params?.get('salary')),
    experience: splitSearchParam(params?.get('experience') ?? null),
    degree: splitSearchParam(params?.get('degree') ?? null),
    jobType: splitSearchParam(params?.get('jobType') ?? null),
  }
}

export function normalizeSearchConditions(
  value: unknown,
  fallback: {
    legacySearchUrl?: string
    legacyJobTitles?: readonly string[]
  } = {},
): FormDataSearchConditions {
  const source = isRecord(value) ? value : {}
  const legacy = parseSearchConditionsFromUrl(fallback.legacySearchUrl)
  const configuredDirections = normalizeSearchDirections(source.directions)
  const fallbackDirections = normalizeSearchDirections([
    ...(fallback.legacyJobTitles ?? []),
    ...legacy.directions,
  ])
  const configuredExperience = cleanStringArray(source.experience)
  const configuredDegree = cleanStringArray(source.degree)
  const configuredJobType = cleanStringArray(source.jobType)

  return {
    directions: Array.isArray(source.directions) ? configuredDirections : fallbackDirections,
    city: typeof source.city === 'string' ? cleanString(source.city) : legacy.city,
    // Work-area filtering is intentionally unsupported; clear legacy values so
    // an old private configuration cannot keep affecting search requests.
    businessDistricts: [],
    salary: typeof source.salary === 'string' ? cleanString(source.salary) : legacy.salary,
    experience: Array.isArray(source.experience) ? configuredExperience : legacy.experience,
    degree: Array.isArray(source.degree) ? configuredDegree : legacy.degree,
    jobType: Array.isArray(source.jobType) ? configuredJobType : legacy.jobType,
  }
}

function setMultiValue(params: URLSearchParams, key: string, values: string[]) {
  if (values.length > 0) params.set(key, values.join(','))
}

function createBossSearchBaseUrl(baseUrl?: string) {
  try {
    const parsed = new URL(baseUrl || defaultSearchUrl, defaultSearchUrl)
    if (parsed.hostname === 'zhipin.com' || parsed.hostname.endsWith('.zhipin.com')) {
      parsed.pathname = '/web/geek/job'
      parsed.search = ''
      parsed.hash = ''
      return parsed
    }
  } catch {
    // Fall through to the known BOSS search route.
  }
  return new URL(defaultSearchUrl)
}

export function buildBossSearchUrls(
  value: FormDataSearchConditions,
  baseUrl?: string,
): Array<{ direction: string; url: string }> {
  const conditions = normalizeSearchConditions(value)
  return conditions.directions.map((direction) => {
    const url = createBossSearchBaseUrl(baseUrl)
    url.searchParams.set('query', direction)
    if (conditions.city) url.searchParams.set('city', conditions.city)
    if (conditions.salary) url.searchParams.set('salary', conditions.salary)
    setMultiValue(url.searchParams, 'experience', conditions.experience)
    setMultiValue(url.searchParams, 'degree', conditions.degree)
    setMultiValue(url.searchParams, 'jobType', conditions.jobType)
    return { direction, url: url.toString() }
  })
}

export function getBossSearchOptionLabel(
  options: readonly BossSearchOption[],
  value: string,
  fallback = '不限',
) {
  if (!value) return fallback
  return options.find((item) => item.value === value)?.label ?? value
}
