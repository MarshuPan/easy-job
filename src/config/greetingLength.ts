import type { AiTaskConfig } from './types'

export const GREETING_LENGTH_VARIANCE = 25
export const GREETING_TARGET_MIN = 45
export const GREETING_TARGET_MAX = 475
// 默认话术分五部分（身份、项目、能力、价值、收尾），150 字只放得下两部分。
export const DEFAULT_GREETING_TARGET = 220

export function greetingTargetFromTask(task: AiTaskConfig['aiGreeting']) {
  return Math.round((Number(task.minTotalCharacters) + Number(task.maxTotalCharacters)) / 2)
}

export function greetingBoundsFromTarget(target: number) {
  if (!Number.isFinite(target)) {
    return {
      minTotalCharacters: Number.NaN,
      maxTotalCharacters: Number.NaN,
    }
  }
  const normalizedTarget = Math.min(
    GREETING_TARGET_MAX,
    Math.max(GREETING_TARGET_MIN, Math.round(target)),
  )
  return {
    minTotalCharacters: normalizedTarget - GREETING_LENGTH_VARIANCE,
    maxTotalCharacters: normalizedTarget + GREETING_LENGTH_VARIANCE,
  }
}

export function applyGreetingTarget(task: AiTaskConfig['aiGreeting'], target: number) {
  Object.assign(task, greetingBoundsFromTarget(target))
}
