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

export async function getRootVue(): Promise<any> {
  if (rootVue.value !== undefined) {
    return rootVue.value
  }

  const waitVueMount = async () => {
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        const wrap = document.querySelector('#wrap')
        if (rootVue.value !== undefined) {
          return resolve(rootVue.value)
        }
        if (wrap && '__vue__' in wrap) {
          rootVue.value = wrap.__vue__
          resolve(rootVue.value)
          clearInterval(interval)
        }
      }, 300)
      setTimeout(() => {
        reject(new Error('未找到vue根组件'))
        clearInterval(interval)
      }, 20000)
    })
  }

  await waitVueMount()
  return rootVue.value
}

export function useHookVueData<T = any>(
  selectors: string,
  key: string,
  data: Ref<T>,
  update?: (val: T) => void,
) {
  const subscriber: VueDataHookSubscriber<T> = { data, update }
  return async () => {
    const jobVue = await new Promise<any>((resolve, reject) => {
      const interval = setInterval(() => {
        const jobVue = document.querySelector<any>(selectors)?.__vue__
        if (jobVue) {
          resolve(jobVue)
          clearInterval(interval)
        }
      }, 100)
      setTimeout(() => {
        reject(new Error('未找到对应元素'))
        clearInterval(interval)
      }, 20000)
    })

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
  return async () => {
    const jobVue = await new Promise<any>((resolve, reject) => {
      const interval = setInterval(() => {
        const jobVue = document.querySelector<any>(selectors)?.__vue__
        if (jobVue) {
          resolve(jobVue)
          clearInterval(interval)
        }
      }, 100)
      setTimeout(() => {
        reject(new Error('未找到对应元素'))
        clearInterval(interval)
      }, 20000)
    })
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
