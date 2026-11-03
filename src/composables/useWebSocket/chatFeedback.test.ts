import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { append, getUserId } = vi.hoisted(() => ({
  append: vi.fn().mockResolvedValue(true),
  getUserId: vi.fn((): string | null => 'account-1'),
}))

vi.mock('@/message', () => ({
  counter: { localDiagnosticAppend: append },
}))
vi.mock('@/stores/user', () => ({
  useUser: () => ({ getUserId }),
}))

import {
  classifyMessageDirection,
  extractChatMessageCandidate,
  startChatFeedbackObserver,
  stopChatFeedbackObserver,
} from './chatFeedback'

describe('chat feedback observer', () => {
  beforeEach(() => {
    append.mockClear()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    stopChatFeedbackObserver()
    document.body.innerHTML = ''
  })

  it('classifies common BOSS chat message markers', () => {
    const outgoing = document.createElement('div')
    outgoing.className = 'message-item-my'
    const incoming = document.createElement('div')
    incoming.setAttribute('data-direction', 'receive')
    const delivered = document.createElement('div')
    delivered.className = 'message-item-right'
    delivered.setAttribute('aria-label', '已读')

    expect(classifyMessageDirection(outgoing)).toBe('outgoing')
    expect(classifyMessageDirection(incoming)).toBe('incoming')
    expect(classifyMessageDirection(delivered)).toBe('outgoing')
  })

  it('inherits direction and platform time from the message row ancestor', () => {
    const row = document.createElement('div')
    row.className = 'message-item-other'
    row.dataset.messageTime = String(Date.now())
    const bubble = document.createElement('span')
    bubble.dataset.mid = 'nested-1'
    bubble.className = 'message-text'
    bubble.textContent = '嵌套回复'
    row.append(bubble)
    document.body.append(row)

    expect(extractChatMessageCandidate(bubble)).toMatchObject({
      direction: 'incoming',
      messageType: 'text',
      messageAt: expect.any(Number),
    })
  })

  it('extracts text and ignores controls from a message bubble', () => {
    const root = document.createElement('div')
    root.className = 'message-item-other'
    root.dataset.messageId = 'message-1'
    root.innerHTML = '<span class="message-text">回复内容</span><button>复制</button>'
    document.body.append(root)

    expect(extractChatMessageCandidate(root)).toMatchObject({
      messageId: 'message-1',
      direction: 'incoming',
      text: '回复内容',
      textLength: 4,
    })
  })

  it('does not truncate conversation identifiers or sender metadata', () => {
    const longId = 'message-' + 'x'.repeat(240)
    const longRole = '招聘者-' + 'r'.repeat(140)
    const root = document.createElement('div')
    root.className = 'message-item-other'
    root.dataset.messageId = longId
    root.dataset.senderRole = longRole
    root.textContent = '完整消息'
    document.body.append(root)

    expect(extractChatMessageCandidate(root)).toMatchObject({
      messageId: longId,
      senderRole: longRole,
    })
  })

  it('finds a message marker through arbitrarily deep layout wrappers', () => {
    const root = document.createElement('div')
    root.className = 'message-item-other'
    root.dataset.messageId = 'deep-message'
    root.textContent = '深层回复'
    let nested: Element = root
    for (let index = 0; index < 12; index += 1) {
      const wrapper = document.createElement('div')
      nested.append(wrapper)
      nested = wrapper
    }
    const bubble = document.createElement('span')
    bubble.className = 'message-text'
    bubble.textContent = '深层回复'
    nested.append(bubble)
    document.body.append(root)

    expect(extractChatMessageCandidate(bubble)).toMatchObject({
      messageId: 'deep-message',
      text: '深层回复',
    })
  })

  it('canonicalizes nested bubbles and ignores PK system cards', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div data-message-id="m1" class="message-item-other"><span class="message-text">新的回复</span></div>'
    document.body.append(root)
    expect(extractChatMessageCandidate(root.querySelector('.message-text')!)).toMatchObject({
      messageId: 'm1',
      text: '新的回复',
    })
    root.innerHTML =
      '<div class="message-item-other" data-message-id="pk">竞争者PK情况 你超过竞争者80%</div>'
    expect(extractChatMessageCandidate(root.firstElementChild!)).toBeNull()
  })

  it('baselines existing history and mirrors newly rendered messages', async () => {
    const existing = document.createElement('div')
    existing.className = 'message-item-other'
    existing.textContent = '历史消息'
    document.body.append(existing)
    const stop = startChatFeedbackObserver()

    const incoming = document.createElement('div')
    incoming.className = 'message-item-other'
    incoming.dataset.messageId = 'message-2'
    incoming.textContent = '新的回复'
    document.body.append(incoming)
    await Promise.resolve()

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: 'feedback',
        event: 'conversation.message',
        accountUid: 'account-1',
        data: expect.objectContaining({
          direction: 'incoming',
          messageId: 'message-2',
          text: '新的回复',
          source: 'dom',
          messageType: 'text',
        }),
      }),
    )
    stop()
  })

  it('keeps observing when the account becomes available after startup', async () => {
    getUserId.mockReturnValueOnce(null).mockReturnValue('account-2')
    const stop = startChatFeedbackObserver()

    const incoming = document.createElement('div')
    incoming.className = 'message-item-other'
    incoming.dataset.messageId = 'message-delayed-account'
    incoming.textContent = '延迟初始化后的回复'
    document.body.append(incoming)
    await Promise.resolve()

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: 'feedback',
        event: 'conversation.message',
        accountUid: 'account-2',
        data: expect.objectContaining({ messageId: 'message-delayed-account' }),
      }),
    )
    stop()
  })
})
