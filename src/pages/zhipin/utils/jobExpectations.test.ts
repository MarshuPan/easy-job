import { describe, expect, it } from 'vitest'

import {
  RECOMMENDATION_EXPECTATION_ID,
  extractJobExpectations,
  filterJobsByExpectIds,
  filterJobsByGroupTargets,
  findNativeJobExpectationOption,
  getEnabledJobExpectations,
  getInitialJobExpectation,
  getJobGroupTargetId,
  getJobSourceLabel,
  getRecommendationJobExpectation,
  isGroupExpectationListReady,
  readNativeJobExpectationOptions,
  rebindEnabledJobExpectations,
} from './jobExpectations'

describe('job expectations', () => {
  const expectations = [
    {
      id: '101',
      index: 0,
      positionName: 'AI 产品经理',
      locationName: '上海',
      salaryDesc: '30-50K',
    },
    { id: '202', index: 1, positionName: '产品负责人', locationName: '杭州', salaryDesc: '40-60K' },
  ]

  it('rebinds imported expectations by id first and unique semantics second', () => {
    const available = [
      {
        id: 'new-1',
        index: 0,
        positionName: '产品经理',
        locationName: '上海市',
        salaryDesc: '20-30K',
      },
      {
        id: 'same-id',
        index: 1,
        positionName: 'AI 产品经理',
        locationName: '北京市',
        salaryDesc: '30-40K',
      },
    ]
    const result = rebindEnabledJobExpectations(
      [
        { id: 'same-id', positionName: '旧名称', locationName: '', salaryDesc: '' },
        { id: 'old-1', positionName: '产品经理', locationName: '上海', salaryDesc: '20-30K' },
      ],
      available,
    )

    expect(result.enabledIds).toEqual(['same-id', 'new-1'])
    expect(result.unmatched).toEqual([])
  })

  it('keeps ambiguous imported expectations disabled', () => {
    const configured = {
      id: 'old',
      positionName: '产品经理',
      locationName: '',
      salaryDesc: '',
    }
    const available = [
      { id: '1', index: 0, positionName: '产品经理', locationName: '上海', salaryDesc: '' },
      { id: '2', index: 1, positionName: '产品经理', locationName: '北京', salaryDesc: '' },
    ]

    expect(rebindEnabledJobExpectations([configured], available)).toMatchObject({
      enabledIds: [],
      unmatched: [configured],
    })
  })

  it('extracts only real full-time expectations and keeps stable ids', () => {
    const result = extractJobExpectations({
      expectList: [
        {
          id: '101',
          positionType: 0,
          positionName: 'AI 产品经理',
          locationName: '上海',
          salaryDesc: '30-50K',
        },
        {
          id: 'part-time',
          positionType: 1,
          positionName: '兼职',
          locationName: '上海',
          salaryDesc: '',
        },
        {
          id: '101',
          positionType: 0,
          positionName: '重复项',
          locationName: '上海',
          salaryDesc: '',
        },
      ] as bossZpResumeData['expectList'],
    })

    expect(result).toEqual([expectations[0]])
  })

  it('filters enabled expectations and jobs by expect id', () => {
    expect(getEnabledJobExpectations(expectations, ['202'])).toEqual([expectations[1]])
    expect(
      filterJobsByExpectIds(
        [
          { expectId: 101, name: 'first' },
          { expectId: 202, name: 'second' },
          { expectId: 303, name: 'third' },
        ],
        ['101', '202'],
      ),
    ).toEqual([
      { expectId: 101, name: 'first' },
      { expectId: 202, name: 'second' },
    ])
  })

  it('keeps recommendation jobs inside the group source without inventing a third source', () => {
    const jobs = [
      { expectId: 0, name: 'recommend' },
      { expectId: 101, name: 'first expectation' },
      { expectId: 202, name: 'second expectation' },
      { name: 'unknown target' },
    ]

    expect(filterJobsByGroupTargets(jobs, ['101'], true)).toEqual(jobs.slice(0, 2))
    expect(filterJobsByGroupTargets(jobs, ['202'], false)).toEqual([jobs[2]])
    expect(getJobGroupTargetId(jobs[0])).toBe('recommend')
    expect(getJobGroupTargetId(jobs[1])).toBe('101')
    expect(getJobGroupTargetId(jobs[3])).toBeNull()
    expect(getRecommendationJobExpectation()).toMatchObject({
      id: 'recommend',
      index: -1,
      positionName: '推荐',
    })
  })

  it('uses the captured expectation target when the platform job expectId uses another id space', () => {
    const captured = {
      expectId: 123456789,
      deliveryGroupTargetIds: ['3e70bd760209032133180tu5EFBV'],
      name: 'captured expectation job',
    }

    expect(filterJobsByGroupTargets([captured], ['3e70bd760209032133180tu5EFBV'], false)).toEqual([
      captured,
    ])
    expect(filterJobsByGroupTargets([captured], ['other-expectation'], false)).toEqual([])
  })

  it('accepts an active expectation when the non-empty job list has visibly changed', () => {
    expect(
      isGroupExpectationListReady({
        active: true,
        currentFirstJobId: 'new-first-job',
        currentTargetIds: new Set(['platform-metadata-does-not-match']),
        expectationId: '202',
        listLength: 15,
        previousFirstJobId: 'old-first-job',
        waitedMs: 500,
        wasAlreadyActive: false,
      }),
    ).toBe(true)
  })

  it('does not accept an unchanged mismatched list after clicking another expectation', () => {
    expect(
      isGroupExpectationListReady({
        active: true,
        currentFirstJobId: 'same-first-job',
        currentTargetIds: new Set(['101']),
        expectationId: '202',
        listLength: 15,
        previousFirstJobId: 'same-first-job',
        waitedMs: 5_000,
        wasAlreadyActive: false,
      }),
    ).toBe(false)
  })

  it('uses the concrete expectation name as the delivery source label', () => {
    expect(getJobSourceLabel('search', { expectId: 101 }, expectations)).toBe('搜索')
    expect(getJobSourceLabel('group', { expectId: 0 }, expectations)).toBe('推荐')
    expect(getJobSourceLabel('group', { expectId: 101 }, expectations)).toBe('AI 产品经理')
    expect(getJobSourceLabel('group', { expectId: 999 }, expectations)).toBe('求职期望')
  })

  it('returns every real expectation supplied by the platform', () => {
    const expectList = Array.from({ length: 4 }, (_, index) => ({
      id: String(index + 1),
      positionType: 0,
      positionName: `求职期望 ${index + 1}`,
      locationName: '上海',
      salaryDesc: '',
    })) as bossZpResumeData['expectList']

    expect(extractJobExpectations({ expectList }).map((item) => item.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ])
  })

  it('matches the native BOSS option by id, text, and index fallback', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <button class="synthesis active">推荐</button>
      <div class="expect-list">
        <button class="expect-item" data-expect-id="101"><span class="text-content">AI产品经理（上海）</span></button>
        <button class="expect-item"><span class="text-content">产品负责人（杭州市）</span></button>
      </div>
    `

    expect(readNativeJobExpectationOptions(root)[0]).toMatchObject({
      id: 'recommend',
      index: -1,
      type: 'recommend',
      active: true,
    })
    expect(
      findNativeJobExpectationOption(root, getRecommendationJobExpectation())?.element.className,
    ).toContain('synthesis')
    expect(findNativeJobExpectationOption(root, expectations[0])?.id).toBe('101')
    expect(findNativeJobExpectationOption(root, expectations[1])?.active).toBe(false)
    expect(getInitialJobExpectation(expectations, root)?.id).toBe('101')
    expect(
      findNativeJobExpectationOption(root, {
        id: 'missing',
        index: 1,
        positionName: '不存在',
        locationName: '',
        salaryDesc: '',
      })?.index,
    ).toBe(1)
  })
})

describe('getJobSourceLabel 的分组名', () => {
  it('期望被停用后仍然说得出是哪个分组', () => {
    // 名字只存在于「当前启用」的期望列表里。用户把某个期望关掉之后，投递记录里那些岗位
    // 的来源就全变成笼统的「求职期望」——配了多个期望时等于没说。入池时刻下来的名字
    // 不受启用状态影响。
    const job = { deliveryGroupTargetIds: ['expect-a'], deliveryGroupName: 'AI产品经理(上海)' }
    expect(getJobSourceLabel('group', job, [])).toBe('AI产品经理(上海)')
  })

  it('启用列表里查得到时以列表为准，用户改了期望名能立刻反映', () => {
    const job = { deliveryGroupTargetIds: ['expect-a'], deliveryGroupName: '旧名字' }
    expect(getJobSourceLabel('group', job, [{ id: 'expect-a', positionName: '新名字' }])).toBe(
      '新名字',
    )
  })

  it('搜索来源永远只叫「搜索」，不显示搜索词', () => {
    expect(
      getJobSourceLabel('search', { deliveryGroupName: 'AI产品经理', expectId: 123456789 }, []),
    ).toBe('搜索')
  })

  it('推荐分组仍然叫「推荐」', () => {
    expect(
      getJobSourceLabel('group', { deliveryGroupTargetIds: [RECOMMENDATION_EXPECTATION_ID] }, []),
    ).toBe('推荐')
  })
})
