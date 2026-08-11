import { storage } from '#imports'
import { CONFIG_STORAGE_KEY, type StoredConfigStateV1 } from '@/config/types'

export interface ConfigStateStorage {
  read(): Promise<unknown | null>
  write(state: StoredConfigStateV1): Promise<void>
}

export function createBrowserConfigStorage(): ConfigStateStorage {
  return {
    read() {
      return storage.getItem(CONFIG_STORAGE_KEY)
    },
    async write(state) {
      await storage.setItem(CONFIG_STORAGE_KEY, state)
    },
  }
}
