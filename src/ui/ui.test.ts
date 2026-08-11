import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import Button from './Button.vue'
import { cn } from './cn'

describe('ui primitives', () => {
  it('merges classes without duplicate tailwind conflicts', () => {
    const optionalClass = false
    const className = cn('px-2 text-sm', optionalClass, 'px-4')

    expect(className).toContain('px-4')
    expect(className).not.toContain('px-2')
  })

  it('renders button variants', () => {
    const wrapper = mount(Button, { props: { variant: 'primary' }, slots: { default: 'Start' } })

    expect(wrapper.text()).toBe('Start')
    expect(wrapper.classes().join(' ')).toContain('bg-bh-primary')
  })

  it('merges button fallthrough classes with internal tailwind classes', () => {
    const wrapper = mount(Button, {
      props: { variant: 'ghost' },
      attrs: {
        class: 'justify-start px-3 bg-teal-50 text-bh-primary',
      },
      slots: { default: 'Nav item' },
    })
    const className = wrapper.classes().join(' ')

    expect(className).toContain('justify-start')
    expect(className).toContain('px-3')
    expect(className).toContain('bg-teal-50')
    expect(className).toContain('text-bh-primary')
    expect(className).not.toContain('justify-center')
    expect(className).not.toContain('px-4')
    expect(className).not.toContain('bg-transparent')
    expect(className).not.toContain('text-bh-text')
  })
})
