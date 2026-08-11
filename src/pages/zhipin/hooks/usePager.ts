import { ref } from 'vue'

import { useHookVueData, useHookVueFn } from '@/composables/useVue'
import { logger } from '@/utils/logger'

const page = ref({ page: 1, pageSize: 15 })
const pageChange = ref<((v: number) => void) | null>(null)
const ready = ref(false)

function assertReady() {
  if (!ready.value || pageChange.value == null) {
    throw new Error('分页器尚未初始化')
  }
  return pageChange.value
}

const initPage = useHookVueData(
  '#wrap .page-job-wrapper,.job-recommend-main,.page-jobs-main',
  'pageVo',
  page,
)

const initChange = useHookVueFn('#wrap .page-job-wrapper', 'pageChangeAction')
const initSearch = useHookVueFn('#wrap .page-job-wrapper,.job-recommend-main,.page-jobs-main', [
  'searchJobAction',
  'onSearch',
])

function getPageCount() {
  const pageData = page.value as {
    pageCount?: unknown
    totalPage?: unknown
    total?: unknown
    pageSize?: unknown
  }
  const explicitPageCount = Number(pageData.pageCount ?? pageData.totalPage)
  if (Number.isFinite(explicitPageCount) && explicitPageCount > 0) {
    return explicitPageCount
  }
  const total = Number(pageData.total)
  const pageSize = Number(pageData.pageSize)
  if (Number.isFinite(total) && Number.isFinite(pageSize) && pageSize > 0) {
    return Math.ceil(total / pageSize)
  }
  return null
}

function next() {
  try {
    const pageCount = getPageCount()
    if (pageCount != null && page.value.page >= pageCount) {
      return false
    }
    assertReady()(page.value.page + 1)
  } catch (err) {
    logger.error('翻页: 下一页错误', err)
    throw err
  }

  return true
}

function prev() {
  try {
    assertReady()(page.value.page - 1)
  } catch (err) {
    logger.error('翻页: 上一页错误', err)
    throw err
  }
  return true
}

function reload(pageNumber = 1) {
  try {
    return assertReady()(pageNumber)
  } catch (err) {
    logger.error('分页器: 重新加载当前来源错误', err)
    throw err
  }
}

export function usePager() {
  return {
    page,
    pageChange,
    ready,
    next,
    prev,
    reload,
    initPager: async () => {
      ready.value = false
      await initPage()
      pageChange.value =
        location.href.includes('/web/geek/job-recommend') ||
        location.href.includes('/web/geek/jobs')
          ? await initSearch()
          : await initChange()
      if (!pageChange.value) {
        throw new Error('pageChange is undefined')
      }
      ready.value = true
    },
  }
}
