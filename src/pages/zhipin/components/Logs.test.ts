import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import Logs from './Logs.vue'

const { clear, eventData, info, recordData, runtimeData, success, writeText } = vi.hoisted(() => ({
  clear: vi.fn(),
  info: vi.fn(),
  eventData: {
    value: [
      {
        title: '投递任务',
        state: 'info' as const,
        state_name: '消息',
        message: '补池：搜索新增 15 个（翻 1 页）',
        createdAt: new Date('2026-07-06T08:33:50Z').getTime(),
      },
    ] as any[],
  },
  runtimeData: {
    value: [
      {
        title: 'AI匹配度',
        state: 'danger' as const,
        state_name: 'AI请求异常',
        message: 'AI请求失败，状态码：400',
        data: {
          trace: [
            {
              at: new Date('2026-07-06T08:33:52Z').getTime(),
              status: 'danger' as const,
              stage: 'AI匹配度',
              message: 'AI匹配度评估失败',
              detail: {
                jobId: 'job-id-must-remain-visible',
                authorization: 'Bearer authorization-secret',
                nested: { bridgeToken: 'bridge-token-secret', lid: 'lid-secret' },
                headers: { Cookie: 'cookie-secret', api_key: 'api-key-secret' },
              },
            },
          ],
        },
        createdAt: new Date('2026-07-06T08:33:52Z').getTime(),
      },
    ] as any[],
  },
  recordData: {
    value: [
      {
        title: '岗位记录不该出现在运行日志里',
        state: 'success' as const,
        state_name: '投递成功',
        createdAt: new Date('2026-07-06T08:34:00Z').getTime(),
      },
    ] as any[],
  },
  success: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('@/stores/log', async () => {
  const actual = await vi.importActual<typeof import('@/stores/log')>('@/stores/log')
  return {
    ...actual,
    useLog: () => {
      for (const record of runtimeData.value) {
        record.publicData ??= actual.toPublicLogData(record.data)
      }
      return {
        data: recordData,
        events: eventData,
        runtimeData,
        clear,
      }
    },
  }
})

vi.mock('@/ui/instrument', () => ({
  AgentButton: {
    name: 'AgentButton',
    props: ['disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
  },
  AgentMessage: {
    success,
    info,
  },
  AgentSwitch: {
    name: 'AgentSwitch',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input data-test="diagnostics" type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
  AgentTag: {
    name: 'AgentTag',
    props: ['title'],
    template: '<span data-test="log-state" :title="title"><slot /></span>',
  },
}))

describe('Logs', () => {
  const initialEvents = eventData.value

  beforeEach(() => {
    vi.clearAllMocks()
    eventData.value = initialEvents
    window.localStorage.clear()
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    })
  })

  it('shows run events and AI request diagnostics, never job records', () => {
    const wrapper = mount(Logs)

    expect(wrapper.findAll('.console-log__entry')).toHaveLength(2)
    expect(wrapper.text()).toContain('补池：搜索新增 15 个')
    expect(wrapper.text()).toContain('AI请求失败，状态码：400')
    expect(wrapper.text()).not.toContain('岗位记录不该出现在运行日志里')
  })

  it('copies all logs from one toolbar action with secrets redacted', async () => {
    const wrapper = mount(Logs)

    await wrapper
      .findAll('button')
      .find((button) => button.text() === '复制全部')!
      .trigger('click')

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0]![0] as string
    expect(copied).toContain('运行日志（共 2 条）')
    expect(copied).toContain('# 1 / 2')
    expect(copied).toContain('AI匹配度评估失败')
    expect(copied).toContain('# 2 / 2')
    expect(copied).toContain('补池：搜索新增 15 个')
    expect(copied).toContain('job-id-must-remain-visible')
    expect(copied).toContain('[已脱敏]')
    for (const secret of [
      'Bearer authorization-secret',
      'bridge-token-secret',
      'cookie-secret',
      'api-key-secret',
    ]) {
      expect(copied).not.toContain(secret)
    }
    expect(success).toHaveBeenCalledWith('日志已复制')
  })

  it('does not render per-entry copy buttons', () => {
    const wrapper = mount(Logs)

    expect(wrapper.text()).toContain('复制全部')
    expect(wrapper.findAll('button').filter((button) => button.text() === '复制')).toHaveLength(0)
  })

  it('shows compact summaries by default and expands the request trace on demand', async () => {
    const wrapper = mount(Logs)

    expect(wrapper.findAll('.console-log__detail')).toHaveLength(0)
    expect(wrapper.findAll('.console-log__title')[0]!.text()).toBe('AI匹配度')
    expect(wrapper.findAll('[data-test="log-state"]')[0]!.attributes('title')).toBe('AI请求异常')

    await wrapper.findAll('.console-log__summary')[0]!.trigger('click')

    expect(wrapper.findAll('.console-log__detail')).toHaveLength(1)
    expect(wrapper.find('.console-log__detail').text()).toContain(
      'danger / AI匹配度: AI匹配度评估失败',
    )
    expect(wrapper.findAll('.console-log__summary')[0]!.attributes('aria-expanded')).toBe('true')
  })

  it('shows only the newest 200 entries', () => {
    eventData.value = Array.from({ length: 250 }, (_, index) => ({
      title: '投递任务',
      state: 'info' as const,
      state_name: '消息',
      message: `事件 ${index + 1}`,
      createdAt: Date.now() + index,
    }))

    const wrapper = mount(Logs)

    expect(wrapper.findAll('.console-log__entry')).toHaveLength(200)
    expect(wrapper.text()).toContain('事件 250')
    expect(wrapper.text()).not.toContain('事件 50')
  })

  it('turns diagnostics mode on and off from the toolbar', async () => {
    const wrapper = mount(Logs)
    const toggle = wrapper.find('[data-test="diagnostics"]')

    await toggle.setValue(true)
    expect(window.localStorage.getItem('agent-delivery:diagnostics')).toBe('1')

    await toggle.setValue(false)
    expect(window.localStorage.getItem('agent-delivery:diagnostics')).toBeNull()
  })
})
