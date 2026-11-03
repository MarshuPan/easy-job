/**
 * 1.3.7 之前，每次正常的 AI 请求都会在运行日志里记「已发出」「已完成」两条，处理中的
 * 后台任务还会再记进度。现在只记失败、重试、慢请求和协议降级，但老记录还留在存储里：
 * 新记录少了，它们就永远挤不出去，真机上 200 条里有 180 条是它们。
 *
 * 按消息原文识别，不按状态：简历解析结果、配置保存这类记录同样是 success，
 * 但它们是用户要看的。
 */
const routineAiRequestMessage = /^(?:模型请求完成|模型请求已发出（.+）|模型任务.+)$/u

export function isRoutineAiRuntimeRecord(record: { message?: string; state?: string }) {
  if (record.state === 'warning' || record.state === 'danger') return false
  return typeof record.message === 'string' && routineAiRequestMessage.test(record.message)
}
