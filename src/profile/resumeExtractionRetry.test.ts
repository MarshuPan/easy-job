import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiModelConfig } from '@/config/types'

const { runConfiguredAiTask } = vi.hoisted(() => ({ runConfiguredAiTask: vi.fn() }))

vi.mock('@/utils/backgroundAi', () => ({ runConfiguredAiTask }))

import { extractResumeEvidence } from './resumeExtraction'

const model = { id: 'm', protocol: 'openai-responses' } as unknown as AiModelConfig

describe('resume extraction retry budget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    runConfiguredAiTask.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops after the retry instead of hammering a permanent failure', async () => {
    // 重试是为瞬时故障准备的。鉴权失败这类永久错误重试一次就够，
    // 再多只是让用户多等几分钟才看到同一个错误。
    runConfiguredAiTask.mockImplementation(async () => {
      throw new Error('AI请求失败，状态码: 401')
    })

    const settled = extractResumeEvidence({ markdown: '简历原文', model }).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.runAllTimersAsync()

    expect(await settled).toContain('401')
    expect(runConfiguredAiTask).toHaveBeenCalledTimes(2)
  })

  it('waits before retrying so a rate limit is not hit again immediately', async () => {
    runConfiguredAiTask.mockImplementation(async () => {
      throw new Error('AI请求失败，状态码: 429')
    })

    const settled = extractResumeEvidence({ markdown: '简历原文', model }).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(runConfiguredAiTask).toHaveBeenCalledTimes(1)

    await vi.runAllTimersAsync()
    expect(await settled).toContain('429')
    expect(runConfiguredAiTask).toHaveBeenCalledTimes(2)
  })

  it('refuses to store evidence whose facts were all unusable', async () => {
    // 过滤掉缺原文的事实之后可能一条不剩。存下去就是一份空证据：
    // 匹配阶段对每个岗位都判不匹配，而界面只显示「解析成功」。
    runConfiguredAiTask.mockResolvedValue({
      content: JSON.stringify({
        facts: [{ id: 'a', action: '负责', object: 'x' }],
        buckets: [],
        claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
      }),
    })

    const settled = extractResumeEvidence({ markdown: '简历原文', model }).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.runAllTimersAsync()

    expect(await settled).toContain('没有可用的事实')
  })
})

describe('what is worth retrying', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    runConfiguredAiTask.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not retry a response that simply had no usable facts', async () => {
    // 这是对模型输出的结论，不是瞬时故障。重试它只会让用户为一个大概率相同的结果
    // 再等一轮几分钟。
    runConfiguredAiTask.mockResolvedValue({
      content: JSON.stringify({
        facts: [],
        buckets: [],
        claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
      }),
    })

    const settled = extractResumeEvidence({ markdown: '简历原文', model }).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.runAllTimersAsync()

    expect(await settled).toContain('没有可用的事实')
    expect(runConfiguredAiTask).toHaveBeenCalledTimes(1)
  })
})
