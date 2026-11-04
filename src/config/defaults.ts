import { TARGET_ROLE_MAX_CHARACTERS } from '@/profile/targetRole'
import { jsonClone } from '@/utils/deepmerge'

import { migrateBuiltInGreetingPrompt } from './builtInPrompt'
import { DEFAULT_GREETING_TARGET, greetingBoundsFromTarget } from './greetingLength'
import {
  CONFIG_FORMAT,
  CONFIG_SCHEMA_VERSION,
  CONFIG_SETTINGS_SCOPE,
  type AiTaskConfig,
  type ConfigBundleV1,
  type DeliverySettingsConfig,
  type PersonalProfileConfig,
  type StoredConfigStateV1,
} from './types'

export const CONFIG_LIMITS = Object.freeze({
  importFileBytes: 2 * 1024 * 1024,
  displayNameCharacters: 10,
  targetRoleCharacters: TARGET_ROLE_MAX_CHARACTERS,
  resumeCharacters: 5000,
  promptCharacters: 8 * 1024,
  modelCount: 1,
  arrayItems: 200,
  urlCharacters: 4096,
  apiKeyCharacters: 8 * 1024,
})

// 搜索方向必须由用户自己填——它是「我要找什么工作」，没有通用默认值。
// 这里原来预置了 16 个 AI 产品经理方向，那是作者自己的求职方向：别人装上会看到
// 满屏和自己无关的岗位，还容易误以为是推荐配置。留空，让用户第一次配置时自己写。
// 搜索来源在没有方向时本来就判为未启用（见 configSnapshot 的 searchEnabled），不会出乱子。
export const DEFAULT_SEARCH_DIRECTIONS = Object.freeze([] as string[])

export const DEFAULT_JOB_CONTENT_EXCLUSIONS = Object.freeze([
  '销售岗',
  '销售岗位',
  '电销',
  '电话销售',
  'BD岗',
  'BD岗位',
  '商务拓展',
  '财务会计',
  '客服专员',
  '客服岗位',
  '司机',
  '游戏角色',
  '日结',
])

// 城市和薪资档位同样因人而异。原来写死成上海（101020100）和一档薪资，别的城市的用户
// 装上会默认搜上海。留空即可——buildBossSearchUrls 对空值直接跳过，不会拼出坏 URL。
export const DEFAULT_SEARCH_CITY = ''
export const DEFAULT_SEARCH_SALARY = ''
export const DEFAULT_AI_FILTERING_SCORE = 60
export const COMMUTE_FEATURE_AVAILABLE = false

