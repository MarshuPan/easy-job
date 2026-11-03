import { afterEach, describe, expect, it } from 'vitest'

import {
  clearDeliveryActivity,
  reportDeliveryStage,
  useDeliveryActivity,
  withDeliveryWait,
} from './deliveryActivity'

describe('delivery activity', () => {
  afterEach(() => clearDeliveryActivity())

  it('returns to the interrupted stage after a rate-limit wait', async () => {
    // 限速插在 JD 筛选中间：等完要回到 JD 筛选，不能一直停在「限速等待」直到下一个阶段。
    reportDeliveryStage('JD筛选中')
    const stage = useDeliveryActivity().value

    let during: unknown
    await withDeliveryWait('BOSS 请求限速（岗位详情）', 5_000, async () => {
      during = useDeliveryActivity().value?.label
    })

    expect(during).toBe('BOSS 请求限速（岗位详情）')
    expect(useDeliveryActivity().value).toBe(stage)
  })

  it('does not overwrite a newer stage that started during the wait', async () => {
    reportDeliveryStage('JD筛选中')
    await withDeliveryWait('BOSS 请求限速（建立沟通）', 5_000, async () => {
      reportDeliveryStage('正在建立沟通')
    })
    expect(useDeliveryActivity().value?.label).toBe('正在建立沟通')
  })
})
