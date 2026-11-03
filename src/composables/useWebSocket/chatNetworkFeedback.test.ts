import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AwesomeMessage } from './type'

const { appendMessage, appendEvent, account } = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  appendEvent: vi.fn(),
  account: { uid: '1' },
}))
const { appendLocalDiagnostic } = vi.hoisted(() => ({
  appendLocalDiagnostic: vi.fn(async () => true),
}))
vi.mock('@/stores/user', () => ({ useUser: () => ({ getUserId: () => account.uid }) }))
vi.mock('@/message', () => ({ counter: { localDiagnosticAppend: appendLocalDiagnostic } }))
vi.mock('@/utils/greetingFeedback', () => ({
  appendConversationMessage: appendMessage,
  appendGreetingFeedbackEvent: appendEvent,
  conversationKeyFromBossId: (uid: string) => `boss:${uid}`,
  conversationKeysFromBossIds: (...uids: string[]) => [
    ...new Set(uids.map((uid) => `boss:${uid}`)),
  ],
  createGreetingId: () => 'page-1',
}))
import {
  decodeChatFrame,
  decodeChatFrameDetailed,
  normalizeNetworkMessage,
  startChatNetworkFeedbackObserver,
} from './chatNetworkFeedback'

const now = 1793000000000
function message(overrides = {}) {
  return {
    from: { uid: '2' },
    to: { uid: '1' },
    mid: '9007199254740993',
    cmid: '9',
    type: 1,
    time: String(now),
    body: { type: 1, templateId: 1, text: '您好，方便沟通吗？' },
    ...overrides,
  }
}

describe('passive chat protocol feedback', () => {
  let stop: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    vi.clearAllMocks()
    account.uid = '1'
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  it('decodes the existing protobuf schema without losing 64-bit message IDs', () => {
    const frame = AwesomeMessage.encode({ type: 1, messages: [message()] }).finish()
    const result = normalizeNetworkMessage(decodeChatFrame(frame)[0], '1', now, now)
    expect(result).toMatchObject({
      conversationKey: 'boss:2',
      direction: 'incoming',
      messageId: '9007199254740993',
      messageAt: now,
      messageType: 'text',
      replyEligible: true,
    })
    expect(decodeChatFrame(new Uint8Array(16 * 1024 * 1024 + 1))).toEqual([])
    expect(() => decodeChatFrame(new Uint8Array([255]))).toThrow()
  })
  it('classifies heartbeats separately from malformed frames', () => {
    const heartbeat = AwesomeMessage.encode({ type: 2, messages: [] }).finish()
    expect(decodeChatFrameDetailed(heartbeat)).toEqual({ status: 'unsupported', messages: [] })
    expect(decodeChatFrameDetailed(new Uint8Array([255]))).toEqual({
      status: 'invalid',
      messages: [],
    })
  })
  it('separates outgoing, unrelated, system, invalid-time and historical messages', () => {
    expect(
      normalizeNetworkMessage(
        message({ body: { type: 1, templateId: 7, text: '模板变化但仍是文本回复' } }),
        '1',
        now,
        now,
      ),
    ).toMatchObject({ messageType: 'text', replyEligible: true, text: '模板变化但仍是文本回复' })
    expect(
      normalizeNetworkMessage(message({ from: { uid: '1' }, to: { uid: '2' } }), '1', now, now),
    ).toMatchObject({ direction: 'outgoing', replyEligible: false })
    expect(normalizeNetworkMessage(message(), '3', now, now)).toBeNull()
    expect(
      normalizeNetworkMessage(
        message({ body: { type: 4, templateId: 9, text: '你超过竞争者' } }),
        '1',
        now,
        now,
      ),
    ).toMatchObject({ messageType: 'system', text: '', replyEligible: false })
    expect(normalizeNetworkMessage(message({ time: 'broken' }), '1', now, now)).toMatchObject({
      messageAt: undefined,
      replyEligible: false,
    })
    expect(
      normalizeNetworkMessage(message({ time: String((now - 120_000) / 1000) }), '1', now, now),
    ).toMatchObject({ messageAt: now - 120_000, observation: 'history' })
  })
  it('observes only site sockets, buffers before account initialization and reports coverage', async () => {
    class FakeSocket extends EventTarget {
      static OPEN = 1
      static CLOSED = 3
      readyState = 1
      static constructed = 0
      send = vi.fn()
      constructor(readonly url: string) {
        super()
        FakeSocket.constructed++
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    account.uid = ''
    stop = startChatNetworkFeedbackObserver()
    expect(FakeSocket.constructed).toBe(0)
    const socket = new window.WebSocket('wss://ws.zhipin.com/chat')
    const other = new window.WebSocket('wss://unrelated.example/chat')
    const data = JSON.stringify({ messages: [message()] })
    other.dispatchEvent(new MessageEvent('message', { data }))
    socket.dispatchEvent(new MessageEvent('message', { data }))
    expect(appendMessage).not.toHaveBeenCalled()
    account.uid = '1'
    await vi.advanceTimersByTimeAsync(1000)
    expect(appendMessage).toHaveBeenCalledOnce()
    expect(appendMessage).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ conversationKey: 'boss:2', direction: 'incoming' }),
    )
    expect(appendEvent).toHaveBeenCalledWith(
      '1',
      'conversation.observer',
      expect.objectContaining({
        coverage: 'observed-sockets-only',
        frames: 1,
        decoded: 1,
        messages: 1,
      }),
    )
    expect((socket as unknown as FakeSocket).send).not.toHaveBeenCalled()
    expect(appendLocalDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: 'logs',
        event: 'runtime.chat-frame',
        data: expect.objectContaining({
          rawFrameEncoding: 'utf8',
          frameBytes: expect.any(Number),
          decodeStatus: 'decoded',
        }),
      }),
    )
    stop()
    expect(window.WebSocket).toBe(FakeSocket)
  })
  it('reports unavailable coverage when no site socket can be observed', () => {
    stop = startChatNetworkFeedbackObserver()
    expect(appendEvent).toHaveBeenCalledWith(
      '1',
      'conversation.observer',
      expect.objectContaining({ coverage: 'unavailable' }),
    )
  })
})
