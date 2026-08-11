import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { useHookVueData } from './useVue'

function mountRuntime(runtime: Record<string, unknown>) {
  const host = document.createElement('div')
  host.id = 'runtime'
  Object.assign(host, { __vue__: runtime })
  document.body.append(host)
}

describe('useHookVueData', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('reuses one property hook when the same binding is initialized repeatedly', async () => {
    const runtime = { jobs: ['first'] }
    mountRuntime(runtime)
    const data = ref<string[]>([])
    const update = vi.fn()
    const bind = useHookVueData('#runtime', 'jobs', data, update)

    await bind()
    await bind()
    update.mockClear()
    runtime.jobs = ['second']

    expect(data.value).toEqual(['second'])
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(['second'])
  })

  it('notifies distinct subscribers once through the shared property hook', async () => {
    const runtime = { jobs: ['first'] }
    mountRuntime(runtime)
    const firstData = ref<string[]>([])
    const secondData = ref<string[]>([])
    const firstUpdate = vi.fn()
    const secondUpdate = vi.fn()

    await useHookVueData('#runtime', 'jobs', firstData, firstUpdate)()
    await useHookVueData('#runtime', 'jobs', secondData, secondUpdate)()
    firstUpdate.mockClear()
    secondUpdate.mockClear()
    runtime.jobs = ['second']

    expect(firstData.value).toEqual(['second'])
    expect(secondData.value).toEqual(['second'])
    expect(firstUpdate).toHaveBeenCalledTimes(1)
    expect(secondUpdate).toHaveBeenCalledTimes(1)
  })
})
