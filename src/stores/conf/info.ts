import {
  DEFAULT_AI_FILTERING_SCORE,
  DEFAULT_AI_GREETING_PROMPT,
  DEFAULT_JOB_CONTENT_EXCLUSIONS,
  DEFAULT_SEARCH_CITY,
  DEFAULT_SEARCH_DIRECTIONS,
  DEFAULT_SEARCH_SALARY,
} from '@/config/defaults'
import type { FormData, FormInfoData } from '@/types/formData'

export const formInfoData: FormInfoData = {
  jobContent: {
    label: '工作内容',
    'data-help':
      "会自动检测上文(不是,不,无需),下文(系统,工具),例子：[外包,上门,销售,驾照], 排除: '外包岗位', 不排除: '不是外包'|'销售系统'",
  },
  companySizeRange: {
    label: '公司规模范围',
    'data-help':
      '投递工作的公司规模, 推荐使用boss自带选项进行筛选。严格宽松定义在薪资高级配置中有写',
  },
  customGreeting: {
    label: '自定义招呼语',
    'data-help':
      '因为boss不支持将自定义的招呼语设置为默认招呼语。开启表示发送boss默认的招呼语后还会发送自定义招呼语',
  },
  activityFilter: {
    label: '活跃度过滤',
    'data-help': '打开后会自动过滤掉最近未活跃的Boss发布的工作，以免浪费每天的150次机会。',
  },
  goldHunterFilter: {
    label: '猎头过滤',
    'data-help':
      'Boss中有一些猎头发布的工作，但是一般而言这种工作不太行，点击可以过滤猎头发布的职位',
  },
  friendStatus: {
    label: '好友过滤(已聊)',
    'data-help': '判断和hr是否建立过聊天，理论上能过滤的同hr，但是不同岗位的工作',
  },
  sameCompanyFilter: {
    label: '相同公司过滤',
    'data-help': '投递过的公司id存储到浏览器本地，避免多次向同公司投递，即使岗位不同hr不同',
  },
  sameHrFilter: {
    label: '相同Hr过滤',
    'data-help': '投递过的hr存储到浏览器本地，避免多次向同hr投递。',
  },
  useCache: {
    label: '启用缓存',
    'data-help':
      '开启后会缓存投递记录，避免重复投递，提高效率。但是缓存功能并不积极维护。可能会有bug，或者意外情况，如遇到可尝试清空缓存或者禁用',
  },
  deliveryLimit: {
    label: '来源比例',
    'data-help':
      '搜索和求职期望按比例确定每轮取岗软目标，不作为硬上限；岗位进入投递池后统一按入池顺序处理。',
  },
  aiGreeting: {
    label: 'AI招呼语',
    'data-help':
      '即使前面招呼语开了也不会发送，只会发送AI生成的招呼语，让gpt来打招呼真是太棒了，毕竟开场白很重要。',
    example: [
      `请根据岗位 JD 和候选人简历，生成 Boss 直聘开场招呼语。

岗位信息：
- 岗位名：{{ card.jobName }}
- 薪资：{{ card.salaryDesc }}
- 学历：{{ card.degreeName }}
- 技能：{{ data.skills }}
- 标签：{{ card.jobLabels }}
- 岗位描述：{{ card.postDescription }}`,
      [
        {
          role: 'system',
          content: `## 角色
  求职开场消息生成器

  ## 输出
  只返回可直接发送的招呼语，不要标题、编号或解释。

  ## 表达要求
  第三句用于补充能力差异化，避免用“我习惯于”作为主要表达；优先使用更确定但自然的能力表达，例如“我擅长/我熟悉/我能/我更能/过往做法是/我的优势在于”，但不要机械重复同一种句式。`,
        },
        {
          role: 'user',
          content: `岗位信息：
  - 岗位名：{{ card.jobName }}
  - 薪资：{{ card.salaryDesc }}
  - 经验：{{ card.experienceName }}
  - 学历：{{ card.degreeName }}
  - 技能：{{ data.skills }}
  - 标签：{{ card.jobLabels }}
  - 岗位描述：{{ card.postDescription }}`,
        },
      ],
    ],
  },
  aiFiltering: {
    label: 'AI匹配度',
    'data-help': '根据完整 JD 和个人结构化简历评估岗位匹配度，达到最低匹配度后继续投递。',
    example: [
      `请根据完整 JD 和候选人简历证据，评估岗位匹配度。

输出 JSON：
{"pass":布尔值,"matchPercent":0到100的整数,"level":"strong|good|maybe|weak|reject","reason":"一句话原因","evidence":["证据1","证据2"],"risk":"可选风险"}

岗位信息：
- 岗位名：{{ card.jobName }}
- 薪资：{{ card.salaryDesc }}
- 经验：{{ card.experienceName }}
- 学历：{{ card.degreeName }}
- 福利：{{ data.welfareList }}
- 技能：{{ data.skills }}
- 标签：{{ card.jobLabels }}
- 岗位描述：{{ card.postDescription }}`,
      [
        {
          role: 'system',
          content: `## 角色
  求职岗位匹配度评估助手

  只返回 JSON，不要有任何其他字符。
  interface aiMatching {
    pass: boolean
    matchPercent: number
    level: 'strong' | 'good' | 'maybe' | 'weak' | 'reject'
    reason: string
    evidence: string[]
    risk?: string
  }

  matchPercent 表示 JD 核心职责与候选人真实经历和能力的相符度，范围 0-100。
  `,
        },
        {
          role: 'user',
          content: `岗位信息：
  - 岗位名：{{ card.jobName }}
  - 薪资：{{ card.salaryDesc }}
  - 经验：{{ card.experienceName }}
  - 学历：{{ card.degreeName }}
  - 福利：{{ data.welfareList }}
  - 技能：{{ data.skills }}
  - 标签：{{ card.jobLabels }}
  - 岗位描述：{{ card.postDescription }}`,
        },
      ],
    ],
  },
  record: {
    label: '内容记录',
    'data-help': '拿这些数据去训练个Ai岂不是美滋滋咯？',
  },
  delay: {
    deliveryInterval: {
      label: '单JD典型耗时',
      'data-help':
        '单个岗位的典型总耗时，一半的岗位比它快。AI分析和招呼语生成时间会计入。实际节奏还会随会话时长变化：刚开工更快，跑久了变慢。',
    },
    deliveryIntervalMax: {
      label: '单JD常见上限',
      'data-help':
        '十次里大约九次不超过这个耗时。少数岗位会超出（真人也会偶尔在一个岗位上停很久），实际处理已经超过时不再额外等待。',
    },
    messageSending: {
      label: '内部消息等待',
      'data-help': '等待聊天页 WebSocket 消费招呼语队列的内部超时时间，界面不展示。',
    },
    greetingSegment: {
      label: '招呼语分段间隔',
      'data-help':
        '多段招呼语之间的基础间隔秒数，实际间隔会按这一段的字数加上打字时间并做随机抖动。一次性把几段全发出去是最明显的机器特征。',
    },
    batchSize: {
      label: '批量休息数量',
      'data-help': '每成功投递/打招呼多少个岗位后进入一次长休息。',
    },
    batchRestMinutes: {
      label: '批量休息分钟',
      'data-help': '达到批量休息数量后暂停的分钟数。',
    },
  },
  amap: {
    enable: {
      label: '启用',
      'data-help': '启用高德地图, 用于获取工作地址的距离和时间进行筛选，需要配置自己的key',
    },
    key: {
      label: '高德地图key',
      'data-help': '高德地图key, 需要自己申请',
    },
    origins: {
      label: '起点经纬度',
      'data-help': '起点经纬度, 经度和纬度用","分隔, 可以输入完整地址点击按钮自动获取',
    },
    straightDistance: {
      label: '直线距离',
      'data-help': '直线距离, 为0禁用，单位: km',
    },
    drivingDistance: {
      label: '驾车距离',
      'data-help':
        '驾车距离, 为0禁用，会考虑当前时间的路况，不同时间结果不一样，策略为"速度优先", 单位: km',
    },
    drivingDuration: {
      label: '驾车时间',
      'data-help':
        '驾车时间, 为0禁用，会考虑当前时间的路况，不同时间结果不一样，策略为"速度优先", 单位: 分钟',
    },
    walkingDistance: {
      label: '步行距离',
      'data-help': '步行距离, 为0禁用，单位: km',
    },
    walkingDuration: {
      label: '步行时间',
      'data-help': '步行时间, 为0禁用，单位: 分钟',
    },
  },
}

