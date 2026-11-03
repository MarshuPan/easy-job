import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue'

import { counter } from '@/message'
import { LAUNCHER_POSITION_STORAGE_KEY } from '@/message/storageKeys'
import { logger } from '@/utils/logger'

interface LauncherPosition {
  x: number
  y: number
}

export function useLauncherDrag(launcher: Ref<HTMLButtonElement | undefined>) {
  const position = ref<LauncherPosition | null>(null)
  const dragging = ref(false)
  let drag: { pointerId: number; clientX: number; clientY: number; x: number; y: number } | null =
    null
  let interacted = false
  let disposed = false
  let suppressClick = false

  function clamp(value: LauncherPosition): LauncherPosition {
    return {
      x: Math.max(0, Math.min(window.innerWidth - (launcher.value?.offsetWidth || 54), value.x)),
      y: Math.max(0, Math.min(window.innerHeight - (launcher.value?.offsetHeight || 54), value.y)),
    }
  }

  async function restorePosition() {
    try {
      const saved = await counter.storageGet<LauncherPosition>(LAUNCHER_POSITION_STORAGE_KEY)
      // A delayed storage reply must not move the logo under an active pointer.
      if (disposed || interacted || saved == null) return
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) position.value = clamp(saved)
    } catch (error) {
      logger.warn('读取悬浮入口位置失败', error)
    }
  }

  function startDrag(event: PointerEvent) {
    if (event.button !== 0 || event.isPrimary === false || drag != null || !launcher.value) return
    const bounds = launcher.value.getBoundingClientRect()
    interacted = true
    suppressClick = false
    drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: position.value?.x ?? bounds.left,
      y: position.value?.y ?? bounds.top,
    }
    launcher.value.setPointerCapture?.(event.pointerId)
  }

  function moveDrag(event: PointerEvent) {
    if (drag == null || event.pointerId !== drag.pointerId) return
    const dx = event.clientX - drag.clientX
    const dy = event.clientY - drag.clientY
    // Small hand movements remain clicks; actual drags never open the panel.
    if (!dragging.value && Math.hypot(dx, dy) < 5) return
    event.preventDefault()
    dragging.value = true
    suppressClick = true
    position.value = clamp({ x: drag.x + dx, y: drag.y + dy })
  }

  function stopDrag() {
    if (drag == null) return
    const pointerId = drag.pointerId
    const moved = dragging.value
    drag = null
    dragging.value = false
    if (launcher.value?.hasPointerCapture?.(pointerId)) {
      launcher.value.releasePointerCapture(pointerId)
    }
    if (moved && position.value != null) {
      void counter
        .storageSet(LAUNCHER_POSITION_STORAGE_KEY, { ...position.value })
        .catch((error) => {
          logger.warn('保存悬浮入口位置失败', error)
        })
    }
  }

  function endDrag(event: PointerEvent) {
    if (event.pointerId !== drag?.pointerId) return
    moveDrag(event)
    stopDrag()
  }

  function cancelDrag(event: PointerEvent) {
    if (event.pointerId === drag?.pointerId) stopDrag()
  }

  function consumeDragClick(event: MouseEvent) {
    const consumed = suppressClick && event.detail !== 0
    suppressClick = false
    return consumed
  }

  function keepVisible() {
    stopDrag()
    if (position.value != null) position.value = clamp(position.value)
  }

  onMounted(() => {
    window.addEventListener('resize', keepVisible)
    window.addEventListener('blur', stopDrag)
  })
  onUnmounted(() => {
    disposed = true
    stopDrag()
    window.removeEventListener('resize', keepVisible)
    window.removeEventListener('blur', stopDrag)
  })

  return {
    launcherStyle: computed(() =>
      position.value == null
        ? undefined
        : { left: `${position.value.x}px`, top: `${position.value.y}px`, bottom: 'auto' },
    ),
    dragging,
    restorePosition,
    startDrag,
    moveDrag,
    endDrag,
    cancelDrag,
    consumeDragClick,
  }
}
