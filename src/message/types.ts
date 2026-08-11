import type { Browser } from '#imports'
import type { PublicRuntimeConfig, PublicConfigReadiness } from '@/background/configService'
import type {
  DeliveryTaskCheckpointRequest,
  DeliveryTaskMutationResult,
  DeliveryTaskStartRequest,
  DeliveryTaskTerminateRequest,
  DeliveryTaskWorkerRequest,
  DurableDeliveryTask,
} from '@/background/deliveryTaskCoordinator'
import type { JobExpectationConfig } from '@/config/types'
import type { messageReps } from '@/types/aiProtocol'
import type { FormData } from '@/types/formData'
import type { AiTaskData, AiTaskType } from '@/utils/backgroundAiProtocol'

export interface CookieInfo {
  uid: string
  user: string
  avatar: string
  remark: string
  gender: 'man' | 'woman'
  flag: 'student' | 'staff'
  date: string
  form?: FormData
  statistics?: string
}

export interface AccountStateSnapshot {
  uid: string
  metadata: Pick<CookieInfo, 'user' | 'avatar' | 'remark' | 'gender' | 'flag' | 'date'>
  form?: Record<string, unknown> & { userId?: string | number }
  statistics?: string
}

export const DELIVERY_WORKER_IDENTITY_REQUEST_TYPE = 'agent-delivery:worker-identity:request'
export const DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE = 'agent-delivery:worker-identity:response'

export interface DeliveryWorkerIdentityRequest {
  type: typeof DELIVERY_WORKER_IDENTITY_REQUEST_TYPE
  sessionToken: string
}

export interface DeliveryWorkerIdentityResponse {
  type: typeof DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE
  workerId: string
}

export function isDeliveryWorkerIdentityRequest(
  value: unknown,
): value is DeliveryWorkerIdentityRequest {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return false
  const request = value as Partial<DeliveryWorkerIdentityRequest>
  return (
    request.type === DELIVERY_WORKER_IDENTITY_REQUEST_TYPE &&
    typeof request.sessionToken === 'string' &&
    /^[A-Za-z0-9-]{8,80}$/.test(request.sessionToken)
  )
}

export type UserConf = Record<
  string,
  {
    info: CookieInfo
    cookies: Browser.cookies.Cookie[]
  }
>

export interface BackgroundCounterApi {
  accountState(uid: string): Promise<AccountStateSnapshot | null>
  cookieInfo(): Promise<Record<string, CookieInfo>>
  cookieSwitch(uid: string): Promise<boolean>
  cookieSave(info: CookieInfo): Promise<boolean>
  cookieDelete(uid: string): Promise<boolean>
  cookieClear(): Promise<boolean>
  openChatTab(url: string): Promise<{
    tabId?: number
    reused: boolean
    url: string
    active?: boolean
    reloaded?: boolean
    loaded?: boolean
  }>
  runAiTask(args: {
    task: AiTaskType
    data: AiTaskData
    json?: boolean
  }): Promise<Omit<messageReps, 'prompt'>>
  configRuntime(uid: string): Promise<PublicRuntimeConfig>
  configAiTasksSave(tasks: {
    aiFiltering?: { enabled?: boolean; score?: number }
    aiGreeting?: {
      enabled?: boolean
      messageCount?: number
      targetTotalCharacters?: number
      prompt?: string
    }
  }): Promise<import('@/background/configService').PublicConfigReadiness>
  configAiGreetingDisable(): Promise<import('@/background/configService').PublicConfigReadiness>
  configRuntimeSave(
    uid: string,
    formData: unknown,
    expectations?: JobExpectationConfig[],
  ): Promise<PublicConfigReadiness>
  deliveryTaskRead(uid: string): Promise<DurableDeliveryTask | null>
  deliveryTaskStart(request: DeliveryTaskStartRequest): Promise<DeliveryTaskMutationResult>
  deliveryTaskClaim(request: DeliveryTaskWorkerRequest): Promise<DeliveryTaskMutationResult>
  deliveryTaskCheckpoint(
    request: DeliveryTaskCheckpointRequest,
  ): Promise<DeliveryTaskMutationResult>
  deliveryTaskRelease(request: DeliveryTaskWorkerRequest): Promise<DeliveryTaskMutationResult>
  deliveryTaskPause(request: DeliveryTaskWorkerRequest): Promise<DeliveryTaskMutationResult>
  deliveryTaskResume(request: DeliveryTaskWorkerRequest): Promise<DeliveryTaskMutationResult>
  deliveryTaskTerminate(request: DeliveryTaskTerminateRequest): Promise<DeliveryTaskMutationResult>
  backgroundTest(type: 'success' | 'error'): Promise<number>
}

export interface ContentCounterApi extends Pick<
  BackgroundCounterApi,
  | 'accountState'
  | 'backgroundTest'
  | 'configRuntime'
  | 'configRuntimeSave'
  | 'configAiTasksSave'
  | 'configAiGreetingDisable'
  | 'deliveryTaskRead'
  | 'deliveryTaskStart'
  | 'deliveryTaskClaim'
  | 'deliveryTaskCheckpoint'
  | 'deliveryTaskRelease'
  | 'deliveryTaskPause'
  | 'deliveryTaskResume'
  | 'deliveryTaskTerminate'
  | 'openChatTab'
> {
  deliveryWorkerIdentity(sessionToken: string): Promise<string>
  storageGet<T>(key: string, defaultValue: T): Promise<T>
  storageGet<T>(key: string): Promise<T | null>
  storageSet<T>(key: string, value: T): Promise<boolean>
  storageRm(key: string): Promise<boolean>
  storageUsage(): Promise<{ bytesInUse: number; quotaBytes: number } | null>
  contentScriptTest(type: 'success' | 'error'): Promise<number>
}
