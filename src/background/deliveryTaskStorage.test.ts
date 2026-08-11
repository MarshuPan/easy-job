import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getItem, setItem } = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}))

vi.mock('#imports', () => ({
  storage: {
    getItem,
    setItem,
  },
}))

import {
  createBrowserDeliveryTaskStorage,
  DELIVERY_TASK_STORAGE_KEY,
  LEGACY_DELIVERY_TASK_STORAGE_KEY,
} from './deliveryTaskStorage'

describe('deliveryTaskStorage', () => {
  beforeEach(() => {
    getItem.mockReset()
    setItem.mockReset()
  })

  it('reads the v2 authority without consulting the legacy snapshot', async () => {
    const current = { 'account-a': { schemaVersion: 2 } }
    getItem.mockResolvedValueOnce(current)

    await expect(createBrowserDeliveryTaskStorage().read()).resolves.toEqual(current)
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(getItem).toHaveBeenCalledWith(DELIVERY_TASK_STORAGE_KEY)
  })

  it('falls back to the retained v1 snapshot when v2 has not been written yet', async () => {
    const legacy = { 'account-a': { schemaVersion: 1 } }
    getItem.mockResolvedValueOnce(null).mockResolvedValueOnce(legacy)

    await expect(createBrowserDeliveryTaskStorage().read()).resolves.toEqual(legacy)
    expect(getItem).toHaveBeenNthCalledWith(1, DELIVERY_TASK_STORAGE_KEY)
    expect(getItem).toHaveBeenNthCalledWith(2, LEGACY_DELIVERY_TASK_STORAGE_KEY)
  })

  it('writes migrated state only to the v2 authority key', async () => {
    const tasks = {}

    await createBrowserDeliveryTaskStorage().write(tasks)

    expect(setItem).toHaveBeenCalledWith(DELIVERY_TASK_STORAGE_KEY, tasks)
    expect(setItem).not.toHaveBeenCalledWith(LEGACY_DELIVERY_TASK_STORAGE_KEY, tasks)
  })
})