export const DEFAULT_AI_FILTERING_PROMPT = `你要回答的问题是：这个人能不能做好这份工作。不是「简历里有没有写过 JD 里出现的每个词」。

一、先看这是不是同一类工作
职能不同就是不匹配，先判断这个，再谈能力。
- 职能 = 这份工作主要产出什么：定义产品、做运营增长、写代码、做销售、做人事。候选人的职能以求职定位为准，结合简历里的职位和实际做过的事。
- 职能不同不能靠可迁移能力补。一个做产品的人搭过内容矩阵、看过投放数据，不等于他要做运营总监；一个写过 SQL 的产品经理不是数据工程师。能力能迁到别的职能上去，不代表那就是他的职能。
- 「职能不同」和「场景不同」是两回事，别混。产品换个行业做还是产品，不扣分；产品换成运营，那是另一份工作。

二、读懂这份工作实际在做什么
从职责描述里提炼出它真正要解决的问题、要具备的能力，而不是罗列 JD 出现过的名词。
岗位标签、所属行业、公司介绍不是对候选人的要求，JD 正文没把它写成要求时不能当缺口。
- JD 写得含糊不等于候选人契合。分数是「核对过多少」，不是「挑出多少毛病」：JD 没写要求，你就没什么可核对，这种情况分数应该低，不该因为找不到缺口而变高。
- 提炼不出这份工作具体做什么、要什么能力时（通篇口号、只讲公司愿景、或一条招聘同时要产品和研发和设计），直说「岗位描述未提供可核对的要求」并给低分，别替它补一份想象中的 JD。

三、职能一致之后，用简历事实去覆盖这些能力，不要做逐条核对
- 一条事实可以同时支撑多项要求。做成过一件事，往往同时说明了方法、判断力和协作方式；不要求事实和要求一一对应。
- 场景不同不等于不匹配。同一套产品方法用在不同业务上是常态，判断的是「这套做法能不能用到这里」，不是「有没有在同一个行业干过」。行业知识多数是入职后补的。
- 工具、平台、框架的具体名称不构成缺口——那些是几周能上手的东西。只有当某项能力需要长期积累的专门判断力，而简历里连相近的实践都找不到时，才算真正的缺口。

四、给分，按能力覆盖的程度
- 主体是覆盖度：这份工作的核心要做的事，简历事实能支撑多少。
- 证据强度作调整：主导过 > 参与过 > 用过或了解过。
- 学历、专业、年限这类形式条件权重最低。差一档只小幅扣分，绝不作为跳过的主要理由——招聘方会在面试里自己判断，而在读、非全日制、年限差一两年都不等于不能胜任。
- 分档：85-100 strong，70-84 good，55-69 maybe，40-54 weak，0-39 reject。
- 职能不同的，不高于 35，理由写明职能不符——这是最先判断的一条，不受下面几条影响。
- 职能相同、方向相关但侧重不同的，不应低于 55。

五、你不知道投递门槛在哪里，也不要去猜
只给出「这个人能做好这份工作的程度」。理由里不要出现「达到/不达到投递门槛」「建议/不建议投递」这类话——是否投递由外部规则决定，不是你的判断范围。分数要反映真实差距，不要向任何特定数值靠拢。

六、结论必须自洽
每一条扣分都要能在 JD 里指出是哪一条要求。选中的简历事实不能在理由里被自己否认。
岗位薪资覆盖或高于候选人期望不是风险，只有明确低于期望时才记为风险。

七、理由保持简洁：说清楚能力覆盖在哪里、最大的实质差距是什么，并选出最适合后续招呼语使用的主事实。`

export const DEFAULT_AI_GREETING_PROMPT = `请以候选人本人的口吻写一段求职开场话术，读的人是招聘方。要让对方读完觉得：这个人做过的事，正好对得上这份 JD 最要紧的那件事。
写法像资深从业者的简短自我介绍：陈述做过什么、结果如何、擅长什么，不表态、不许愿。

整段围绕 anchor.need 来写，按下面的顺序组织：
1. 我是谁：称呼（bossName 中可识别姓氏时用“X老师您好”，否则用“老师您好”）之后，一句话直接说我是做什么的。身份按 targetRole，侧重点跟着 need 走，可以带工作年限，不复述姓名，不提求职或应聘。
2. 做过什么：从 facts 里选最能回应 need 的真实经历，按岗位需求和表达需要引用，讲清做了什么、结果如何，优先带数字。同样贴近时选 recentFactUses 少的；与这个岗位无关的数字不写。
3. 能力：点出支撑 need 的核心能力，来自 facts，说得具体。
4. 能带来什么：对准 need，说我做成过的事放到对方的业务里，能解决什么、带来什么结果。用具体的做法或结果说，不以“经验”“认识”“参考”这类虚词收尾；不复述 JD，不写流程套话。
5. 收尾：一句简短的期待沟通，不提问。

用这个行业的标准说法，HR 不一定懂技术，冷僻术语不用；不用营销式判断。
篇幅按设置的总字数来：字数少时把第 2、3 部分合成一句；不用客套和空话填篇幅。
这里规定的是每部分传达什么，不是句式模板。写完自检：把公司名和岗位名换掉，这段话对另一个岗位是否同样成立？成立就重写。`

