import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import InfoIcon from '@/components/icon/Info.vue'

describe('vue sfc transform', () => {
  it('mounts an imported .vue single-file component', () => {
    const wrapper = mount(InfoIcon)

    expect(wrapper.find('svg').exists()).toBe(true)
  })
})
