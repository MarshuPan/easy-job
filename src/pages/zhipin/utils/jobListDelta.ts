export interface JobListSnapshot {
  page: number
  listRevision: number
  jobIds: string[]
}

export function diffJobListSnapshot(before: JobListSnapshot, after: JobListSnapshot) {
  const beforeIds = new Set(before.jobIds)
  const addedJobIds = after.jobIds.filter((jobId) => jobId && !beforeIds.has(jobId))
  const jobIdsChanged =
    before.jobIds.length !== after.jobIds.length ||
    before.jobIds.some((jobId, index) => jobId !== after.jobIds[index])

  return {
    addedJobIds,
    pageChanged: after.page !== before.page,
    listRevisionChanged: after.listRevision !== before.listRevision,
    jobIdsChanged,
    // BOSS updates the pager state before it replaces the visible list. A page
    // number or an internal revision by itself is therefore not evidence that
    // the requested page has arrived. The caller must keep waiting for a real
    // list transition (including an empty list transition).
    responded: jobIdsChanged,
  }
}
