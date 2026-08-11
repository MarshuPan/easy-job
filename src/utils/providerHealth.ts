export function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (
    typeof error === 'object' &&
    error != null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return String(error)
}

export function isExtensionContextInvalidatedError(error: unknown) {
  const message = getErrorMessage(error)
  return (
    /extension context(?: has been)? invalidated/i.test(message) ||
    /['"]?wxt\/storage['"]? must be loaded in a web extension environment/i.test(message)
  )
}

export function isProviderHeartbeatError(error: unknown) {
  const message = getErrorMessage(error)
  return (
    message.includes('Provider unavailable') ||
    message.includes('heartbeat check timeout') ||
    (message.includes('heartbeat') && message.includes('timeout'))
  )
}

export function getProviderHeartbeatDiagnostic(error: unknown) {
  const message = getErrorMessage(error)
  return {
    error: message,
    name: error instanceof Error ? error.name : typeof error,
    providerHeartbeat: isProviderHeartbeatError(error),
  }
}
