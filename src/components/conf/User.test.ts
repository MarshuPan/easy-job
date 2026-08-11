import { shallowMount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/user', () => ({
  useUser: () => ({
    cookieTableData: { value: [] },
    deleteUser: vi.fn(),
    getUserId: vi.fn(() => 'account-a'),
  }),
}))

vi.mock('@/utils/logger', () => ({
  logger: { error: vi.fn() },
}))

import User from './User.vue'

describe('account management security boundary', () => {
  it('shows an explicit disabled state instead of page-callable cookie actions', () => {
    const wrapper = shallowMount(User, {
      props: { modelValue: true },
      global: {
        stubs: {
          AgentDialog: {
            props: ['modelValue'],
            template: '<section><slot /><slot name="footer" /></section>',
          },
          AgentTable: true,
        },
      },
    })

    expect(wrapper.find('[data-test="account-management-disabled"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('安全策略已停用浏览器 Cookie 账号管理')
    expect(wrapper.text()).not.toContain('新建&登出')
    expect(wrapper.text()).not.toContain('切换')
  })
})
