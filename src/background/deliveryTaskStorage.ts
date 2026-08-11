import { storage } from '#imports'

import type { DeliveryTaskCoordinatorStorage, DurableDeliveryTask } from './deliveryTaskCoordinator'

export const DELIVERY_TASK_STORAGE_KEY = 'local:agent-delivery-runtime-v2'
export const LEGACY_DELIVERY_TASK_STORAGE_KEY = 'local:agent-delivery-runtime-v1'

export function createBrowserDeliveryTaskStorage(): DeliveryTaskCoordinatorStorage {
  return {
    async read() {
      const current = await storage.getItem(DELIVERY_TASK_STORAGE_KEY)
      if (current != null) return current
      return storage.getItem(LEGACY_DELIVERY_TASK_STORAGE_KEY)
    },
    async write(tasks: Record<string, DurableDeliveryTask>) {
      await storage.setItem(DELIVERY_TASK_STORAGE_KEY, tasks)
    },
  }
}