export const defaultFormData: FormData = {
  jobContent: {
    include: false,
    value: [...DEFAULT_JOB_CONTENT_EXCLUSIONS],
    options: [],
    enable: false,
  },
  companySizeRange: {
    value: [500, 2000, true],
    enable: false,
  },
  customGreeting: {
    value: '',
    enable: false,
  },
  deliveryLimit: {
    search: 50,
    group: 50,
  },
  jobSources: {
    searchEnabled: true,
    recommendEnabled: true,
    enabledExpectIds: [],
    expectationsInitialized: false,
  },
  searchConditions: {
    directions: [...DEFAULT_SEARCH_DIRECTIONS],
    city: DEFAULT_SEARCH_CITY,
    businessDistricts: [],
    salary: DEFAULT_SEARCH_SALARY,
    experience: [],
    degree: [],
    jobType: [],
  },
  activityFilter: {
    value: true,
  },
  friendStatus: {
    value: true,
  },
  sameCompanyFilter: {
    value: true,
  },
  sameHrFilter: {
    value: true,
  },
  goldHunterFilter: {
    value: true,
  },
  useCache: {
    value: false,
  },
  aiGreeting: {
    enable: false,
    messageCount: 3,
    targetTotalCharacters: 150,
    prompt: DEFAULT_AI_GREETING_PROMPT,
  },
  aiFiltering: {
    enable: false,
    prompt: '',
    score: DEFAULT_AI_FILTERING_SCORE,
  },
  amap: {
    key: '',
    origins: '',
    straightDistance: 0,
    drivingDistance: 0,
    drivingDuration: 0,
    walkingDistance: 0,
    walkingDuration: 0,
    enable: false,
  },
  record: {
    enable: false,
  },
  delay: {
    deliveryInterval: 30,
    deliveryIntervalMax: 60,
    messageSending: 20,
    greetingSegment: 5,
    batchSize: 30,
    batchRestMinutes: 10,
  },
  version: '20240401',
}
