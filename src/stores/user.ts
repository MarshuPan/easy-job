import { ref } from 'vue'

import { useStatistics } from '@/composables/useStatistics'
import { getRootVue } from '@/composables/useVue'
import { counter } from '@/message'
import type { CookieInfo } from '@/message'
import { formDataKey, useConf } from '@/stores/conf'
import { AgentMessage } from '@/ui/instrument'
import { isPlainObject, jsonClone } from '@/utils/deepmerge'
import { logger } from '@/utils/logger'

export interface UserInfo {
  userId: number
  identity: number
  encryptUserId: string
  name: string
  showName: string
  tinyAvatar: string
  largeAvatar: string
  token: string
  isHunter: boolean
  clientIP: string
  email: any
  phone: any
  brandName: any
  doubleIdentity: boolean
  recruit: boolean
  agentRecruit: boolean
  industryCostTag: number
  gender: number
  trueMan: boolean
  studentFlag: boolean
  completeDayStatus: boolean
  complete: boolean
  multiExpect: boolean
}

export const UserResumeStringOptions = {
  基本信息: {
    姓名: false,
    年龄: true,
    性别: true,
    学历: true,
    求职状态: true,
    工作年限: true,
  }, // ?? false,
  期望职位: true,
  个人优势: true,
  工作经历: true,
  项目经历: true,
  教育经历: true,
  资格证书: true,
  志愿者经历: true,
}

const info = ref<UserInfo>()
const resume = ref<bossZpResumeData>()
let resumeRequest: Promise<bossZpResumeData> | undefined

export interface ChangeUserOptions {
  saveCurrent?: boolean
  persistCurrent?: (snapshot: CookieInfo) => Promise<void>
  switchAccount?: (uid: string) => Promise<void>
}

export interface InitUserOptions {
  pollIntervalMs?: number
  timeoutMs?: number
}

function isStatisticsSnapshot(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    return isPlainObject(parsed) && isPlainObject(parsed.t) && Array.isArray(parsed.s)
  } catch {
    return false
  }
}

function assertValidAccountSnapshot(snapshot: CookieInfo) {
  if (typeof snapshot.uid !== 'string' || snapshot.uid.length === 0) {
    throw new Error('账号快照格式损坏')
  }
  if (snapshot.form != null && !isPlainObject(snapshot.form)) {
    throw new Error('账号配置快照格式损坏')
  }
  if (snapshot.statistics != null && !isStatisticsSnapshot(snapshot.statistics)) {
    throw new Error('账号统计快照格式损坏')
  }
}

