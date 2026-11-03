import { afterEach, describe, expect, it } from 'vitest'

import { SecurityCheckRequiredError } from '@/types/deliverError'

import {
  assertBossSecurityCheckClear,
  isBossSecurityCheckPage,
  withoutBossSecurityCheckParam,
} from './bossPageState'

afterEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/web/geek/jobs')
})

describe('BOSS security-check evidence', () => {
  it('allows a normal jobs page carrying the post-verification marker', () => {
    window.history.replaceState({}, '', '/web/geek/jobs?query=AI&_security_check=1_123')
    document.body.innerHTML = '<main><article><h2>产品经理</h2></article></main>'

    expect(isBossSecurityCheckPage()).toBe(false)
    expect(() => assertBossSecurityCheckClear()).not.toThrow()
  })

  it('does not infer a challenge from the marker while the page is still empty', () => {
    window.history.replaceState({}, '', '/web/geek/jobs?_security_check=1_123')

    expect(isBossSecurityCheckPage()).toBe(false)
  })

  it('ignores verification words in job content and unrelated search controls', () => {
    document.body.innerHTML = `
      <article><h2>安全验证</h2><p>请完成安全验证后继续</p><button>立即沟通</button></article>
      <form><h2>搜索岗位</h2><input name="query"><button>搜索</button></form>
    `

    expect(isBossSecurityCheckPage()).toBe(false)
  })

  it('pauses for a visible verification dialog even without a URL marker', () => {
    document.body.innerHTML = `
      <div role="dialog"><h2>安全验证</h2><iframe title="验证控件"></iframe></div>
    `

    expect(isBossSecurityCheckPage()).toBe(true)
    expect(() => assertBossSecurityCheckClear()).toThrow(SecurityCheckRequiredError)
  })

  it('pauses for a visible verification form and clears when it is removed', () => {
    document.body.innerHTML = `
      <form><p>请完成人机验证后继续</p><input name="answer"><button>验证</button></form>
    `

    expect(isBossSecurityCheckPage()).toBe(true)
    document.body.innerHTML = ''
    expect(isBossSecurityCheckPage()).toBe(false)
  })

  it.each([
    'hidden',
    'aria-hidden="true"',
    'inert',
    'style="display:none"',
    'style="visibility:hidden"',
    'style="opacity:0"',
  ])('ignores a verification widget inside a hidden ancestor: %s', (attributes) => {
    document.body.innerHTML = `
      <div ${attributes}><div role="dialog"><h2>安全验证</h2><canvas></canvas></div></div>
    `

    expect(isBossSecurityCheckPage()).toBe(false)
  })

  it('ignores a closed dialog and its nested verification form', () => {
    document.body.innerHTML = '<dialog><form><h2>安全验证</h2><input></form></dialog>'

    expect(isBossSecurityCheckPage()).toBe(false)
  })

  it('requires a visible verification prompt and a visible control in the same scope', () => {
    document.body.innerHTML = `
      <div role="dialog"><h2 hidden>安全验证</h2><input></div>
      <form><h2>安全验证</h2><input type="hidden"></form>
      <form><h2>安全验证</h2><canvas style="display:none"></canvas></form>
    `

    expect(isBossSecurityCheckPage()).toBe(false)
  })
})

describe('withoutBossSecurityCheckParam', () => {
  it('removes only the _security_check marker from absolute urls', () => {
    const cleaned = withoutBossSecurityCheckParam(
      'https://www.zhipin.com/web/geek/jobs?query=AI&_security_check=1_123&city=101020100',
    )

    expect(cleaned).toBe('https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100')
  })

  it('keeps relative urls relative', () => {
    expect(withoutBossSecurityCheckParam('/web/geek/jobs?_security_check=1_123')).toBe(
      '/web/geek/jobs',
    )
  })

  it('returns urls without the marker unchanged', () => {
    const url = 'https://www.zhipin.com/web/geek/job?query=AIGC%E4%BA%A7%E5%93%81'
    expect(withoutBossSecurityCheckParam(url)).toBe(url)
  })
})
