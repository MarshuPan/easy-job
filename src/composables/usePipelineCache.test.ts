import { beforeEach, describe, expect, it, vi } from 'vitest'

const { configRevisionState, confState, resumeState, storageData, storageSetMock, userIdState } =
  vi.hoisted(() => {
    const storageData = new Map<string, unknown>()
    return {
      configRevisionState: { value: 1 },
      confState: {
        get readiness() {
          return { configRevision: configRevisionState.value }
        },
        formData: {
          activityFilter: { value: true },
          aiFiltering: { enable: true, model: 'model-a', prompt: '', score: 60 },
          aiGreeting: { enable: false, model: undefined, prompt: '' },
          amap: { enable: false, origins: '' },
          company: { enable: false, include: false, value: [] },
          companySizeRange: { enable: false, value: [0, 0, false] },
          friendStatus: { value: true },
          goldHunterFilter: { value: false },
          hrPosition: { enable: false, include: true, value: [] },
          jobAddress: { enable: false, value: [] },
          jobContent: { enable: false, include: false, value: [] },
          jobTitle: { enable: true, include: true, value: ['AI 产品经理'] },
          salaryRange: { enable: false, value: [0, 0, false] },
          sameCompanyFilter: { value: true },
          sameHrFilter: { value: true },
        },
      },
      resumeState: { value: null as unknown },
      storageData,
      storageSetMock: vi.fn(async (key: string, value: unknown) => {
        storageData.set(key, value)
        return true
      }),
      userIdState: { value: 'account-a' as string | null },
    }
  })

vi.mock('@/message', () => ({
  counter: {
    storageGet: vi.fn(async (key: string, fallback?: unknown) =>
      storageData.has(key) ? storageData.get(key) : fallback,
    ),
    storageRm: vi.fn(async (key: string) => {
      storageData.delete(key)
      return true
    }),
    storageSet: storageSetMock,
  },
}))

vi.mock('@/stores/conf', () => ({
  useConf: () => confState,
}))

vi.mock('@/stores/user', () => ({
  useUser: () => ({
    getUserId: () => userIdState.value,
    resume: resumeState,
  }),
}))

vi.mock('@/composables/useApplying/handles', () => ({
  handles: vi.fn(),
}))

vi.mock('@/stores/log', () => ({
  addLogTrace: vi.fn(),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('@/ui/instrument', () => ({
  AgentMessage: { success: vi.fn() },
}))

import { cachePipelineResult, checkJobCache } from '@/composables/useApplying'
import { PipelineCacheManager } from '@/composables/usePipelineCache'

describe('pipeline cache scope', () => {
  beforeEach(() => {
    storageData.clear()
    configRevisionState.value = 1
    userIdState.value = 'account-a'
    confState.formData.aiFiltering.score = 60
    resumeState.value = null
    storageSetMock.mockReset().mockImplementation(async (key: string, value: unknown) => {
      storageData.set(key, value)
      return true
    })
  })

  it('keeps completed-job cache stable across config changes and isolates accounts', async () => {
    await cachePipelineResult(
      'job-1',
      'AI 产品经理',
      '测试公司',
      'success',
      '筛选通过',
      'aiFiltering',
    )

    expect(checkJobCache('job-1')).not.toBeNull()

    confState.formData.aiFiltering.model = 'raw-private-model-key'
    confState.formData.aiFiltering.prompt = 'raw-private-filter-prompt'
    expect(checkJobCache('job-1')).not.toBeNull()

    configRevisionState.value = 2
    expect(checkJobCache('job-1')).not.toBeNull()

    configRevisionState.value = 1
    expect(checkJobCache('job-1')).not.toBeNull()

    resumeState.value = {
      prompt: 'raw-private-resume-prompt',
      skills: ['raw-private-resume-evidence'],
    }
    expect(checkJobCache('job-1')).not.toBeNull()

    confState.formData.aiFiltering.score = 75
    expect(checkJobCache('job-1')).not.toBeNull()

    confState.formData.aiFiltering.score = 60
    userIdState.value = 'account-b'
    expect(checkJobCache('job-1')).toBeNull()

    const serializedCache = JSON.stringify(storageData.get('local:pipeline-cache'))
    expect(serializedCache).not.toContain('raw-private-model-key')
    expect(serializedCache).not.toContain('raw-private-filter-prompt')
    expect(serializedCache).not.toContain('raw-private-resume-prompt')
    expect(serializedCache).not.toContain('raw-private-resume-evidence')
  })

  it('repairs a corrupt persisted cache blob instead of retaining it in memory', async () => {
    const storageKey = 'local:pipeline-cache-invalid'
    storageData.set(storageKey, { data: null, lastCleanup: 'invalid' })
    const manager = new PipelineCacheManager({ storageKey })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(() => manager.isValidCache('job-1', 'scope-a')).not.toThrow()
    expect(manager.isValidCache('job-1', 'scope-a')).toBe(false)
    expect(storageData.get(storageKey)).toEqual(
      expect.objectContaining({ data: {}, lastCleanup: expect.any(Number) }),
    )
  })

  it('serializes cache writes so an older delayed snapshot cannot overwrite a newer one', async () => {
    const storageKey = 'local:pipeline-cache-write-order'
    let releaseFirstWrite!: () => void
    storageSetMock.mockImplementationOnce(async (key: string, value: unknown) => {
      await new Promise<void>((resolve) => (releaseFirstWrite = resolve))
      storageData.set(key, value)
      return true
    })
    const manager = new PipelineCacheManager({ storageKey })
    await manager.ready()

    const first = manager.setCacheResult(
      'job-1',
      '岗位 1',
      '公司 1',
      'success',
      '投递成功',
      'uid:account-a',
    )
    await vi.waitFor(() => expect(releaseFirstWrite).toBeTypeOf('function'))
    const second = manager.setCacheResult(
      'job-2',
      '岗位 2',
      '公司 2',
      'success',
      '投递成功',
      'uid:account-a',
    )

    releaseFirstWrite()
    await Promise.all([first, second])

    expect(Object.values((storageData.get(storageKey) as any).data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ encryptJobId: 'job-1' }),
        expect.objectContaining({ encryptJobId: 'job-2' }),
      ]),
    )
  })
})
