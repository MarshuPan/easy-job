import { getErrorMessage } from './providerHealth'

/**
 * BOSS 明确表态的风控拦截。
 *
 * 详情接口在被拦时返回 code≠0，message 是「您的环境存在异常.」。这条和其它取详情失败
 * 有本质区别：它不是这个岗位的问题，是账号已经被标记，而且两轮真机数据里，同一次运行
 * 内一旦出现就再没恢复过——
 *
 *   11:12:01 ✗ → 11:15:28 ✗ → 11:16:00 ✗
 *   14:08:15 ✗ → 14:08:30 ✗ → 14:08:55 ✗
 *
 * 第二轮里 14:08:15 那次前面还等了 186 秒，配额窗口该滚过去了，仍然被拒。所以它不是
 * 速率限制，降速和等待都没用（见 actionGate 里详情硬顶那段注释）。
 *
 * 通用的「连续 3 个无法评估才停」对未知错误是对的：连着三个恰好同时下线讲不通，但停之前
 * 得先把话说清楚。而这条错误 BOSS 已经说清楚了，再敲两次门只是在已被标记的状态下继续
 * 暴露，救不回这次运行。
 *
 * 只匹配这一条，不做泛化。漏判退回三振出局，是可接受的降级；误判会把正常运行拦腰截断，
 * 代价大得多。
 */
const riskControlMarkers = ['环境存在异常']

export function isRiskControlMessage(value: unknown) {
  // 复用 getErrorMessage：错误跨越扩展消息边界后会退化成只剩 message 的普通对象，
  // 自己写 `value instanceof Error` 那一套正好在这种情况下漏判。
  return riskControlMarkers.some((marker) => getErrorMessage(value).includes(marker))
}
