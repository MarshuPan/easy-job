import axios from 'axios'

import { addLogTrace } from '@/stores/log'
import type { logData } from '@/stores/log'
import {
  GreetError,
  AgentDeliveryError,
  LimitError,
  PublishError,
  RateLimitError,
} from '@/types/deliverError'
import type { FormDataRange } from '@/types/formData'
import { AgentMessage } from '@/ui/instrument'
import { parseFilteringDecisionContent } from '@/utils/aiGreetingDraft'
import { logger } from '@/utils/logger'
import { parseGptJson } from '@/utils/parse'

type PublishPhase = 'sent' | 'confirmed' | 'unknown'
type PublishState = NonNullable<logData['publish']> & { phase?: PublishPhase }
const publishRequestTimeoutMs = 15_000

export const sameCompanyKey = 'local:sameCompany'
export const sameHrKey = 'local:sameHr'

export async function requestCard(params: { securityId: string; lid: string }) {
  return axios.get<{
    code: number
    message: string
    zpData: {
      jobCard: bossZpCardData
    }
  }>('https://www.zhipin.com/wapi/zpgeek/job/card.json', {
    params,
    timeout: 5000,
  })
}

export async function requestDetail(params: { securityId: string; lid: string }) {
  const token = window?.Cookie.get('bst')
  if (!token) {
    AgentMessage.error('页面状态已失效，请刷新后重试')
    throw new PublishError('没有获取到token')
  }
  return axios.get<{
    code: number
    message: string
    zpData: bossZpDetailData
  }>('https://www.zhipin.com/wapi/zpgeek/job/detail.json', {
    params: {
      ...params,
      _: Date.now(),
    },
    headers: { Zp_token: token },
    timeout: 5000,
  })
}

export async function sendPublishReq(
  data: bossZpJobItemData,
  errorMsg?: string,
  retries = 3,
  _params = {},
  ctx?: logData,
  state: { limitConfirmationAttempted: boolean } = { limitConfirmationAttempted: false },
) {
  const attempt = 4 - retries
  ctx && (ctx.publish = { ok: false, attempts: attempt })
  if (retries === 0) {
    addLogTrace(ctx, '投递接口', 'danger', `投递接口重试耗尽：${errorMsg ?? '未知错误'}`)
    ctx && (ctx.publish = { ok: false, attempts: attempt, error: errorMsg ?? '重试多次失败' })
    throw new PublishError(errorMsg ?? '重试多次失败')
  }
  const url = 'https://www.zhipin.com/wapi/zpgeek/friend/add.json'
  const params = {
    securityId: data.securityId,
    jobId: data.encryptJobId,
    ..._params,
  }
  const token = window?.Cookie.get('bst')
  if (!token) {
    addLogTrace(ctx, '投递接口', 'danger', '没有获取到 bst token')
    ctx && (ctx.publish = { ok: false, attempts: attempt, error: '没有获取到token' })
    AgentMessage.error('页面状态已失效，请刷新后重试')
    throw new PublishError('没有获取到token')
  }
  addLogTrace(ctx, '投递接口', 'info', `第 ${attempt} 次发送投递请求`, {
    url,
    params,
  })
  try {
    ctx &&
      (ctx.publish = {
        ok: false,
        attempts: attempt,
        phase: 'sent',
      } as PublishState)
    const res = await axios({
      url,
      params,
      method: 'POST',
      headers: { Zp_token: token },
      timeout: publishRequestTimeoutMs,
    })

    res.data.code !== 0 && logger.error(`投递失败`, res)
    ctx &&
      (ctx.publish = {
        ok: res.data.code === 0,
        attempts: attempt,
        code: res.data.code,
        message: res.data.message,
        data: res.data,
        phase: 'confirmed',
      } as PublishState)

    if (res.data.code === 1) {
      const content = String(
        res.data?.zpData?.bizData?.chatRemindDialog?.content || res.data.message || '未知错误',
      )
      addLogTrace(ctx, '投递接口', 'warning', `BOSS 返回业务拦截：${content}`, {
        code: res.data.code,
        message: res.data.message,
      })
      // 命中限额弹窗 → 立刻发送确认请求
      if (content.includes('您今天已与120位BOSS沟通')) {
        if (state.limitConfirmationAttempted) {
          addLogTrace(ctx, '投递接口', 'danger', '确认后仍返回 120 位沟通提示，已停止补发')
          throw new LimitError('BOSS 重复返回 120 位沟通提示，已停止投递')
        }
        try {
          const params = new URLSearchParams()
          params.append('ba', res.data.zpData.bizData.chatRemindDialog.ba)
          params.append('action', 'addf-limit-popup-c')
          await axios({
            url: 'https://www.zhipin.com/wapi/zpCommon/actionLog/geek/chatremind.json',
            method: 'POST',
            headers: { Zp_token: token },
            data: params,
            timeout: publishRequestTimeoutMs,
          })
          addLogTrace(ctx, '投递接口', 'info', '已确认 120 位沟通限制弹窗，继续补发 cid=1')
        } catch (e) {
          logger.error('尝试确认投递限制失败', e)
          addLogTrace(ctx, '投递接口', 'danger', `投递限制确认失败：${errorHandle(e)}`)
          throw new PublishError(`投递限制确认失败]${content}`)
        }
        return sendPublishReq(data, undefined, retries, { cid: 1 }, ctx, {
          limitConfirmationAttempted: true,
        })
      } else if (content.includes('您今天已与150位BOSS沟通')) {
        addLogTrace(ctx, '投递接口', 'danger', '命中 BOSS 150 位沟通上限')
        throw new LimitError(content)
      } else if (content.includes('操作过于频繁')) {
        addLogTrace(ctx, '投递接口', 'warning', '命中 BOSS 操作频繁限制')
        throw new RateLimitError(content)
      }

      throw new PublishError(content)
    } else if (res.data.code !== 0) {
      addLogTrace(ctx, '投递接口', 'danger', `未知错误状态：${res.data.message}`, res.data)
      throw new PublishError(`未知错误状态:${res.data.message}`)
    }
    addLogTrace(ctx, '投递接口', 'success', `投递接口成功：${res.data.message ?? 'code=0'}`, {
      code: res.data.code,
      message: res.data.message,
    })
    return res.data
  } catch (e: any) {
    if (e instanceof AgentDeliveryError) {
      throw e
    }
    ctx &&
      (ctx.publish = {
        ...ctx.publish,
        ok: false,
        attempts: attempt,
        error: errorHandle(e),
        phase: 'unknown',
      } as PublishState)
    addLogTrace(ctx, '投递接口', 'warning', '投递请求已发出但结果未知，停止自动重试', {
      error: errorHandle(e),
    })
    throw e
  }
}

