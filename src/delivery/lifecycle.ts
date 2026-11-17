import { shallowRef } from 'vue'

export type DeliveryCommandKind = 'start' | 'resume' | 'recover' | 'pause' | 'stop'
export interface DeliveryCommand {
  readonly kind: DeliveryCommandKind
}
export interface DeliveryRun {
  readonly abort: AbortController
  readonly settled: Promise<void>
  readonly finish: () => void
}
export interface ManualDeliveryControl {
  kind: 'pause' | 'stop'
  accountUid: string
  taskId?: string
}

/** Page execution ownership and ordered control commands; durable task state stays in the background. */
export class DeliveryLifecycle {
  readonly command = shallowRef<DeliveryCommand | null>(null)
  readonly run = shallowRef<DeliveryRun | null>(null)
  readonly pendingControl = shallowRef<ManualDeliveryControl | null>(null)
  private tail: Promise<unknown> = Promise.resolve()

  begin(kind: DeliveryCommandKind): DeliveryCommand | null {
    const current = this.command.value?.kind
    if (current === 'stop') return null
    if (kind === 'recover' && current != null) return null
    if ((kind === 'start' || kind === 'resume') && current != null && current !== 'recover')
      return null
    if (kind === 'pause' && current === 'pause') return null
    const command = { kind }
    this.command.value = command
    return command
  }

  isCurrent(command: DeliveryCommand) {
    return this.command.value === command
  }

  complete(command: DeliveryCommand) {
    if (this.isCurrent(command)) this.command.value = null
  }

  async serialize<T>(command: DeliveryCommand, action: () => Promise<T>): Promise<T | undefined> {
    const pending = this.tail.then(() => {
      if (this.isCurrent(command)) return action()
    })
    this.tail = pending.catch(() => undefined)
    try {
      return await pending
    } finally {
      this.complete(command)
    }
  }

  acquire(): DeliveryRun | null {
    if (this.run.value != null) return null
    let finish!: () => void
    const settled = new Promise<void>((resolve) => {
      finish = resolve
    })
    const run = { abort: new AbortController(), settled, finish }
    this.run.value = run
    return run
  }

  interrupt() {
    this.run.value?.abort.abort()
  }

  release(run: DeliveryRun) {
    if (this.run.value !== run) return
    this.run.value = null
    run.finish()
  }

  async drain() {
    await this.run.value?.settled
  }

  detach() {
    this.interrupt()
    // Already requested pause/stop must finish saving even if the panel unmounts.
    if (this.command.value?.kind !== 'pause' && this.command.value?.kind !== 'stop')
      this.command.value = null
  }
}

// All controls on the same page, including single-job retries, share execution ownership.
const pageLifecycles = new WeakMap<object, DeliveryLifecycle>()
export function getDeliveryLifecycle(page: object) {
  let lifecycle = pageLifecycles.get(page)
  if (lifecycle == null) {
    lifecycle = new DeliveryLifecycle()
    pageLifecycles.set(page, lifecycle)
  }
  return lifecycle
}
