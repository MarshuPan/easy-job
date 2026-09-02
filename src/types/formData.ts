import type { prompt } from '@/types/aiProtocol'

export interface Statistics {
  date: string
  success: number
  searchSuccess?: number
  groupSuccess?: number
  searchTotal?: number
  groupTotal?: number
  searchFiltered?: number
  groupFiltered?: number
  total: number
  jobContent: number
  aiFiltering: number
  amap: number
  companySizeRange: number
  activityFilter: number
  goldHunterFilter: number
  repeat: number
}

export interface FormData {
  jobContent: FormDataSelect
  companySizeRange: FormDataRangeInput
  customGreeting: FormDataInput
  deliveryLimit: FormDataDeliveryLimit
  jobSources: FormDataJobSources
  searchConditions: FormDataSearchConditions
  activityFilter: FormDataCheckbox
  friendStatus: FormDataCheckbox
  sameCompanyFilter: FormDataCheckbox
  sameHrFilter: FormDataCheckbox
  goldHunterFilter: FormDataCheckbox
  useCache: FormDataCheckbox
  aiGreeting: FormDataAiGreeting
  aiFiltering: FormDataAi & { score: number }
  amap: {
    key: string
    origins: string
    straightDistance: number
    drivingDistance: number
    drivingDuration: number
    walkingDistance: number
    walkingDuration: number
    enable: boolean
  }
  record: { model?: string[]; enable: boolean }
  // animation?: "frame" | "card" | "together";
  delay: ConfDelay
  version: string
  userId?: number | string
}

export type FormInfoData = {
  [key in keyof Omit<
    FormData,
    | 'aiGreeting'
    | 'aiFiltering'
    | 'delay'
    | 'userId'
    | 'version'
    | 'amap'
    | 'jobSources'
    | 'searchConditions'
  >]: {
    label: string
    'data-help'?: string
  }
} & {
  aiGreeting: FormInfoAi
  aiFiltering: FormInfoAi
  delay: ConfInfoDelay
  amap: {
    [key in keyof FormData['amap']]: {
      label: string
      'data-help'?: string
    }
  }
}

export interface FormInfoAi {
  label: string
  'data-help'?: string
  example: [string, prompt]
}

export interface FormDataSelect {
  include: boolean
  value: string[]
  options: string[]
  enable: boolean
}

export interface FormDataInput {
  value: string
  enable: boolean
}

export type FormDataRange = [number, number, boolean]

export interface FormDataRangeInput {
  value: FormDataRange
  enable: boolean
}

export interface FormSalaryRangeInput {
  // 宽松/严格 默认宽松false
  value: FormDataRange // 8-13K
  advancedValue: {
    H: FormDataRange // 45-75元/时
    D: FormDataRange // 360-600元/天
    M: FormDataRange // 8000-13000元/月
  }
  enable: boolean
}

export interface FormDataInputNumber {
  value: number
}

export interface FormDataDeliveryLimit {
  search: number
  group: number
}

export interface FormDataJobSources {
  searchEnabled: boolean
  recommendEnabled: boolean
  enabledExpectIds: string[]
  expectationsInitialized: boolean
}

export interface FormDataSearchConditions {
  directions: string[]
  city: string
  businessDistricts: string[]
  salary: string
  experience: string[]
  degree: string[]
  jobType: string[]
}

export interface FormDataCheckbox {
  value: boolean
}

export interface FormDataAi {
  model?: string
  vip?: boolean
  prompt: string | prompt
  enable: boolean
}

export interface FormDataAiGreeting extends FormDataAi {
  messageCount: number
  prompt: string
  targetTotalCharacters: number
}

interface ConfDelay {
  deliveryInterval: number
  deliveryIntervalMax: number
  messageSending: number
  greetingSegment: number
  batchSize: number
  batchRestMinutes: number
}

type ConfInfoDelay = {
  [Key in keyof ConfDelay]: {
    label: string
    'data-help'?: string
    disable?: boolean
  }
}