export async function requestBossData(
  card: bossZpCardData,
  errorMsg?: string,
  retries = 3,
): Promise<bossZpBossData> {
  if (retries === 0) {
    throw new GreetError(errorMsg ?? '重试多次失败')
  }
  const url = 'https://www.zhipin.com/wapi/zpchat/geek/getBossData'
  // userInfo.value?.token 不相等！
  const token = window?.Cookie.get('bst')
  if (!token) {
    AgentMessage.error('页面状态已失效，请刷新后重试')
    throw new GreetError('没有获取到token')
  }
  try {
    const data = new FormData()
    data.append('bossId', card.encryptUserId)
    data.append('securityId', card.securityId)
    data.append('bossSrc', '0')
    const res = await axios<{
      code: number
      message: string
      zpData: bossZpBossData
    }>({
      url,
      data,
      method: 'POST',
      headers: { Zp_token: token },
      timeout: 15000,
    })
    if (res.data.code !== 0) {
      if (res.data.message === '非好友关系') {
        return await requestBossData(card, '非好友关系', retries - 1)
      }
      throw new GreetError(`状态错误:${res.data.message}`)
    }
    return res.data.zpData
  } catch (e: any) {
    if (e instanceof GreetError) {
      throw e
    }
    return requestBossData(card, e?.message as string, retries - 1)
  }
}

export function rangeMatchFormat(v: FormDataRange, unit: string): string {
  return `${v[0]} - ${v[1]} ${unit} ${v[2] ? '严格' : '宽松'}`
}

