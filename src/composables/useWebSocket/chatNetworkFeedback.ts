import { counter } from '@/message'
import { useUser } from '@/stores/user'
import {
  appendConversationMessage,
  appendGreetingFeedbackEvent,
  conversationKeyFromBossId,
  conversationKeysFromBossIds,
  createGreetingId,
} from '@/utils/greetingFeedback'

import { AwesomeMessage } from './type'

// Raw frames are mirrored with the same chunking boundary as the local sink.
// A smaller fixed frame limit used to turn a large but valid BOSS frame into
// "unsupported" and lose its structured replies.
const maxFrameBytes = 16 * 1024 * 1024
// Keep a bounded pre-account buffer as a memory guard. The raw frame is always
// persisted, so an account-initialization delay remains replayable locally.
const maxUnattributedBacklog = 10_000
const rawFrameEncodeBlockSize = 0x8000

export type ChatFrameDecodeStatus = 'decoded' | 'unsupported' | 'invalid'

export interface ChatFrameDecodeResult {
  status: ChatFrameDecodeStatus
  messages: Record<string, any>[]
}

function identity(value: unknown): string {
  return value == null ? '' : String(value)
}

function isMessageRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, any>
  return (
    item.from != null &&
    item.to != null &&
    item.body != null &&
    typeof item.from === 'object' &&
    typeof item.to === 'object' &&
    typeof item.body === 'object'
  )
}

function decodeProtobuf(frame: Uint8Array) {
  const decoded = AwesomeMessage.toObject(AwesomeMessage.decode(frame), { longs: String })
  if (!decoded || typeof decoded !== 'object') return null
  return {
    envelope: true,
    messages: Array.isArray(decoded.messages) ? (decoded.messages as Record<string, any>[]) : [],
  }
}

function encodeRawFrame(value: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < value.length; offset += rawFrameEncodeBlockSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + rawFrameEncodeBlockSize))
  }
  return {
    rawFrame: typeof btoa === 'function' ? btoa(binary) : binary,
    rawFrameEncoding: 'base64' as const,
    frameBytes: value.byteLength,
  }
}

