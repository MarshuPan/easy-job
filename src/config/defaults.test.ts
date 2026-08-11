import { describe, expect, it } from 'vitest'

import { defaultFormData } from '@/stores/conf/info'

import { BUILT_IN_AI_GREETING_PROMPT_FINGERPRINTS, fingerprintBuiltInPrompt } from './builtInPrompt'
import {
  COMMUTE_FEATURE_AVAILABLE,
  DEFAULT_AI_FILTERING_PROMPT,
  DEFAULT_AI_GREETING_PROMPT,
  DEFAULT_JOB_CONTENT_EXCLUSIONS,
  DEFAULT_SEARCH_CITY,
  DEFAULT_SEARCH_DIRECTIONS,
  DEFAULT_SEARCH_SALARY,
  canonicalizeDeliveryFeatureAvailability,
  createDefaultAiTasks,
  createDefaultConfigBundle,
  createDefaultDeliverySettings,
  createDefaultProfile,
  migrateBuiltInAiGreetingPrompt,
} from './defaults'

describe('public workflow defaults', () => {
  it('ships an operational job-source and pacing baseline', () => {
    const settings = createDefaultDeliverySettings()

    expect(settings.jobRules).toMatchObject({
      sources: {
        searchEnabled: true,
        recommendEnabled: true,
        expectationsInitialized: false,
        enabledExpectations: [],
      },
      sourceWeights: { search: 50, expectations: 50 },
      search: {
        directions: [...DEFAULT_SEARCH_DIRECTIONS],
        city: DEFAULT_SEARCH_CITY,
        salary: DEFAULT_SEARCH_SALARY,
        experience: [],
        degree: [],
        jobType: [],
      },
    })
    expect(settings.delivery.timing).toEqual({
      initialDelaySeconds: 8,
      minJobIntervalSeconds: 30,
      maxJobIntervalSeconds: 60,
      nextPageDelaySeconds: 60,
      messageSendDelaySeconds: 20,
      greetingSegmentSeconds: 5,
      batchSize: 30,
      batchRestMinutes: 10,
    })
  })

  it('enables deterministic safeguards without enabling detail keyword filtering', () => {
    const settings = createDefaultDeliverySettings()

    expect(settings.filters).toMatchObject({
      activity: true,
      friendStatus: true,
      sameCompany: true,
      sameHr: true,
      goldHunter: true,
      jobContent: {
        enabled: false,
        mode: 'exclude',
        values: [...DEFAULT_JOB_CONTENT_EXCLUSIONS],
      },
    })
    expect(settings.commute.enabled).toBe(false)
    expect(COMMUTE_FEATURE_AVAILABLE).toBe(false)
  })

  it('keeps personal data and models blank while preloading disabled AI task settings', () => {
    const bundle = createDefaultConfigBundle()
    const tasks = createDefaultAiTasks()

    expect(bundle.profile.displayName).toBe('')
    expect(bundle.profile.resume.markdown).toBe('')
    expect(bundle.models).toEqual([])
    expect(tasks.aiFiltering).toMatchObject({
      enabled: false,
      modelId: null,
      score: 60,
      prompt: DEFAULT_AI_FILTERING_PROMPT,
    })
    expect(tasks.aiGreeting).toMatchObject({
      enabled: false,
      modelId: null,
      messageCount: 3,
      minTotalCharacters: 125,
      maxTotalCharacters: 175,
      prompt: DEFAULT_AI_GREETING_PROMPT,
    })
  })

  it('keeps the page compatibility defaults aligned with canonical defaults', () => {
    expect(defaultFormData.deliveryLimit).toEqual({ search: 50, group: 50 })
    expect(defaultFormData.searchConditions).toMatchObject({
      directions: [...DEFAULT_SEARCH_DIRECTIONS],
      city: DEFAULT_SEARCH_CITY,
      salary: DEFAULT_SEARCH_SALARY,
    })
    // 初始等待与翻页等待已固化为运行时常量，运行配置里不再有对应字段。
    expect(defaultFormData.delay).toMatchObject({
      deliveryInterval: 30,
      deliveryIntervalMax: 60,
      messageSending: 20,
      batchSize: 30,
      batchRestMinutes: 10,
    })
    expect(defaultFormData.friendStatus.value).toBe(true)
    expect(defaultFormData.sameCompanyFilter.value).toBe(true)
    expect(defaultFormData.sameHrFilter.value).toBe(true)
    expect(defaultFormData.goldHunterFilter.value).toBe(true)
    expect(defaultFormData.jobContent).toMatchObject({
      enable: false,
      include: false,
      value: [...DEFAULT_JOB_CONTENT_EXCLUSIONS],
    })
    expect(defaultFormData.aiFiltering).toMatchObject({ enable: false, score: 60 })
    expect(defaultFormData.aiGreeting).toMatchObject({
      enable: false,
      messageCount: 3,
      targetTotalCharacters: 150,
      prompt: DEFAULT_AI_GREETING_PROMPT,
    })
  })

  it('removes an unavailable commute enablement from imported or stored settings', () => {
    const settings = createDefaultDeliverySettings()
    settings.commute.enabled = true

    const canonical = canonicalizeDeliveryFeatureAvailability(settings)

    expect(canonical.commute.enabled).toBe(false)
    expect(settings.commute.enabled).toBe(true)
  })

  it('keeps the filtering prompt teaching a method instead of matching JD wording', () => {
    // 这条守的是「别再退回按措辞匹配」，不是「模型一定照做」——效果只能在真实岗位上看。
    //
    // 上一版按 JD 的小标题分要求等级（「硬性条件」「必须掌握」），那是照着五份样本 JD 写的：
    // 一份没有标题、整段散文的 JD，这些词一个都不出现，模型就没有任何指引。要求的权重
    // 得来自它在这份工作里起什么作用，不是它写在哪个标题下。
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('岗位标签、所属行业、公司介绍不是对候选人的要求')

    // 评分主体是「能力覆盖度」，证据强度只作调整。
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('证据强度作调整')

    // 匹配不是逐条核对。一条事实可以支撑多项要求，同一套方法换个业务仍然成立——这是用户
    // 明确指出的：简历里二十多条事实不可能和 JD 的要求一一对上，要求对上就等于只投做过
    // 同样业务的岗位。
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('不要求事实和要求一一对应')
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('场景不同不等于不匹配')

    // 学历、专业、年限是形式条件，权重最低。0.9.52 曾把它们提成一个和「职责重合」并列的
    // 独立评分维度「门槛符合」，等于给学历单开一条扣分通道，真机上十三条评估里十二条都在
    // 扣学历。那是把原本能用的匹配改坏了，不能再回去。
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('学历、专业、年限这类形式条件权重最低')
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('绝不作为跳过的主要理由')
    expect(DEFAULT_AI_FILTERING_PROMPT).not.toContain('门槛符合')

    // 阈值不发给模型，提示词也不能教它去猜——否则模型先定「投不投」再补一个刚好落在线下的
    // 分数，用户把门槛从 80 调到 40 也不会多投出一个岗位。
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('不要向任何特定数值靠拢')

    // 真机上「AI native 产品方向」拿了 93 分 strong：那条 JD 全文三句话，还明说「产品、设计、
    // 工程师、算法、分析师各种角色都需要」。模型自己写了「岗位正文未进一步明确…无法确认」，
    // 然后照样给了 93——因为没有要求可核对，就没有缺口可扣。
    //
    // 分数被当成了「没发现问题的程度」。同一轮里 JD 写得最细的几个岗位反而只有 76-83，
    // 认真写 JD 的公司被惩罚了。这里锁住相反的定义：分数是核对过多少，不是挑出多少毛病。
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('分数是「核对过多少」，不是「挑出多少毛病」')
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('岗位描述未提供可核对的要求')

    // 职能和场景必须分开说。真机上「运营总监」拿到 72 分投了出去，模型引用的是候选人
    // 搭内容矩阵、带团队的产品经历——那是把「能力能迁到运营上去」当成了「这就是运营岗」。
    // 上一版只写了「场景不同不等于不匹配」，等于给这种越界发了许可：运营和产品不是同一
    // 职能换了个行业，是两份工作。
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('职能不同就是不匹配')
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('职能不同不能靠可迁移能力补')
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('「职能不同」和「场景不同」是两回事')
    // 场景那条要留着——它修的是另一个方向的病（同职能换行业被一刀切）。两条必须同时在。
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('场景不同不等于不匹配')

    // 自相矛盾那条要留着：真机上出现过把某条事实选为证据、理由里又说该方向没有证据。
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('不能在理由里被自己否认')
  })

  it('keeps the default greeting user prompt focused on writing preferences', () => {
    expect(DEFAULT_AI_FILTERING_PROMPT).not.toContain('{{')
    expect(DEFAULT_AI_GREETING_PROMPT).not.toContain('{{')
    expect(DEFAULT_AI_FILTERING_PROMPT).toContain('85-100 strong')
    expect(DEFAULT_AI_GREETING_PROMPT).toContain('招聘者称呼、自我介绍、工作年限、主要领域')
    expect(DEFAULT_AI_GREETING_PROMPT).toContain('随后使用“我是”加 candidateName')
    expect(DEFAULT_AI_GREETING_PROMPT).toContain('接“目前有”加 candidateExperience')
    expect(DEFAULT_AI_GREETING_PROMPT).not.toContain('candidateExperience 加“工作经验”')
    expect(DEFAULT_AI_GREETING_PROMPT).toContain('领域表述随本次岗位调整')
    expect(DEFAULT_AI_GREETING_PROMPT).toContain('换成另一个候选人是否同样成立')
    expect(DEFAULT_AI_GREETING_PROMPT).toContain('沟通意愿只能是简短尾句')
    expect(DEFAULT_AI_GREETING_PROMPT).toContain('规定的是每部分要传达的信息，不是句式模板')
    // 默认提示词被所有岗位、所有用户共用，任何可逐字照抄的示例都会变成模板。
    expect(DEFAULT_AI_GREETING_PROMPT).not.toContain('主要在 AI、Agent 领域从事产品工作')
    expect(DEFAULT_AI_GREETING_PROMPT).toContain('bossName 中可识别的姓氏')
    expect(DEFAULT_AI_GREETING_PROMPT).not.toContain('只表达已经选择的简历事实')
    expect(DEFAULT_AI_GREETING_PROMPT).not.toContain('第一人称视角')
    expect(DEFAULT_AI_GREETING_PROMPT).not.toContain('claimMode')
    expect(DEFAULT_AI_GREETING_PROMPT).not.toContain('受控动词')
    expect(DEFAULT_AI_GREETING_PROMPT).not.toContain('发送段数')
    expect(DEFAULT_AI_GREETING_PROMPT).not.toContain('不平均分字数')
  })

  it('改了招呼语提示词就必须把新指纹登记进表里', () => {
    // 这是一条绊线，不是普通断言。
    //
    // 招呼语提示词用户可以自己改（契约 §5.2），所以升级前要先判断「存下来的这份是不是
    // 某一版内置默认」。判断依据就是 BUILT_IN_AI_GREETING_PROMPT_FINGERPRINTS。
    //
    // 改了提示词却忘了把新指纹追加进去，后果是静默的：所有测试照样绿，但停留在上一版、
    // 又没自己改过提示词的用户，从此收不到任何提示词更新，而且没有任何信号。
    //
    // 这条断言让「改提示词」这个动作先把测试打红。红了就照做：把新的默认值指纹加进表里。
    expect(BUILT_IN_AI_GREETING_PROMPT_FINGERPRINTS).toContain(
      fingerprintBuiltInPrompt(DEFAULT_AI_GREETING_PROMPT),
    )
  })

  it('历史内置版本升级到当前默认，用户自己写的原样保留', () => {
    // 历史全文已经删掉（5 份合计 3.6KB），判定改用指纹，能力不变。
    for (const fingerprint of BUILT_IN_AI_GREETING_PROMPT_FINGERPRINTS) {
      expect(typeof fingerprint).toBe('string')
    }
    expect(migrateBuiltInAiGreetingPrompt(DEFAULT_AI_GREETING_PROMPT)).toBe(
      DEFAULT_AI_GREETING_PROMPT,
    )
    expect(migrateBuiltInAiGreetingPrompt('用户自定义写作偏好')).toBe('用户自定义写作偏好')
    expect(migrateBuiltInAiGreetingPrompt('   ')).toBe(DEFAULT_AI_GREETING_PROMPT)
  })
})

