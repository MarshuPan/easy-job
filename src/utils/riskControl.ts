import { getErrorMessage } from './providerHealth'

/**
 * 详情接口的拒绝服务。
 *
 * BOSS 在 job/detail.json 上返回 code≠0、message 为「您的环境存在异常.」时命中这里。
 *
 * 名字里的「风控」是它最初的判断，现在已知判重了：真机上出现这条时，用户在浏览器里
 * 翻页、看岗位一切正常，没有任何风控提示。被限的是这一个接口，不是账号。三轮数据里
 * 它也都会自行恢复——11:16 撞上，2.5 小时后重开又跑了 14 次。
 *
 * 但「立即停」这个处理仍然成立，因为等待被证伪了：
 *
 *   #11  11:29:23   前 5 分钟内 4 次   ✓
 *   #12  11:32:57   前 5 分钟内 4 次   ✗
 *
 * 第 12 次是等了 182 秒之后才发的，窗口从满降到不满、账号整整安静 3.6 分钟，照样被拒。
 * 次数上也一样：这轮 11 次、上轮 14 次，而两轮节奏几乎相同（1.08 与 1.10 次/分钟），
 * 慢没有换来更多。所以出现这条之后继续打，既救不回这一轮，也只是白耗。
 *
 * 到底是会话额度、Zp_token 失效还是 lid 过期，现在还分不清——因为三轮日志里全是同一句
 * message。jobs.ts 已经改成连 code 一起记，下一轮就能看到具体是哪种，处理方式也才好分开
 * （额度只能接受，token 和 lid 是可修的）。
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