export function migrateBuiltInAiGreetingPrompt(value: string) {
  return migrateBuiltInGreetingPrompt(value, DEFAULT_AI_GREETING_PROMPT)
}

export function createDefaultProfile(): PersonalProfileConfig {
  return {
    displayName: '',
    targetRole: '',
    resume: {
      markdown: '',
      sourceHash: null,
      evidenceVersion: 1,
      evidence: null,
    },
  }
}

export function createDefaultAiTasks(): AiTaskConfig {
  return {
    customGreeting: { enabled: false, value: '' },
    resumeExtraction: {
      modelId: null,
    },
    aiFiltering: {
      enabled: false,
      modelId: null,
      score: DEFAULT_AI_FILTERING_SCORE,
      prompt: DEFAULT_AI_FILTERING_PROMPT,
    },
    aiGreeting: {
      enabled: false,
      modelId: null,
      messageCount: 3,
      ...greetingBoundsFromTarget(DEFAULT_GREETING_TARGET),
      prompt: DEFAULT_AI_GREETING_PROMPT,
    },
  }
}

export function createDefaultDeliverySettings(): DeliverySettingsConfig {
  return {
    jobRules: {
      sources: {
        searchEnabled: true,
        recommendEnabled: true,
        expectationsInitialized: false,
        enabledExpectations: [],
      },
      sourceWeights: {
        search: 50,
        expectations: 50,
      },
      search: {
        directions: [...DEFAULT_SEARCH_DIRECTIONS],
        city: DEFAULT_SEARCH_CITY,
        salary: DEFAULT_SEARCH_SALARY,
        experience: [],
        degree: [],
        jobType: [],
      },
    },
    filters: {
      jobContent: {
        enabled: false,
        mode: 'exclude',
        values: [...DEFAULT_JOB_CONTENT_EXCLUSIONS],
        options: [],
      },
      companySizeRange: {
        enabled: false,
        range: [500, 2000, true],
      },
      activity: true,
      friendStatus: true,
      sameCompany: true,
      sameHr: true,
      goldHunter: true,
    },
    delivery: {
      customGreeting: {
        enabled: false,
        value: '',
      },
      useCache: false,
      timing: {
        initialDelaySeconds: 8,
        minJobIntervalSeconds: 30,
        maxJobIntervalSeconds: 60,
        nextPageDelaySeconds: 60,
        messageSendDelaySeconds: 20,
        greetingSegmentSeconds: 5,
        batchSize: 30,
        batchRestMinutes: 10,
      },
    },
    commute: {
      enabled: false,
      apiKey: '',
      origin: '',
      straightDistanceKm: 0,
      drivingDistanceKm: 0,
      drivingDurationMinutes: 0,
      walkingDistanceKm: 0,
      walkingDurationMinutes: 0,
    },
    appearance: {
      hideHeader: false,
      listSink: false,
    },
  }
}

export function canonicalizeDeliveryFeatureAvailability(
  settings: DeliverySettingsConfig,
): DeliverySettingsConfig {
  const result = jsonClone(settings)
  if (!COMMUTE_FEATURE_AVAILABLE) result.commute.enabled = false
  return result
}

export function createDefaultConfigBundle(
  options: {
    appVersion?: string
    exportedAt?: string
  } = {},
): ConfigBundleV1 {
  return {
    format: CONFIG_FORMAT,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    appVersion: options.appVersion ?? '0.0.0',
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    containsSecrets: true,
    settingsScope: CONFIG_SETTINGS_SCOPE,
    profile: createDefaultProfile(),
    models: [],
    tasks: createDefaultAiTasks(),
    settings: createDefaultDeliverySettings(),
  }
}

export function createDefaultStoredConfigState(): StoredConfigStateV1 {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    configRevision: 0,
    profile: createDefaultProfile(),
    models: [],
    tasks: createDefaultAiTasks(),
    accountSettings: {},
  }
}

export function cloneConfigBundle(bundle: ConfigBundleV1) {
  return jsonClone(bundle)
}
