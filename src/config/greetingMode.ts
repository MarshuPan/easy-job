import type { FormData } from '@/types/formData'

export type GreetingMode = 'none' | 'ai' | 'custom'
type GreetingForm = Partial<Pick<FormData, 'aiGreeting' | 'customGreeting'>>

/** The background saves both switches together and rejects conflicting imports. */
export function getGreetingMode(form: GreetingForm): GreetingMode {
  if (form.aiGreeting?.enable && form.customGreeting?.enable) {
    throw new Error('AI 招呼语与自定义招呼语不能同时开启')
  }
  if (form.customGreeting?.enable) return 'custom'
  return form.aiGreeting?.enable ? 'ai' : 'none'
}

/** A live disable cancels a pinned task; it never changes that task's mode or text. */
export function getRuntimeGreetingMode(pinned: GreetingForm, live: GreetingForm): GreetingMode {
  const mode = getGreetingMode(pinned)
  return mode === getGreetingMode(live) ? mode : 'none'
}
