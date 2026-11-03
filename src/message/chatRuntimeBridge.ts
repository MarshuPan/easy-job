import { getCurrentAppVersion } from '@/utils/extensionRuntimeHealth'

import {
  CHAT_RUNTIME_RESPONSE,
  CHAT_RUNTIME_TIMEOUT_MS,
  isChatRuntimeResponse,
  projectChatRuntimeState,
  type ChatRuntimeRequest,
  type ChatRuntimeResponse,
} from './chatRuntimeProtocol'

export function requestMainWorldChatRuntime(
  request: ChatRuntimeRequest,
  bridgeToken: string,
): Promise<ChatRuntimeResponse> {
  return new Promise((resolve) => {
    const finish = (state: ChatRuntimeResponse) => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve({
        ...projectChatRuntimeState(state),
        type: CHAT_RUNTIME_RESPONSE,
        requestId: request.requestId,
        contentVersion: getCurrentAppVersion(),
      })
    }
    const timer = setTimeout(
      () =>
        finish({
          type: CHAT_RUNTIME_RESPONSE,
          requestId: request.requestId,
          ready: false,
          code: 'MAIN_WORLD_TIMEOUT',
          reason: '聊天页主脚本未响应就绪检查',
        }),
      CHAT_RUNTIME_TIMEOUT_MS,
    )
    function onMessage(event: MessageEvent<unknown>) {
      if (event.source !== window || event.origin !== location.origin) return
      const value = event.data
      if (
        !isChatRuntimeResponse(value) ||
        value.requestId !== request.requestId ||
        (value as ChatRuntimeResponse & { bridgeToken?: unknown }).bridgeToken !== bridgeToken
      )
        return
      finish(value)
    }
    window.addEventListener('message', onMessage)
    window.postMessage({ ...request, bridgeToken }, location.origin)
  })
}
