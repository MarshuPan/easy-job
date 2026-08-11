import { useConf } from '@/stores/conf'
import { request } from '@/utils/request'

export interface AmapError {
  status: string
  info: string
  infocode: string
}

export interface AmapGeocode {
  status: string
  info: string
  infocode: string
  count: string
  geocodes: Array<{
    formatted_address: string
    country: string
    province: string
    citycode: string
    city: string
    district: string
    township: Array<any>
    neighborhood: {
      name: Array<any>
      type: Array<any>
    }
    building: {
      name: Array<any>
      type: Array<any>
    }
    adcode: string
    street: Array<any>
    number: Array<any>
    location: string
    level: string
  }>
}
export interface AmapDistance {
  status: string
  info: string
  infocode: string
  count: string
  results: Array<{
    origin_id: string
    dest_id: string
    distance: string
    duration: string
  }>
}

export interface ResolvedAmapLocation {
  location: string
  geocode?: AmapGeocode['geocodes'][number]
}

export interface AmapDistanceModes {
  straight: boolean
  driving: boolean
  walking: boolean
}

function normalizeCoordinate(value: string) {
  const parts = value.split(',').map((item) => item.trim())
  if (parts.length !== 2 || parts.some((item) => item === '')) return null
  const longitude = Number(parts[0])
  const latitude = Number(parts[1])
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return null
  }
  return `${longitude},${latitude}`
}

export async function amapGeocode(
  address: string,
): Promise<AmapGeocode['geocodes'][number] | undefined> {
  const { formData } = useConf()
  const params = new URLSearchParams({
    address,
    output: 'JSON',
    key: formData.amap.key,
  })
  const res = (await request.get({
    url: `https://restapi.amap.com/v3/geocode/geo?${params}`,
  })) as AmapGeocode | AmapError
  if (res.status !== '1' || !('geocodes' in res)) {
    throw new Error(res.info)
  }
  return res.geocodes?.[0]
}

export async function resolveAmapLocation(value: string): Promise<ResolvedAmapLocation> {
  const input = value.trim()
  if (!input) throw new Error('地址为空')
  const coordinate = normalizeCoordinate(input)
  if (coordinate) return { location: coordinate }

  const geocode = await amapGeocode(input)
  const location = geocode?.location?.trim()
  if (!location) throw new Error(`地址无法解析：${input}`)
  return { geocode, location }
}

function parseDistanceResult(res: AmapDistance | AmapError | null) {
  if (res == null) return null
  if (res.status !== '1' || !('results' in res)) return null
  const result = res.results?.[0]
  const distance = Number(result?.distance)
  const duration = Number(result?.duration)
  if (!Number.isFinite(distance) || distance < 0) return null
  return {
    ok: true,
    distance,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
  }
}

export async function amapDistance(
  destination: string,
  origins?: string,
  modes: AmapDistanceModes = { straight: true, driving: true, walking: true },
) {
  const { formData } = useConf()
  const createDistanceUrl = (type: string) => {
    const params = new URLSearchParams({
      origins: origins ?? formData.amap.origins,
      destination,
      type,
      output: 'JSON',
      key: formData.amap.key,
    })
    return `https://restapi.amap.com/v3/distance?${params}`
  }
  const [res0, res1, res3] = await Promise.all([
    modes.straight
      ? (request.get({ url: createDistanceUrl('0') }) as Promise<AmapDistance | AmapError>)
      : null,
    modes.driving
      ? (request.get({ url: createDistanceUrl('1') }) as Promise<AmapDistance | AmapError>)
      : null,
    modes.walking
      ? (request.get({ url: createDistanceUrl('3') }) as Promise<AmapDistance | AmapError>)
      : null,
  ])

  const data = {
    straight: { ok: false, distance: 0, duration: 0 },
    driving: { ok: false, distance: 0, duration: 0 },
    walking: { ok: false, distance: 0, duration: 0 },
  }

  Object.assign(data.straight, parseDistanceResult(res0) ?? {})
  Object.assign(data.driving, parseDistanceResult(res1) ?? {})
  Object.assign(data.walking, parseDistanceResult(res3) ?? {})
  return data
}
