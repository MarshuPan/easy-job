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
    responded:
      after.page !== before.page || after.listRevision !== before.listRevision || jobIdsChanged,
  }
}
