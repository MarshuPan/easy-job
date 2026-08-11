import type { AiTaskType } from '@/utils/backgroundAiProtocol'

export interface AiTaskAttemptDiagnostic {
  attempt: number
  durationMs: number
  error?: string
  ok: boolean
  status?: number
  statusText?: string
}

export interface AiTaskDiagnostics {
  attempts: AiTaskAttemptDiagnostic[]
  background?: {
    durationMs: number
    pollCount: number
    responseId: string
    status: string
  }
  endpointType: 'anthropicMessages' | 'chatCompletions' | 'responses'
  maxRetries: number
  model: string
  promptChars: number
  requestBodyChars: number
  task?: AiTaskType | 'resumeExtraction' | 'modelTest'
  timeoutSeconds: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null
}

export function getAiTaskDiagnostics(value: unknown): AiTaskDiagnostics | undefined {
  if (!isRecord(value)) return undefined
  const diagnostics = value.diagnostics
  if (!isRecord(diagnostics) || !Array.isArray(diagnostics.attempts)) return undefined
  return diagnostics as unknown as AiTaskDiagnostics
}