export function useUser() {
  function getUserId(): number | string | null {
    return info.value?.userId ?? window?._PAGE?.uid ?? window?._PAGE?.userId
  }

  async function initUser(options: InitUserOptions = {}): Promise<UserInfo | null> {
    const now = Date.now()
    const pollIntervalMs = options.pollIntervalMs ?? 400
    const timeoutMs = options.timeoutMs ?? 25_000
    let rootTimeout: ReturnType<typeof setTimeout> | undefined
    let v: Awaited<ReturnType<typeof getRootVue>> | null
    try {
      v = await Promise.race([
        getRootVue(),
        new Promise<null>((resolve) => {
          rootTimeout = setTimeout(() => resolve(null), timeoutMs)
        }),
      ])
    } catch (error) {
      logger.error('获取用户信息失败', now, { error, info })
      return null
    } finally {
      if (rootTimeout != null) clearTimeout(rootTimeout)
    }
    if (!v) {
      logger.error('获取用户信息失败', now, { root: v, info })
      return null
    }

    const readUserInfo = () => v.$store?.state?.userInfo as UserInfo | undefined
    const initialUserInfo = readUserInfo()
    if (initialUserInfo) {
      info.value = initialUserInfo
      logger.debug('用户信息获取成功: ', now, initialUserInfo)
      return initialUserInfo
    }

    const remainingTimeoutMs = Math.max(0, timeoutMs - (Date.now() - now))
    if (remainingTimeoutMs === 0) {
      logger.error('获取用户信息失败', now, { root: v, info })
      return null
    }
    return new Promise((resolve) => {
      const finish = (value: UserInfo | null) => {
        clearInterval(interval)
        clearTimeout(timeout)
        resolve(value)
      }
      const interval = setInterval(() => {
        const userInfo = readUserInfo()
        if (!userInfo) return
        info.value = userInfo
        logger.debug('用户信息获取成功: ', now, userInfo)
        finish(userInfo)
      }, pollIntervalMs)
      const timeout = setTimeout(() => {
        logger.error('获取用户信息失败', now, { root: v, info })
        finish(null)
      }, remainingTimeoutMs)
    })
  }

  async function saveUser({ uid }: { uid: string | number | null }) {
    if (uid == null) {
      uid = getUserId()
    }

    const { formData } = useConf()

    if (uid == null) {
      throw new Error('找不到uid')
    }
    uid = String(uid)

    const val: CookieInfo = {
      uid,
      user: info.value?.showName ?? info.value?.name ?? '未知用户',
      avatar: info.value?.tinyAvatar ?? info.value?.largeAvatar ?? '',
      remark: '',
      gender: info.value?.gender === 0 ? 'man' : 'woman',
      flag: info.value?.studentFlag ? 'student' : 'staff',
      date: new Date().toLocaleString(),
      form: jsonClone(formData),
      statistics: await useStatistics().getStatistics(),
    }
    logger.debug('开始创建账户', info.value, val)
    return val
  }

  async function changeUser(currentRow?: CookieInfo, options: ChangeUserOptions = {}) {
    if (!currentRow) {
      AgentMessage.error('请先选择要切换的账号')
      return
    }

    assertValidAccountSnapshot(currentRow)
    const targetAccount = jsonClone(currentRow)
    const statistics = useStatistics()
    const sourceUid = getUserId()
    const sourceAccountState = {
      form: jsonClone(useConf().formData),
      statistics: await statistics.getStatistics(),
    }
    if (options.saveCurrent === true) {
      if (options.persistCurrent == null) {
        throw new Error('当前安全上下文不能持久化源账号，请从受信任扩展上下文提供保存回调')
      }
      await options.persistCurrent(await saveUser({ uid: getUserId() }))
    }

    try {
      await statistics.setAccountScope(targetAccount.uid)
      if (targetAccount.form) {
        await counter.storageSet(formDataKey, targetAccount.form)
      }
      if (targetAccount.statistics != null) {
        await statistics.setStatistics(targetAccount.statistics)
      }
      await options.switchAccount?.(targetAccount.uid)
    } catch (error) {
      const restoreSourceStatistics = async () => {
        if (sourceUid != null) await statistics.setAccountScope(sourceUid)
        await statistics.setStatistics(sourceAccountState.statistics)
      }
      const rollbackResults = await Promise.allSettled([
        counter.storageSet(formDataKey, sourceAccountState.form),
        restoreSourceStatistics(),
      ])
      const rollbackErrors = rollbackResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      if (rollbackErrors.length > 0) {
        logger.error('账号状态回滚失败', rollbackErrors)
      }
      throw error
    }
  }

  async function getUserResumeString(options: Partial<typeof UserResumeStringOptions>) {
    options = {
      ...UserResumeStringOptions,
      ...options,
    }

    const data = await getUserResumeData()
    const genUserResumeStatus = function (v: number) {
      switch (v) {
        case 0:
          return '离职-随时到岗'
        case 1:
          return '在职-暂不考虑'
        case 2:
          return '在职-考虑机会'
        case 3:
          return '在职-月内到岗'
        default:
          return '未知'
      }
    }
    let template = ''
    if (typeof options.基本信息 === 'object') {
      template += `## 基本信息`
      if (options.基本信息.姓名 && data.baseInfo?.nickName) {
        template += `\n- 姓名: ${data.baseInfo.nickName}`
      }
      if (options.基本信息.年龄 && data.baseInfo?.age) {
        template += `\n- 年龄: ${data.baseInfo.age}`
      }
      if (options.基本信息.性别 && data.baseInfo?.gender) {
        template += `\n- 性别: ${data.baseInfo.gender === 1 ? '男' : '女'}`
      }
      if (options.基本信息.学历 && data.baseInfo?.degreeCategory) {
        template += `\n- 学历: ${data.baseInfo.degreeCategory}`
      }
      if (options.基本信息.工作年限 && data.baseInfo?.workYearDesc) {
        template += `\n- 工作年限: ${data.baseInfo.workYearDesc}`
      }
      if (options.基本信息.求职状态 && data.applyStatus) {
        template += `\n- 求职状态: ${genUserResumeStatus(data.applyStatus ?? 0)}`
      }
    }
    const expectList = data.expectList?.filter((item) => item?.positionType === 0)
    if (options.期望职位 && expectList && expectList.length > 0) {
      template += `\n\n## 期望职位
${expectList?.map((item) => `- ${item?.positionName} ${item?.salaryDesc}`).join('\n')}`
    }
    if (options.个人优势 && data.userDesc) {
      template += `\n\n## 个人优势

<个人优势>
${data.userDesc}
</个人优势>`
    }
    if (options.工作经历 && data.workExpList != null && data.workExpList.length > 0) {
      template += `\n\n## 工作经历
${data.workExpList
  ?.map(
    (item) => `
### ${item?.companyName} (${item?.positionName}) ${item?.startDate}-${item?.endDate}

相关技能: ${item?.emphasis?.map((e) => `\`${e}\``).join(' ')}
${
  item?.workContent
    ? `<工作内容>
${item.workContent}
</工作内容>`
    : ''
}
${
  item?.workPerformance
    ? `<工作业绩>
${item.workPerformance}
</工作业绩>`
    : ''
}
`,
  )
  .join('\n')}`
    }
    if (options.项目经历 && data.projectExpList && data.projectExpList.length > 0) {
      template += `\n\n## 项目经历
${data.projectExpList
  ?.map(
    (item) => `
### ${item?.name} (${item?.roleName}) ${item?.startDate}-${item?.endDate}
<项目描述>
${item?.projectDesc}
</项目描述>
<项目业绩>
${item?.performance}
</项目业绩>
`,
  )
  .join('\n')}`
    }
    if (options.教育经历 && data.educationExpList && data.educationExpList.length > 0) {
      template += `\n## 教育经历
${data.educationExpList
  ?.map(
    (item) => `- ${item?.school} ${item?.startYear}-${item?.endYear}
    ${item?.degreeName}`,
  )
  .join('\n')}`
    }
    if (options.资格证书 && data.certificationList && data.certificationList.length > 0) {
      template += `\n## 资格证书:
${data.certificationList?.map((item) => `- ${item?.certName}`).join('\n')}
`
    }
    if (options.志愿者经历 && data.volunteerExpList && data.volunteerExpList.length > 0) {
      template += `\n## 志愿者经历:
${data.volunteerExpList
  ?.map(
    (item) => `- ${item?.name} ${item?.serviceLength}
    ${item?.volunteerDesc ?? item?.volunteerDescription}`,
  )
  .join('\n')}`
    }

    template = template.replaceAll('undefined', '')
    logger.debug('getUserResumeString', { template, data })
    return template
  }

  async function getUserResumeData(forceRefresh = false) {
    if (resume.value != null && !forceRefresh) {
      return resume.value
    }
    if (resumeRequest != null && !forceRefresh) return resumeRequest

    const request = (async () => {
      const token = window?.Cookie.get('bst')
      const res = await fetch(
        `https://www.zhipin.com/wapi/zpgeek/resume/geek/preview/data.json?_=${Date.now()}`,
        {
          headers: {
            Zp_token: token,
          },
        },
      )
      const data = (await res.json()) as {
        code: number
        message: string
        zpData: bossZpResumeData
      }
      if (data.code !== 0) {
        AgentMessage.error('简历读取失败，请稍后重试')
        throw new Error(data.message)
      }
      resume.value = data.zpData
      return data.zpData
    })()
    resumeRequest = request
    try {
      return await request
    } finally {
      if (resumeRequest === request) resumeRequest = undefined
    }
  }
  return {
    info,
    resume,
    getUserResumeString,
    getUserResumeData,
    getUserId,
    initUser,
    saveUser,
    changeUser,
  }
}
