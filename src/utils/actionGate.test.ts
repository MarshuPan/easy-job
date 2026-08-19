import { describe, expect, it } from 'vitest'

import {
  type ActionEvent,
  defaultGateRules,
  type GateRules,
  getMaxWindowMs,
  getSessionStartedAt,
  paceMultiplier,
  pruneEvents,
  sessionGapMs,
  waitMsFor,
} from './actionGate'

const now = 1_700_000_000_000
const minute = 60_000

function events(kind: ActionEvent['kind'], ...offsetsMs: number[]): ActionEvent[] {
  return offsetsMs.map((offset) => ({ kind, at: now - offset }))
}

/** 让被测那一类成为唯一的约束，避免总量桶顺带把结果解释掉。 */
function only(
  kind: ActionEvent['kind'],
  bucket: { burst: number; refillPerMin: number },
): GateRules {
  return {
    buckets: {
      ...defaultGateRules.buckets,
      [kind]: bucket,
      total: { burst: 1000, refillPerMin: 1000 },
    },
    ceilings: {},
  }
}

describe('paceMultiplier', () => {
  it('starts fast and slows down as the session runs on', () => {
    // 匀速本身就是机器特征：恒定速率连跑三小时，这个平坦度就是签名。
    // 真人是开头扫得快、越往后越慢。
    expect(paceMultiplier(0)).toBeGreaterThan(paceMultiplier(15 * minute))
    expect(paceMultiplier(15 * minute)).toBeGreaterThan(paceMultiplier(30 * minute))
    expect(paceMultiplier(30 * minute)).toBeGreaterThan(paceMultiplier(60 * minute))
  })

  it('never speeds back up without a break', () => {
    const samples = [0, 5, 10, 25, 45, 90].map((m) => paceMultiplier(m * minute))
    const sorted = [...samples].sort((a, b) => b - a)
    expect(samples).toEqual(sorted)
  })
})

describe('getSessionStartedAt', () => {
  it('treats a long quiet stretch as the end of the previous session', () => {
    // 歇够了曲线就该回到最快那一档——这正是「休息之后又能快起来」。
    const older = events('detail', 90 * minute, 80 * minute)
    const recent = events('detail', 5 * minute, 4 * minute)
    expect(getSessionStartedAt([...older, ...recent], now)).toBe(now - 5 * minute)
  })

  it('keeps one continuous stretch as a single session', () => {
    // 间隔从 sessionGapMs 推导，别写死分钟数：阈值一调，写死的用例会假红。
    const step = sessionGapMs * 0.75
    const offsets = [4, 3, 2, 1].map((n) => n * step)
    expect(getSessionStartedAt(events('detail', ...offsets), now)).toBe(now - offsets[0])
  })

  it('starts a fresh session when the last action is already stale', () => {
    expect(getSessionStartedAt(events('detail', sessionGapMs + minute), now)).toBe(now)
  })

  it('starts now when nothing has happened yet', () => {
    expect(getSessionStartedAt([], now)).toBe(now)
  })
})

describe('the pieces fit together', () => {
  it('lets the batch rest that ships by default reset the curve', () => {
    // 批量休息默认 10 分钟。会话阈值如果比它长，那次休息刚好差一点触发不了重置，
    // 「歇够了又能快起来」就成了空话——两个机制各自成立，合起来不通。
    const defaultBatchRestMs = 10 * minute
    expect(sessionGapMs).toBeLessThan(defaultBatchRestMs)
  })

  it('keeps enough history to still see the session boundary after pruning', () => {
    // 修剪窗口如果短于会话阈值，跑久之后会误判成「刚开工」，曲线又跳回最快档。
    expect(getMaxWindowMs()).toBeGreaterThan(sessionGapMs)
  })
})