// 匹配范围
export function rangeMatch(rangeStr: string, form: FormDataRange): boolean {
  if (!rangeStr) return false
  let [start, end, mode] = form // mode: true=严格(包含)，false=宽松(重叠)
  if (start > end) {
    ;[start, end] = [end, start]
  }
  const re = /(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/
  const m = String(rangeStr).match(re)
  if (!m) return false

  let inputStart = Number.parseFloat(m[1])
  let inputEnd = Number.parseFloat(m[2] != null ? m[2] : m[1])
  if (!Number.isFinite(inputStart) || !Number.isFinite(inputEnd)) return false

  if (inputStart > inputEnd) {
    ;[inputStart, inputEnd] = [inputEnd, inputStart]
  }
  // console.log({
  //     inputStart,inputEnd,start,end
  // })
  if (mode) {
    // 严格：职位范围(input) 完全覆盖 目标范围(form)
    return start <= inputStart && inputEnd <= end
  } else {
    // 宽松：任意重叠（闭区间）
    return Math.max(inputStart, start) <= Math.min(inputEnd, end)
  }
}

export function parseFiltering(content: string, minMatchPercent = 70) {
  interface Item {
    reason: string
    score: number
  }
  const direct = parseFilteringDecisionContent(content, minMatchPercent)
  if (direct) {
    const { decision, modelPass, passed } = direct
    const risk = decision.risk ? `\n风险:${decision.risk}` : ''
    const level = `\n等级:${decision.level}`
    const facts = `\n事实ID:${decision.selectedFactIds.join('、')}`
    return {
      res: { ...decision, pass: modelPass },
      message: `结论:${passed ? '通过' : '跳过'}\n匹配度:${decision.matchPercent}%\n阈值:${minMatchPercent}%${level}\n原因:${decision.reason}${facts}${risk}`,
      rating: decision.matchPercent,
      passed,
      level: decision.level,
      risk: decision.risk,
      data: { ...decision, modelPass },
    }
  }

  const parsedShape = parseGptJson<Record<string, unknown>>(content)
  if (parsedShape && Object.prototype.hasOwnProperty.call(parsedShape, 'matchPercent')) {
    throw new Error('AI匹配结果缺少可用简历事实')
  }

  const res = parseGptJson<{ negative: Item[]; positive: Item[] }>(content)
  if (!res || typeof res !== 'object') {
    throw new Error('AI匹配度 JSON 解析为空')
  }

  const hand = (acc: { score: number; reason: string }, curr: Item) => ({
    score: acc.score + Math.abs(curr.score),
    reason: `${acc.reason}\n${curr.reason}/(${Math.abs(curr.score)}分)`,
  })
  const data = {
    negative: res?.negative?.reduce(hand, { score: 0, reason: '' }),
    positive: res?.positive?.reduce(hand, { score: 0, reason: '' }),
  }

  const rating = (data?.positive?.score ?? 0) - (data?.negative?.score ?? 0)

  const message = `分数${rating}\n消极:${data?.negative?.reason}\n\n积极:${data?.positive?.reason}`

  const boundedRating = Math.max(0, Math.min(100, Math.round(rating)))
  return {
    res,
    message,
    rating: boundedRating,
    passed: boundedRating >= minMatchPercent,
    data: {
      matchPercent: boundedRating,
      level:
        boundedRating >= 85
          ? ('strong' as const)
          : boundedRating >= 70
            ? ('good' as const)
            : boundedRating >= 55
              ? ('maybe' as const)
              : boundedRating >= 40
                ? ('weak' as const)
                : ('reject' as const),
      reason: message,
      risk: undefined,
      selectedFactIds: [],
    },
  }
}

export function parseGreetingMessages(content: string, messageCount = 3): string[] {
  let parsed: Partial<{
    messages?: unknown[]
    message1?: unknown
    message2?: unknown
    message3?: unknown
  }> | null
  try {
    parsed = parseGptJson<{
      messages?: unknown[]
      message1?: unknown
      message2?: unknown
      message3?: unknown
    }>(content)
  } catch (e) {
    throw new GreetError(`AI招呼语 JSON 解析失败：${errorHandle(e)}`)
  }
  const messages = Array.isArray(parsed?.messages)
    ? parsed.messages
    : [parsed?.message1, parsed?.message2, parsed?.message3]
  const result = messages
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)

  if (result.length !== messageCount) {
    throw new GreetError(`AI招呼语需要返回${messageCount}条消息，实际解析到 ${result.length} 条`)
  }

  return result
}

export {
  formatBossTeacherSalutation,
  normalizeGreetingSalutation,
} from '@/utils/greetingSalutation'

export function errorHandle(e: any): string {
  if (e instanceof Error) {
    return e.message
  }
  return `${e}`
}