describe('分发出去的默认配置不带作者的个人预设', () => {
  it('搜索方向、城市、薪资默认为空', () => {
    // 这些是「我要找什么工作」，因人而异，没有通用默认值。原来预置了 16 个 AI 产品经理
    // 方向 + 上海 + 一档薪资——那是作者自己的求职配置。别人装上会看到满屏无关岗位，
    // 还会以为是推荐值。工具要发给别人用，开箱就得是空白的。
    expect(DEFAULT_SEARCH_DIRECTIONS).toEqual([])
    expect(DEFAULT_SEARCH_CITY).toBe('')
    expect(DEFAULT_SEARCH_SALARY).toBe('')
  })

  it('默认排除词不误伤应届生和实习岗', () => {
    // 「应届」「实习」在排除词里，应届生装上会被大量误杀，而且多半想不到去翻这个列表。
    // 「教师」「运营专员」同理——真想投教育产品或运营的会被挡掉。
    for (const trap of ['应届', '实习', '教师', '运营专员']) {
      expect(DEFAULT_JOB_CONTENT_EXCLUSIONS).not.toContain(trap)
    }
    // 销售、电销、财务这类留着：绝大多数互联网求职者都想排除，属于合理默认。
    expect(DEFAULT_JOB_CONTENT_EXCLUSIONS).toContain('电销')
  })

  it('默认档案里没有姓名和简历', () => {
    const profile = createDefaultProfile()
    expect(profile.displayName).toBe('')
    expect(profile.resume.markdown).toBe('')
    expect(profile.resume.evidence).toBeNull()
  })
})
