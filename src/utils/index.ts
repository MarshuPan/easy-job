// 动画
export function animate({
  duration,
  draw,
  timing,
  end,
  callId,
}: {
  duration: number
  draw: (progress: number) => void
  timing: (timeFraction: number) => number
  callId: (id: number) => void
  end?: () => void
}) {
  const start = performance.now()

  callId(
    requestAnimationFrame(function animate(time) {
      let timeFraction = (time - start) / duration
      if (timeFraction > 1) timeFraction = 1

      const progress = timing(timeFraction)

      draw(progress)

      if (timeFraction < 1) {
        callId(requestAnimationFrame(animate))
      } else if (end) {
        end()
      }
    }),
  )
}
let delayLoadId: number | undefined

// 延迟
export async function delay(s: number) {
  loader({ ms: s * 1000 })
  return new Promise((resolve) => setTimeout(resolve, s * 1000))
}

// 加载进度条
export function loader({ ms = 10000, color = '#7fa8ff', onDone = () => {} }) {
  const root = document.querySelector<HTMLElement>('#agent-delivery-job')
  if (!root) return () => {}

  let load = root.querySelector<HTMLDivElement>(':scope > #agent-delivery-loader')
  if (!load) {
    const l = document.createElement('div')
    l.id = 'agent-delivery-loader'
    l.setAttribute('aria-hidden', 'true')
    root.appendChild(l)
    load = l
  }
  load.style.background = color
  if (delayLoadId != null) {
    cancelAnimationFrame(delayLoadId)
    delayLoadId = undefined
  }
  animate({
    duration: ms,
    callId(id) {
      delayLoadId = id
    },
    timing(timeFraction) {
      return timeFraction
    },
    draw(progress) {
      load.style.width = `${progress * 100}%`
    },
    end() {
      load.style.width = '0%'
      onDone()
    },
  })

  return () => {
    if (delayLoadId != null) {
      cancelAnimationFrame(delayLoadId)
      delayLoadId = undefined
    }
    const load = root.querySelector<HTMLDivElement>(':scope > #agent-delivery-loader')
    if (load) load.style.width = '0%'
  }
}

// 获取当前日期
export function getCurDay(currentDate = new Date()) {
  const year = currentDate.getFullYear()
  const month = String(currentDate.getMonth() + 1).padStart(2, '0')
  const day = String(currentDate.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 获取当前时间
export function getCurTime(currentDate = new Date()) {
  const hours = String(currentDate.getHours()).padStart(2, '0')
  const minutes = String(currentDate.getMinutes()).padStart(2, '0')
  const seconds = String(currentDate.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}
