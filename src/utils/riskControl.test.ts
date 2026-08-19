import { describe, expect, it } from 'vitest'

import { JobUnavailableError } from '@/types/deliverError'

import { isRiskControlMessage } from './riskControl'

describe('isRiskControlMessage', () => {
  // 真机上原样出现的那条，含尾部句号。
  it('recognizes the message BOSS actually returns', () => {
    expect(isRiskControlMessage('详情接口返回异常：您的环境存在异常.')).toBe(true)
  })

  // 实际到达判断点时已经被 JobUnavailableError 包了一层，前缀也换了。
  it('sees through the JobUnavailableError wrapper', () => {
    const error = new JobUnavailableError(
      '取岗位详情失败，已跳过该岗位：详情接口返回异常：您的环境存在异常.',
    )
    expect(isRiskControlMessage(error)).toBe(true)
  })

  // 方向不对称：漏判退回三振出局只是慢一点，误判会把正常运行拦腰截断。
  // 下面这些都是取详情可能失败的其它原因，一个都不能命中。
  it.each([
    ['岗位下线', '取岗位详情失败，已跳过该岗位：详情接口返回异常：职位已关闭'],
    ['接口返回码', '取岗位详情失败，已跳过该岗位：详情接口返回异常：1'],
    ['网络失败', '取岗位详情失败，已跳过该岗位：Failed to fetch'],
    ['登录态失效', '取岗位详情失败，已跳过该岗位：详情接口返回异常：请先登录'],
    ['闸门超时', '动作闸门等待超时：detail 已等待 900 秒'],
    ['AI 服务异常', '后台AI请求失败（HTTP 502）'],
    ['空消息', ''],
  ])('does not fire on %s', (_label, message) => {
    expect(isRiskControlMessage(message)).toBe(false)
  })

  // 错误跨越扩展消息边界后只剩一个带 message 的普通对象，原型没了。
  // 这正是真机上后台把错误传回内容脚本时的形态，不能在这里漏判。
  it('still fires on a plain object that lost its Error prototype', () => {
    expect(isRiskControlMessage({ message: '详情接口返回异常：您的环境存在异常.' })).toBe(true)
  })

  it('tolerates empty inputs', () => {
    expect(isRiskControlMessage(null)).toBe(false)
    expect(isRiskControlMessage(undefined)).toBe(false)
    expect(isRiskControlMessage({})).toBe(false)
  })
})