function rawFrameDiagnostic(value: unknown) {
  if (typeof value === 'string') {
    return {
      rawFrame: value,
      rawFrameEncoding: 'utf8' as const,
      frameBytes: new TextEncoder().encode(value).byteLength,
    }
  }
  if (value instanceof ArrayBuffer) return encodeRawFrame(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) {
    return encodeRawFrame(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }
  return { rawFrame: String(value ?? ''), rawFrameEncoding: 'unknown' as const, frameBytes: 0 }
}

/** Decode only the chat envelope already used by our sender; never persist raw frames. */
export function decodeChatFrameDetailed(frame: Uint8Array | string): ChatFrameDecodeResult {
  if (frame.length > maxFrameBytes) return { status: 'unsupported', messages: [] }
  if (typeof frame === 'string') {
    try {
      const decoded = JSON.parse(frame)
      const messages = Array.isArray(decoded?.messages)
        ? (decoded.messages as Record<string, any>[])
        : []
      return {
        status: messages.some(isMessageRecord) ? 'decoded' : 'unsupported',
        messages,
      }
    } catch {
      return { status: 'invalid', messages: [] }
    }
  }

  let sawEnvelope = false
  for (const offset of [0, 1, 2, 4, 5, 8]) {
    if (offset >= frame.length) continue
    try {
      const decoded = decodeProtobuf(frame.subarray(offset))
      if (decoded == null) continue
      sawEnvelope = true
      if (decoded.messages.some(isMessageRecord))
        return { status: 'decoded', messages: decoded.messages }
    } catch {
      // A non-chat frame or a framing prefix is expected on this socket.
    }
  }
  return { status: sawEnvelope ? 'unsupported' : 'invalid', messages: [] }
}

export function decodeChatFrame(frame: Uint8Array | string) {
  const result = decodeChatFrameDetailed(frame)
  if (result.status === 'invalid') throw new Error('chat-frame-decode-failed')
  return result.messages
}

export function normalizeNetworkMessage(
  message: Record<string, any>,
  currentUid: string,
  startedAt: number,
  now = Date.now(),
) {
  const from = identity(message.from?.uid)
  const to = identity(message.to?.uid)
  if (!from || !to || (from !== currentUid && to !== currentUid)) return null
  const direction = from === currentUid ? ('outgoing' as const) : ('incoming' as const)
  const body = message.body
  const text = typeof body?.text === 'string' ? body.text : ''
  const messageId = identity(message.mid || message.cmid)
  if (!text || !messageId) return null
  const rawTime = Number(message.time)
  const timestamp = rawTime < 1e12 ? rawTime * 1000 : rawTime
  const messageAt =
    Number.isFinite(timestamp) && timestamp >= 946684800000 && timestamp <= now + 86400000
      ? timestamp
      : undefined
  // templateId varies by BOSS message template. The body type and actual text
  // are the stable indicators; requiring templateId === 1 dropped real replies.
  const isText = body?.type === 1 && text.length > 0
  const conversationKey = conversationKeyFromBossId(direction === 'incoming' ? from : to)
  return {
    conversationKey,
    conversationKeys: conversationKeysFromBossIds(direction === 'incoming' ? from : to),
    messageId,
    direction,
    text: isText ? text : '',
    messageType: isText ? ('text' as const) : ('system' as const),
    messageAt,
    observation:
      messageAt != null && messageAt < startedAt - 60_000
        ? ('history' as const)
        : ('live' as const),
    replyEligible: direction === 'incoming' && isText && messageAt != null,
    confirmation: 'platform-message-observed' as const,
    source: 'network' as const,
    observedAt: now,
  }
}

let stopActive: (() => void) | undefined

/** Passive listener: does not open sockets, fetch history, switch conversations or send messages. */
export function startChatNetworkFeedbackObserver() {
  if (stopActive) return stopActive
  const NativeSocket = window.WebSocket
  if (!NativeSocket) return () => {}
  const pageSessionId = createGreetingId()
  const startedAt = Date.now()
  const sockets = new Map<WebSocket, (event: MessageEvent) => void>()
  const backlog: Record<string, any>[] = []
  const metrics = {
    frames: 0,
    decoded: 0,
    unsupportedFrames: 0,
    decodeErrors: 0,
    messages: 0,
    droppedBeforeAccount: 0,
  }
  let frameSequence = 0
  let stopped = false
  let lastHealthAt = 0

  function currentUid() {
    try {
      const uid = useUser().getUserId()
      return uid == null ? '' : String(uid)
    } catch {
      return ''
    }
  }

  function emit(messages: Record<string, any>[]) {
    backlog.push(...messages)
    if (backlog.length > maxUnattributedBacklog)
      metrics.droppedBeforeAccount += backlog.splice(
        0,
        backlog.length - maxUnattributedBacklog,
      ).length
    const uid = currentUid()
    if (!uid) return
    for (const message of backlog.splice(0)) {
      const normalized = normalizeNetworkMessage(message, uid, startedAt)
      if (!normalized) continue
      metrics.messages++
      void appendConversationMessage(uid, normalized)
    }
  }

  function recordRawFrame(
    uid: string | number | null | undefined,
    socket: WebSocket,
    raw: ReturnType<typeof rawFrameDiagnostic>,
    result: ChatFrameDecodeResult,
  ) {
    const data = {
      kind: 'chat-frame',
      source: 'network',
      pageSessionId,
      frameSequence: ++frameSequence,
      socketUrl: socket.url,
      decodeStatus: result.status,
      decodedMessageCount: result.messages.length,
      ...raw,
    }
    if (uid == null || String(uid).trim() === '') {
      // `feedback` intentionally rejects unattributed business events. Keep the
      // raw protocol evidence in the runtime stream until the account is known.
      const append = counter.localDiagnosticAppend
      if (typeof append === 'function') {
        void append({ stream: 'logs', event: 'runtime.chat-frame', data }).catch(() => undefined)
      }
      return
    }
    void appendGreetingFeedbackEvent(uid, 'conversation.frame', data)
  }

  function attach(socket: WebSocket) {
    if (sockets.has(socket)) return
    try {
      if (!/(^|\.)zhipin\.com$/i.test(new URL(socket.url).hostname)) return
    } catch {
      return
    }
    const onMessage = async (event: MessageEvent) => {
      metrics.frames++
      try {
        const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data
        if (stopped) return
        const raw = rawFrameDiagnostic(data)
        const result =
          typeof data === 'string'
            ? decodeChatFrameDetailed(data)
            : data instanceof ArrayBuffer
              ? decodeChatFrameDetailed(new Uint8Array(data))
              : ArrayBuffer.isView(data)
                ? decodeChatFrameDetailed(
                    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                  )
                : { status: 'unsupported' as const, messages: [] }
        if (result.status === 'decoded') metrics.decoded++
        if (result.status === 'unsupported') metrics.unsupportedFrames++
        if (result.status === 'invalid') metrics.decodeErrors++
        recordRawFrame(currentUid() || undefined, socket, raw, result)
        emit(result.messages)
      } catch {
        metrics.decodeErrors++
      }
    }
    sockets.set(socket, onMessage)
    socket.addEventListener('message', onMessage)
  }

  const ObservedSocket = new Proxy(NativeSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as WebSocket
      attach(socket)
      return socket
    },
  })
  window.WebSocket = ObservedSocket
  function tick() {
    // Some BOSS versions expose their existing socket before our script starts.
    if (window.socket instanceof NativeSocket) attach(window.socket)
    emit([])
    const uid = currentUid()
    if (uid && Date.now() - lastHealthAt >= 30_000) {
      lastHealthAt = Date.now()
      void appendGreetingFeedbackEvent(uid, 'conversation.observer', {
        kind: 'observer',
        source: 'network',
        status: 'health',
        pageSessionId,
        coverage: sockets.size ? 'observed-sockets-only' : 'unavailable',
        connectedSockets: [...sockets.keys()].filter((s) => s.readyState === NativeSocket.OPEN)
          .length,
        ...metrics,
      })
    }
    for (const [socket, listener] of sockets) {
      if (socket.readyState === NativeSocket.CLOSED) {
        socket.removeEventListener('message', listener)
        sockets.delete(socket)
      }
    }
  }
  const timer = window.setInterval(tick, 1000)
  tick()
  stopActive = () => {
    stopped = true
    window.clearInterval(timer)
    for (const [socket, listener] of sockets) socket.removeEventListener('message', listener)
    if (window.WebSocket === ObservedSocket) window.WebSocket = NativeSocket
    stopActive = undefined
  }
  return stopActive
}
