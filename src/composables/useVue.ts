import type { Ref } from 'vue'
import { ref, toValue } from 'vue'

const rootVue = ref()
interface VueDataHookSubscriber<T = any> {
  data: Ref<T>
  update?: (val: T) => void
}

interface VueDataHookState {
  subscribers: Set<VueDataHookSubscriber>
}

const vueDataHooks = new WeakMap<object, Map<string, VueDataHookState>>()

function waitForVue(selectors: string, message: string, signal?: AbortSignal, intervalMs = 100) {
  signal?.throwIfAborted()
  return new Promise<any>((resolve, reject) => {
    let interval: ReturnType<typeof setInterval>
    let timeout: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearInterval(interval)
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const read = () => {
      const instance = document.querySelector<any>(selectors)?.__vue__
      if (instance == null) return
      cleanup()
      resolve(instance)
    }
    signal?.addEventListener('abort', abort, { once: true })
    interval = setInterval(read, intervalMs)
    timeout = setTimeout(() => {
      cleanup()
      reject(new Error(message))
    }, 20000)
    read()
  })
}

export async function getRootVue(signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted()
  if (rootVue.value !== undefined) return rootVue.value
  rootVue.value = await waitForVue('#wrap', '未找到vue根组件', signal, 300)
  return rootVue.value
}

export function useHookVueData<T = any>(
  selectors: string,
  key: string,
  data: Ref<T>,
  update?: (val: T) => void,
) {
  const subscriber: VueDataHookSubscriber<T> = { data, update }
  return async (signal?: AbortSignal) => {
    const jobVue = await waitForVue(selectors, '未找到对应元素', signal)
    signal?.throwIfAborted()

    data.value = jobVue[key]
    update?.(toValue(jobVue[key] as T))
    let instanceHooks = vueDataHooks.get(jobVue)
    if (instanceHooks == null) {
      instanceHooks = new Map()
      vueDataHooks.set(jobVue, instanceHooks)
    }
    const existingHook = instanceHooks.get(key)
    if (existingHook != null) {
      existingHook.subscribers.add(subscriber)
      return jobVue
    }

    // eslint-disable-next-line no-restricted-properties
    const originalGet = jobVue.__lookupGetter__(key)
    // eslint-disable-next-line no-restricted-properties
    const originalSet = jobVue.__lookupSetter__(key)
    let currentValue = jobVue[key]
    const state: VueDataHookState = {
      subscribers: new Set([subscriber]),
    }
    Object.defineProperty(jobVue, key, {
      configurable: true,
      get() {
        return originalGet ? originalGet.call(this) : currentValue
      },
      set(val: T) {
        if (originalSet) originalSet.call(this, val)
        else currentValue = val
        const nextValue = originalGet ? originalGet.call(this) : val
        for (const currentSubscriber of state.subscribers) {
          currentSubscriber.data.value = nextValue
          currentSubscriber.update?.(nextValue)
        }
      },
    })
    instanceHooks.set(key, state)
    return jobVue
  }
}

export function useHookVueFn(selectors: string, key: string | string[]) {
  return async (signal?: AbortSignal) => {
    const jobVue = await waitForVue(selectors, '未找到对应元素', signal)
    signal?.throwIfAborted()

    const bindVueFn = (fn: any) => (typeof fn === 'function' ? fn.bind(jobVue) : fn)
    if (Array.isArray(key)) {
      for (const k of key) {
        if (jobVue[k]) {
          return bindVueFn(jobVue[k])
        }
      }
    } else {
      return bindVueFn(jobVue[key])
    }
  }
}
