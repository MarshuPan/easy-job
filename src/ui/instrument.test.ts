import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import {
  AgentAlert,
  AgentButton,
  AgentDialog,
  AgentDrawer,
  AgentInput,
  AgentInputNumber,
  AgentMessage,
  AgentSelect,
  AgentSlider,
  AgentSwitch,
  AgentTable,
  AgentTableColumn,
  AgentTooltip,
} from './instrument'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('agent instrument controls', () => {
  it('creates and removes values in the Vue tag selector', async () => {
    const wrapper = mount(AgentSelect, {
      attachTo: document.body,
      props: {
        modelValue: ['AI 产品经理'],
        multiple: true,
        filterable: true,
        allowCreate: true,
        options: [{ label: '产品负责人', value: '产品负责人' }],
        'onUpdate:modelValue': (value: unknown) => wrapper.setProps({ modelValue: value }),
      },
    })

    const input = wrapper.get('input')
    await input.setValue('商业化产品')
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(['AI 产品经理', '商业化产品'])
    expect(wrapper.text()).toContain('商业化产品')

    await wrapper.get('[aria-label="移除 商业化产品"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(['AI 产品经理'])
  })

  it('collapses long tag lists and keeps create-on-enter available when expanded', async () => {
    const wrapper = mount(AgentSelect, {
      attachTo: document.body,
      props: {
        modelValue: ['岗位一', '岗位二', '岗位三', '岗位四'],
        multiple: true,
        filterable: true,
        allowCreate: true,
        collapseTags: true,
        maxCollapseTags: 2,
        placeholder: '输入岗位名称后回车',
        'onUpdate:modelValue': (value: unknown) => wrapper.setProps({ modelValue: value }),
      },
    })

    expect(wrapper.classes()).toContain('is-tags-collapsed')
    expect(wrapper.text()).toContain('岗位一')
    expect(wrapper.text()).toContain('岗位二')
    expect(wrapper.text()).toContain('+2')
    expect(wrapper.text()).not.toContain('岗位三')

    await wrapper.get('.agent-ui-select__wrapper').trigger('click')
    expect(wrapper.classes()).toContain('is-tags-expanded')
    expect(wrapper.find('.agent-ui-select__collapse-tag').exists()).toBe(false)
    expect(wrapper.find('.agent-ui-select__selection').exists()).toBe(false)
    expect(wrapper.findAll('.agent-ui-select__tag-list > .agent-ui-tag')).toHaveLength(4)
    expect(wrapper.get('input').attributes('placeholder')).toBe('输入岗位名称后回车')
    expect(wrapper.text()).toContain('岗位四')

    await wrapper.get('.agent-ui-select__wrapper').trigger('click')
    expect(wrapper.classes()).toContain('is-tags-collapsed')
    await wrapper.get('[aria-label="展开选项"]').trigger('click')

    const input = wrapper.get('input')
    await input.setValue('岗位五')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      '岗位一',
      '岗位二',
      '岗位三',
      '岗位四',
      '岗位五',
    ])
    expect(wrapper.text()).toContain('岗位五')

    const outsideAction = vi.fn()
    const outsideButton = document.createElement('button')
    outsideButton.addEventListener('click', outsideAction)
    document.body.append(outsideButton)
    outsideButton.click()
    await wrapper.vm.$nextTick()
    expect(outsideAction).toHaveBeenCalledOnce()
    expect(wrapper.classes()).toContain('is-tags-collapsed')
    expect(wrapper.text()).toContain('+3')

    await wrapper.get('[aria-label="展开选项"]').trigger('click')
    await wrapper.get('[aria-label="收起选项"]').trigger('click')
    expect(wrapper.classes()).toContain('is-tags-collapsed')
    expect(wrapper.text()).toContain('+3')
    expect(wrapper.text()).not.toContain('岗位五')
  })

  it('selects multiple predefined options without a native listbox', async () => {
    const wrapper = mount(AgentSelect, {
      attachTo: document.body,
      props: {
        modelValue: [],
        multiple: true,
        options: [
          { label: '不限', value: '0' },
          { label: '三年以上', value: '106' },
        ],
        'onUpdate:modelValue': (value: unknown) => wrapper.setProps({ modelValue: value }),
      },
    })

    await wrapper.get('.agent-ui-select__value').trigger('click')
    await wrapper.findAll('.agent-ui-select__option')[1].trigger('click')

    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(['106'])
    expect(wrapper.text()).toContain('三年以上')
  })

  it('anchors option lists to the viewport without changing scroll layout', async () => {
    const view = document.createElement('div')
    view.className = 'agent-delivery-view'
    document.body.append(view)
    const anchorBox = {
      x: 320,
      y: 180,
      top: 180,
      right: 740,
      bottom: 214,
      left: 320,
      width: 420,
      height: 34,
      toJSON: () => ({}),
    }
    const viewBox = {
      x: 200,
      y: 80,
      top: 80,
      right: 900,
      bottom: 700,
      left: 200,
      width: 700,
      height: 620,
      toJSON: () => ({}),
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('agent-delivery-view')) return viewBox
        if (this.classList.contains('agent-ui-select__wrapper')) return anchorBox
        return {
          x: 0,
          y: 0,
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        }
      },
    )

    const wrapper = mount(AgentSelect, {
      attachTo: view,
      props: {
        modelValue: '',
        options: [
          { label: '不限', value: '0' },
          { label: '三年以上', value: '106' },
        ],
      },
    })

    await wrapper.get('.agent-ui-select__value').trigger('click')
    await wrapper.vm.$nextTick()

    const popperStyle = wrapper.get('.agent-ui-select__popper').attributes('style')
    expect(popperStyle).toContain('position: fixed')
    expect(popperStyle).toContain('top: 219px')
    expect(popperStyle).toContain('left: 320px')
    expect(popperStyle).toContain('width: 420px')
  })

  it('renders model option and selected-label slots from the source item', async () => {
    const wrapper = mount(AgentSelect, {
      props: {
        modelValue: 'model-1',
        options: [{ key: 'model-1', name: '私有模型' }],
        optionProps: { label: 'name', value: 'key' },
      },
      slots: {
        default: ({ item }: { item: { name: string } }) =>
          h('span', { class: 'option-slot' }, `选项:${item.name}`),
        label: ({ label }: { label: string }) =>
          h('span', { class: 'label-slot' }, `当前:${label}`),
      },
    })

    expect(wrapper.get('.label-slot').text()).toBe('当前:私有模型')
    await wrapper.get('.agent-ui-select__value').trigger('click')
    expect(wrapper.get('.option-slot').text()).toBe('选项:私有模型')
  })

  it('honors textarea autosize rows and slider numeric input', async () => {
    const input = mount(AgentInput, {
      props: { modelValue: '提示词', type: 'textarea', autosize: { minRows: 5, maxRows: 8 } },
    })
    expect(input.get('textarea').attributes('rows')).toBe('5')
    expect(input.get('textarea').attributes('autosize')).toBeUndefined()

    const number = mount(AgentInputNumber, {
      props: { modelValue: 30 },
      attrs: { style: 'width: 105px', 'data-test': 'delay' },
    })
    expect(number.get('.agent-ui-input-number').attributes('style')).toContain('width: 105px')
    expect(number.get('input').attributes('data-test')).toBe('delay')
    expect(number.get('input').attributes('style')).toBeUndefined()

    const slider = mount(AgentSlider, { props: { modelValue: 40, showInput: true } })
    await slider.get('.agent-ui-slider__input input').setValue('65')
    expect(slider.emitted('update:modelValue')?.at(-1)?.[0]).toBe(65)
  })

  it('emits switch state and keeps the control keyboard-addressable', async () => {
    const wrapper = mount(AgentSwitch, { props: { modelValue: false } })

    await wrapper.get('input').setValue(true)

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([true])
    expect(wrapper.get('input').attributes('type')).toBe('checkbox')
  })

  it('closes a teleported drawer through the themed icon button', async () => {
    const wrapper = mount(AgentDrawer, {
      attachTo: document.body,
      props: { modelValue: true, title: '流程详情' },
      slots: { default: '详情内容' },
    })

    expect(document.body.textContent).toContain('详情内容')
    document
      .querySelector<HTMLButtonElement>('.agent-ui-drawer__close-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('normalizes dialog dimensions and respects modeless escape behavior', async () => {
    const wrapper = mount(AgentDialog, {
      attachTo: document.body,
      props: {
        modelValue: true,
        title: '模型测试',
        width: '800',
        height: '80vh',
        zIndex: 21,
        modal: false,
        closeOnPressEscape: false,
      },
    })

    const overlay = document.querySelector<HTMLElement>('.agent-ui-overlay')
    const dialog = document.querySelector<HTMLElement>('.agent-ui-dialog')
    expect(overlay?.classList.contains('is-modeless')).toBe(true)
    expect(overlay?.style.zIndex).toBe('2147483521')
    expect(dialog?.style.width).toBe('800px')
    expect(dialog?.style.height).toBe('80vh')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await wrapper.setProps({ closeOnPressEscape: true })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })

  it('expands table detail rows through the controlled key list', async () => {
    const row = { key: 'job-1', name: 'AI 产品经理' }
    const wrapper = mount(AgentTable, {
      props: { data: [row], rowKey: 'key', expandRowKeys: [] },
      slots: {
        default: () => [
          h(
            AgentTableColumn,
            { type: 'expand' },
            { default: ({ row: item }: { row: typeof row }) => `详情:${item.name}` },
          ),
          h(AgentTableColumn, { prop: 'name', label: '岗位' }),
        ],
      },
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('详情:AI 产品经理')
    await wrapper.get('.agent-ui-table__expand').trigger('click')
    expect(wrapper.emitted('expand-change')?.[0]?.[0]).toEqual(row)
    await wrapper.setProps({ expandRowKeys: ['job-1'] })
    expect(wrapper.text()).toContain('详情:AI 产品经理')
  })

  it('renders raw tooltip descriptions without exposing markup', () => {
    const wrapper = mount(AgentTooltip, {
      props: { content: '<span>说明文字</span>', rawContent: true },
      slots: { default: '帮助' },
    })

    expect(wrapper.get('.agent-ui-tooltip__content').text()).toBe('说明文字')
    expect(wrapper.html()).not.toContain('&lt;span&gt;')
  })

  it('renders buttons and transient messages with the new theme classes', async () => {
    vi.useFakeTimers()
    const wrapper = mount(AgentButton, { slots: { default: '保存' } })

    expect(wrapper.get('button').classes()).toContain('agent-ui-button')
    const alert = mount(AgentAlert, {
      props: { title: '配置说明', type: 'info', showIcon: true, closable: false },
    })
    expect(alert.find('svg.agent-ui-alert__icon').exists()).toBe(true)
    AgentMessage.success('规则已保存', 50)
    expect(document.querySelector('.agent-ui-message--success')?.textContent).toContain(
      '规则已保存',
    )
    AgentMessage.error(new Error('HTTP 500 at C:\\secret\\provider.ts:12'), 50)
    const safeError = document.querySelector('.agent-ui-message--error')?.textContent ?? ''
    expect(safeError).toContain('操作失败，请稍后重试')
    expect(safeError).not.toContain('HTTP 500')
    expect(safeError).not.toContain('provider.ts')

    await vi.advanceTimersByTimeAsync(250)
    expect(document.querySelector('.agent-ui-message--success')).toBeNull()
  })

  it('keeps one message container and moves it into the job workspace', () => {
    vi.useFakeTimers()
    AgentMessage.info('面板挂载前')
    const container = document.getElementById('agent-ui-message-container')
    expect(container?.parentElement).toBe(document.body)

    const jobRoot = document.createElement('div')
    jobRoot.id = 'agent-delivery-job'
    const messageHost = document.createElement('div')
    messageHost.setAttribute('data-agent-message-host', '')
    jobRoot.appendChild(messageHost)
    document.body.appendChild(jobRoot)

    AgentMessage.warning('面板内通知')

    expect(document.querySelectorAll('#agent-ui-message-container')).toHaveLength(1)
    expect(container?.parentElement).toBe(messageHost)
    expect(container?.textContent).toContain('面板挂载前')
    expect(container?.textContent).toContain('面板内通知')
  })

  it('forwards embedded-page messages without rendering a second local container', () => {
    const parentDescriptor = Object.getOwnPropertyDescriptor(window, 'parent')
    const postMessage = vi.fn()
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage },
    })

    try {
      AgentMessage.success('模型已保存', 1200)

      expect(postMessage).toHaveBeenCalledWith(
        {
          channel: 'agent-delivery:ui-message',
          version: 1,
          type: 'success',
          content: '模型已保存',
          duration: 1200,
        },
        '*',
      )
      expect(document.getElementById('agent-ui-message-container')).toBeNull()
    } finally {
      if (parentDescriptor) Object.defineProperty(window, 'parent', parentDescriptor)
    }
  })
})
