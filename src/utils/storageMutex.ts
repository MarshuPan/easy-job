/**
 * 跨标签页的存储写入互斥。
 *
 * 同一个 BOSS 账号可能同时开着多个标签页，每个标签页都持有自己的内存副本。
 * 如果各自「拿内存快照整体覆写」同一个 storage key，后写的会静默丢掉前一个
 * 标签页刚写入的数据。互斥只保证写入有序；调用方仍必须在锁内重新读取并合并，
 * 否则覆盖依然会发生，只是变得有序。
 *
 * 返回的函数同时提供页面内串行队列，避免同一标签页内的并发写互相穿插。
 * `navigator.locks` 不可用时降级为仅页面内串行，与既有实现的行为一致。
 */
export function createStorageMutex(lockName: string) {
  let tail: Promise<unknown> = Promise.resolve()

  return function withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const locks = globalThis.navigator?.locks
      if (locks?.request) return await locks.request(lockName, operation)
      return await operation()
    }
    const queued = tail.then(run, run)
    tail = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }
}
