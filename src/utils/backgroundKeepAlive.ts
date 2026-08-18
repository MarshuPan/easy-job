/**
 * MV3 的 background 是 service worker，空闲约 30 秒就被浏览器回收。
 *
 * 投递流程里有大量不发 RPC 的长等待：动作闸门限速（实测出现过 197 秒）、AI 匹配请求
 * （实测单次 144 秒，还有 180 秒超时的）、翻页等待（40 秒上下）。等待期间 worker 被
 * 回收，等到要写检查点时 RPC 心跳 5 秒超时，报
 * `Provider unavailable: heartbeat check timeout 5000ms`。
 *
 * 后果不只是日志里多一条告警：检查点没落盘，下次恢复时那个岗位的状态就是未知的，
 * 界面上表现为「上次运行中断，结果不确定，请人工核对后再处理」——用户得自己去
 * BOSS 上翻聊天列表确认投没投。
 *
 * 任何一次扩展消息都会重置 worker 的空闲计时，所以只要在投递运行期间定期发一次
 * 空调用就够。没有用 chrome.alarms：它需要额外权限，最小周期又恰好是 30 秒，
 * 和回收阈值卡在同一个边界上。
 */

/** 留出足够余量：30 秒回收，20 秒一次意味着即便丢一拍也还有一次机会。 */
export const KEEP_ALIVE_INTERVAL_MS = 20_000

type Ping = () => Promise<unknown>

interface KeepAliveHandle {
  stop: () => void
}

/**
 * 开始保活，返回停止句柄。重复调用会先停掉上一个，不会叠加定时器。
 *
 * ping 失败被吞掉：worker 正在重启时这次调用本来就会失败，而下一拍会把它唤醒，
 * 没必要把这个中间态冒泡成用户可见的错误。
 */
export function startBackgroundKeepAlive(
  ping: Ping,
  intervalMs: number = KEEP_ALIVE_INTERVAL_MS,
): KeepAliveHandle {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    // ping 同步发起——推迟到微任务没有好处，只会让「这一拍到底发出去没有」变得难以判断。
    try {
      void Promise.resolve(ping()).catch(() => {})
    } catch {
      // 同步抛出（比如扩展上下文已失效）同样吞掉，等下一拍。
    }
  }, intervalMs)

  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
  }
}
