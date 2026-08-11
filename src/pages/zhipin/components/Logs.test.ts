import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import Logs from './Logs.vue'

const { clear, info, logData, success, writeText } = vi.hoisted(() => ({
  clear: vi.fn(),
  info: vi.fn(),
  logData: {
    value: [
      {
        title: '获取岗位',
        state: 'info' as const,
        state_name: '消息',
        message: '本次获取到 15 个',
        createdAt: new Date('2026-07-06T08:33:50Z').getTime(),
      },
      {
        title: 'AI产品经理-抖音电商',
        state: 'danger' as const,
        state_name: 'AI请求异常',
        message: 'AI请求失败，状态码：400',
        data: {
          listData: {
            encryptJobId: 'job-id-must-remain-visible',
            jobName: 'AI产品经理-抖音电商',
            securityId: 'security-id-secret',
          },
          bossData: {
            encryptBossId: 'boss-id-secret',
            encryptUserId: 'user-id-secret',
          },
          state: '失败',
          err: 'openai_error',
          trace: [
            {
              at: new Date('2026-07-06T08:33:52Z').getTime(),
              status: 'danger' as const,
              stage: 'AI匹配度',
              message: 'AI匹配度评估失败',
              detail: {
                authorization: 'Bearer authorization-secret',
                nested: { bridgeToken: 'bridge-token-secret', lid: 'lid-secret' },
              },
            },
          ],
          greetingSend: {
            ok: false,
            type: 'ai' as const,
            detail: { Cookie: 'cookie-secret', api_key: 'api-key-secret' },
          },
        },
        createdAt: new Date('2026-07-06T08:33:52Z').getTime(),
      },
    ],
  },
  success: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('@/stores/log', async () => {
  const actual = await vi.importActual<typeof import('@/stores/log')>('@/stores/log')
  return {
    ...actual,
    useLog: () => {
      for (const record of logData.value as any[]) {
        record.publicData ??= actual.toPublicLogData(record.data)
      }
      return {
        data: logData,
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
  AgentEmpty: {
    name: 'AgentEmpty',
    template: '<div data-test="empty"><slot /></div>',
  },
  AgentMessage: {
    success,
    info,
  },
  AgentTag: {
    name: 'AgentTag',
    props: ['title'],
    template: '<span data-test="log-state" :title="title"><slot /></span>',
  },
}))

describe('Logs', () => {
  const initialLogs = logData.value

  beforeEach(() => {
    vi.clearAllMocks()
    logData.value = initialLogs
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    })
  })

  it('copies all logs from one toolbar action', async () => {
    const wrapper = mount(Logs)

    await wrapper
      .findAll('button')
      .find((button) => button.text() === '复制全部')!
      .trigger('click')

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0]![0] as string
    expect(copied).toContain('运行日志（共 2 条）')
    expect(copied).toContain('# 1 / 2')
    expect(copied).toContain('获取岗位')
    expect(copied).toContain('# 2 / 2')
    expect(copied).toContain('AI产品经理-抖音电商')
    expect(copied).toContain('--- 流程追踪 ---')
    expect(copied).toContain('job-id-must-remain-visible')
    expect(copied).toContain('[已脱敏]')
    for (const secret of [
      'security-id-secret',
      'boss-id-secret',
      'user-id-secret',
      'Bearer authorization-secret',
      'bridge-token-secret',
      'lid-secret',
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

  it('shows compact summaries by default and expands raw details on demand', async () => {
    const wrapper = mount(Logs)

    expect(wrapper.findAll('.console-log__detail')).toHaveLength(0)
    expect(wrapper.findAll('.console-log__summary')).toHaveLength(2)
    expect(wrapper.text()).toContain('本次获取到 15 个')
    expect(wrapper.text()).not.toContain('--- 原始数据 ---')
    expect(wrapper.findAll('.console-log__title')[0]!.text()).toBe('AI产品经理-抖音电商')
    expect(wrapper.findAll('[data-test="log-state"]')[0]!.attributes('title')).toBe('AI请求异常')

    await wrapper.findAll('.console-log__summary')[0]!.trigger('click')

    expect(wrapper.findAll('.console-log__detail')).toHaveLength(1)
    expect(wrapper.find('.console-log__detail').text()).toContain('--- 原始数据 ---')
    expect(wrapper.findAll('.console-log__summary')[0]!.attributes('aria-expanded')).toBe('true')
  })

  it('renders a large live log set from cached public data without traversing runtime objects', () => {
    logData.value = Array.from({ length: 200 }, (_, index) => ({
      title: `运行中岗位 ${index + 1}`,
      state: 'info' as const,
      state_name: '处理中',
      data: Object.defineProperty({}, 'unsafeRuntimeValue', {
        enumerable: true,
        get() {
          throw new Error('runtime data must not be traversed while rendering')
        },
      }),
      publicData: {
        listData: {
          encryptJobId: `job-${index + 1}`,
          jobName: `运行中岗位 ${index + 1}`,
        },
        deliveryStage: 'JD筛选中' as const,
      },
      createdAt: Date.now() + index,
    })) as any

    const wrapper = mount(Logs)

    expect(wrapper.findAll('.console-log__entry')).toHaveLength(200)
    expect(wrapper.text()).toContain('运行中岗位 200')
  })
})
