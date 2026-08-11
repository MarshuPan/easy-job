import { describe, expect, it } from 'vitest'

import {
  EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE,
  EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE,
  EXTENSION_RUNTIME_PROBE_REQUEST_TYPE,
  EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE,
  ExtensionRuntimeHealthError,
  getExtensionRuntimeHealthDiagnostic,
  isExtensionBackgroundProbeRequest,
  isExtensionBackgroundProbeResponse,
  isExtensionRuntimeProbeRequest,
  isExtensionRuntimeProbeResponse,
} from './extensionRuntimeHealth'

describe('extension runtime health protocol', () => {
  it('accepts only complete page probe messages', () => {
    expect(
      isExtensionRuntimeProbeRequest({
        type: EXTENSION_RUNTIME_PROBE_REQUEST_TYPE,
        requestId: 'probe-1',
        bridgeToken: 'token-1',
        version: '0.6.59',
      }),
    ).toBe(true)
    expect(
      isExtensionRuntimeProbeRequest({
        type: EXTENSION_RUNTIME_PROBE_REQUEST_TYPE,
        requestId: 'probe-1',
        version: '0.6.59',
      }),
    ).toBe(false)
  })

  it('validates safe page and background responses', () => {
    expect(
      isExtensionRuntimeProbeResponse({
        type: EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE,
        requestId: 'probe-1',
        bridgeToken: 'token-1',
        ok: true,
        mainVersion: '0.6.59',
        contentVersion: '0.6.59',
        backgroundVersion: '0.6.59',
      }),
    ).toBe(true)
    expect(
      isExtensionBackgroundProbeRequest({
        type: EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE,
        requestId: 'probe-1',
      }),
    ).toBe(true)
    expect(
      isExtensionBackgroundProbeResponse({
        type: EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE,
        requestId: 'probe-1',
        ok: true,
        version: '0.6.59',
      }),
    ).toBe(true)
    expect(
      isExtensionRuntimeProbeResponse({
        type: EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE,
        requestId: 'probe-1',
        bridgeToken: 'token-1',
        ok: true,
        mainVersion: '0.6.59',
        contentVersion: '0.6.59',
      }),
    ).toBe(false)
  })

  it('exposes only a stable code and actionable message', () => {
    const error = new ExtensionRuntimeHealthError('CONTENT_SCRIPT_UNAVAILABLE')

    expect(getExtensionRuntimeHealthDiagnostic(error)).toEqual({
      code: 'CONTENT_SCRIPT_UNAVAILABLE',
      error: '插件页面通信已失效，请关闭当前 BOSS 标签页并重新打开后再开始投递',
      runtimeHealth: false,
    })
    expect(JSON.stringify(getExtensionRuntimeHealthDiagnostic(error))).not.toContain('token')
  })
})
