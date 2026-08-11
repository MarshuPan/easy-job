import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loader } from './index'

describe('extension request loader isolation', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn(() => 1),
    })
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('never reads or modifies the host page loader', () => {
    document.body.innerHTML = `
      <div id="loader" style="width: 47px; background: white">BOSS loading</div>
      <div id="agent-delivery-job"></div>
    `
    const hostLoader = document.querySelector<HTMLElement>('#loader')!

    const stop = loader({ ms: 10_000, color: '#123456' })

    const extensionLoader = document.querySelector<HTMLElement>(
      '#agent-delivery-job > #agent-delivery-loader',
    )
    expect(extensionLoader).not.toBeNull()
    expect(extensionLoader?.style.background).toBe('rgb(18, 52, 86)')
    expect(hostLoader.style.width).toBe('47px')
    expect(hostLoader.style.background).toBe('white')

    stop()
    expect(hostLoader.style.width).toBe('47px')
  })

  it('does not add loading UI before the extension root exists', () => {
    document.body.innerHTML = '<div id="loader">BOSS loading</div>'

    loader({ ms: 10_000 })

    expect(document.querySelector('#agent-delivery-loader')).toBeNull()
    expect(window.requestAnimationFrame).not.toHaveBeenCalled()
  })
})
