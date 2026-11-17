import { describe, expect, it } from 'vitest'

import { diffJobListSnapshot, type JobListSnapshot } from './jobListDelta'

function createSnapshot(overrides: Partial<JobListSnapshot> = {}): JobListSnapshot {
  return {
    page: 1,
    listRevision: 1,
    jobIds: ['job-1', 'job-2'],
    ...overrides,
  }
}

describe('diffJobListSnapshot', () => {
  it('recognizes an appended page even when the first job stays unchanged', () => {
    const result = diffJobListSnapshot(
      createSnapshot(),
      createSnapshot({
        page: 2,
        listRevision: 2,
        jobIds: ['job-1', 'job-2', 'job-3', 'job-4'],
      }),
    )

    expect(result).toEqual({
      responded: true,
      pageChanged: true,
      listRevisionChanged: true,
      jobIdsChanged: true,
      addedJobIds: ['job-3', 'job-4'],
    })
  })

  it('recognizes a replaced page and reports every new job', () => {
    const result = diffJobListSnapshot(
      createSnapshot(),
      createSnapshot({
        page: 2,
        listRevision: 2,
        jobIds: ['job-3', 'job-4'],
      }),
    )

    expect(result).toEqual({
      responded: true,
      pageChanged: true,
      listRevisionChanged: true,
      jobIdsChanged: true,
      addedJobIds: ['job-3', 'job-4'],
    })
  })

  it('does not treat a page number change with the same visible jobs as a response', () => {
    const result = diffJobListSnapshot(
      createSnapshot(),
      createSnapshot({
        page: 2,
        listRevision: 2,
      }),
    )

    expect(result).toEqual({
      responded: false,
      pageChanged: true,
      listRevisionChanged: true,
      jobIdsChanged: false,
      addedJobIds: [],
    })
  })

  it('does not report a response while the observed list is unchanged', () => {
    expect(diffJobListSnapshot(createSnapshot(), createSnapshot())).toEqual({
      responded: false,
      pageChanged: false,
      listRevisionChanged: false,
      jobIdsChanged: false,
      addedJobIds: [],
    })
  })

  it('does not treat an internal list revision alone as a response', () => {
    expect(diffJobListSnapshot(createSnapshot(), createSnapshot({ listRevision: 2 }))).toEqual({
      responded: false,
      pageChanged: false,
      listRevisionChanged: true,
      jobIdsChanged: false,
      addedJobIds: [],
    })
  })
})
