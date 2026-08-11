import type { AiTaskDiagnostics } from '@/utils/backgroundAiDiagnostics'

/**
 * AI 请求/响应的协议类型。
 *
 * 原本住在 `composables/useModel/type.ts`，与页面侧的 LLM 客户端实现放在一起。
 * 那套客户端已经删除（AI 调用统一由后台的 runConfiguredAiTask 承担），但这些类型
 * 仍被 Prompt 组装、后台任务和消息层广泛使用，因此独立保留。
 */
export type prompt = Array<{
  role: 'system' | 'user' | 'assistant'
  content: string
}>

export interface messageReps<T = string> {
  content?: T
  diagnostics?: AiTaskDiagnostics
  reasoning_content?: string | null
  prompt?: string
  usage?: {
    total_tokens: number
    input_tokens: number
    output_tokens: number
    /**
     * 推理 token，已包含在 output_tokens 里。
     *
     * 单看 output_tokens 无法区分「模型想得久」和「我们让它复述得多」，而这两者的优化手段
     * 完全不同：前者要缩小单次判断的范围，后者要减少要求模型重新输出的内容。
     */
    reasoning_tokens?: number
  }
}