describe('waitMsFor', () => {
  const rules = only('detail', { burst: 3, refillPerMin: 2 })

  it('lets a burst through instead of metering every single action', () => {
    // 桶的意义就在这里：真人打开页面会连着点开几个 JD，一个一个匀速放行反而不像人。
    let history: ActionEvent[] = []
    for (let i = 0; i < 3; i++) {
      expect(waitMsFor(history, 'detail', now, rules)).toBe(0)
      history = [...history, { kind: 'detail', at: now }]
    }
  })

  it('starts metering once the burst is spent', () => {
    const spent = events('detail', 100, 200, 300)
    expect(waitMsFor(spent, 'detail', now, rules)).toBeGreaterThan(0)
  })

  it('refills faster early in a session than late in one', () => {
    // 同样用光一桶，开头等的时间应该明显短于跑了一小时之后。
    const fresh = events('detail', 100, 200, 300)
    // 会话要「连续」才算跑了很久：中间的空白一旦超过 sessionGapMs 就被当成歇过了。
    const step = sessionGapMs * 0.75
    const longRun = Array.from(
      { length: Math.ceil((70 * minute) / step) },
      (_, i) => 70 * minute - i * step,
    ).filter((offset) => offset > 0)
    const lateSession = [...events('detail', ...longRun), ...events('detail', 100, 200, 300)]
    expect(waitMsFor(fresh, 'detail', now, rules)).toBeLessThan(
      waitMsFor(lateSession, 'detail', now, rules),
    )
  })

  it('counts the total budget across kinds, not just the same kind', () => {
    // 单类都没超但合计超了也要拦。散点 delay 挡不住的正是这种叠加。
    const mixed: GateRules = {
      buckets: {
        ...defaultGateRules.buckets,
        detail: { burst: 100, refillPerMin: 100 },
        publish: { burst: 100, refillPerMin: 100 },
        total: { burst: 2, refillPerMin: 1 },
      },
      ceilings: {},
    }
    const both = [...events('detail', 100), ...events('publish', 200)]
    expect(waitMsFor(both, 'detail', now, mixed)).toBeGreaterThan(0)
  })

  it('enforces a hard ceiling that the curve cannot lift', () => {
    // 硬顶是兜底：曲线再快也不能突破它，别处出 bug 时它得拦住。
    const capped: GateRules = {
      buckets: { ...defaultGateRules.buckets, detail: { burst: 100, refillPerMin: 1000 } },
      ceilings: { detail: [{ windowMs: 10 * minute, max: 2 }] },
    }
    const atCap = events('detail', 5 * minute, 4 * minute)
    expect(waitMsFor(atCap, 'detail', now, capped)).toBe(10 * minute - 5 * minute)
  })

  it('never reports a wait for an empty history', () => {
    expect(waitMsFor([], 'publish', now)).toBe(0)
  })
})

describe('the shipped defaults', () => {
  it('lets one job send all of its greeting segments without self-blocking', () => {
    // 招呼语分三到五段。桶如果小于一个岗位的段数，一个岗位的招呼语会把自己卡住。
    let history: ActionEvent[] = []
    for (let i = 0; i < 5; i++) {
      expect(waitMsFor(history, 'greeting', now)).toBe(0)
      history = [...history, { kind: 'greeting', at: now + i }]
    }
  })

  it('paces detail with the bucket alone, and no fixed ceiling', () => {
    // 这里原来有一条 5 次 / 5 分钟的硬顶，赌的是「您的环境存在异常」按窗口滚动。
    // 第三轮真机证伪了：第 12 次是硬顶算出来等了 182 秒之后才发的，窗口从满降到不满、
    // 账号整整安静 3.6 分钟，照样被拒；而这轮撑了 11 次、上轮 14 次，两轮节奏几乎相同
    // （1.08 与 1.10 次/分钟）。慢跑买不到次数，只让同一件事在页面上多暴露 10 分钟。
    let history: ActionEvent[] = []
    for (let i = 0; i < 6; i++) {
      expect(waitMsFor(history, 'detail', now + i * 1000, defaultGateRules)).toBe(0)
      history = [...history, { kind: 'detail', at: now + i * 1000 }]
    }

    // 桶还在：连发满一整桶之后要等补充，节奏仍然像人，不会变成机枪。
    expect(waitMsFor(history, 'detail', now + 6000, defaultGateRules)).toBeGreaterThan(0)

    // 但硬顶不能回来：等桶补上之后就该放行。如果这里又开始等，说明有人在明明还有令牌
    // 的情况下按「这个窗口内已经发过几次」拦人——那正是被证伪的那条路。
    expect(waitMsFor(history, 'detail', now + 3 * minute, defaultGateRules)).toBe(0)
  })

  it('does not stall a run that comes back after a break', () => {
    expect(waitMsFor(events('detail', 2 * 60 * minute), 'detail', now)).toBe(0)
  })
})

describe('pruneEvents', () => {
  it('keeps enough history to still recognise the session boundary', () => {
    expect(getMaxWindowMs()).toBeGreaterThan(sessionGapMs)
  })

  it('drops records older than the longest window so the queue stays bounded', () => {
    const old = events('detail', getMaxWindowMs() + 1000)
    const fresh = events('detail', 1000)
    expect(pruneEvents([...old, ...fresh], now)).toEqual(fresh)
  })
})
