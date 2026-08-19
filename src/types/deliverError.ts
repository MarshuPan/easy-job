export class AgentDeliveryError extends Error {
  state: 'warning' | 'danger'
  error_type: 'agent-delivery'

  constructor(message: string, state: 'warning' | 'danger' = 'warning', options?: ErrorOptions) {
    super(message, options)
    this.state = state
    this.error_type = 'agent-delivery'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class RepeatError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '重复沟通'
  }
}

export class JobTitleError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '岗位名筛选'
  }
}

export class CompanyNameError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '公司名筛选'
  }
}

export class SalaryError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '薪资筛选'
  }
}

export class CompanySizeError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '公司规模筛选'
  }
}

export class JobDescriptionError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '工作内容筛选'
  }
}

export class HrPositionError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = 'Hr职位筛选'
  }
}

export class JobAddressError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '工作地址筛选'
  }
}

/**
 * 岗位的 securityId / lid 已经放太久，BOSS 不再认。
 *
 * 这两个值是抓列表页那一刻由 BOSS 发的，有时效。过期之后 job/detail.json 不会说
 * 「凭据过期」，只回一句含糊的「您的环境存在异常.」——正是反爬系统惯用的说法，
 * 也正是它一度被误判成账号风控的原因。真机数据里的分界很干净：
 *
 *   凭据 23.0 / 23.2 / 23.5 / 23.9 / 24.0 分钟   全部成功
 *   凭据 28.1 分钟                                您的环境存在异常
 *
 * 归到「过滤」而不是「失败」，是因为它跟账号、跟这一轮都没有关系：换一个刚抓来的
 * 岗位立刻就能用——用户手动继续之所以每次都好使，就是因为那会重抓列表页。让它去撞
 * 三振出局，等于拿一批放旧了的岗位判整轮死刑，而这正是之前每投十几个就得手动一次的原因。
 */
export class JobCredentialExpiredError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '凭据过期'
  }
}

export class JobUnavailableError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '岗位已失效'
  }
}

export class AIFilteringError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = 'AI匹配度'
  }
}

export class AIProviderError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'danger', options)
    this.name = 'AI请求异常'
  }
}

export class RetryablePipelineError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'danger', options)
    this.name = '流程待重试'
  }
}

/**
 * 这个岗位的数据不全，评估不下去——岗位名为空、地址为空、详情取不到、通勤查不出来。
 *
 * 它是 RetryablePipelineError 的子类，所以「留作待重试」的语义不变；分出来是因为上层
 * 对这两类的处置必须不同：账号 uid 拿不到、高德 Key 没配这类问题换个岗位一样不行，
 * 停下来是对的；而一个岗位缺个字段，跟后面几十个岗位没有关系，停整轮等于拿一条脏数据
 * 判了整轮的死刑。原来两者共用一个类型，走的是同一条终止分支。
 */
export class JobDataIncompleteError extends RetryablePipelineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = '岗位数据不全'
  }
}

export class FriendStatusError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '好友状态'
  }
}

export class ActivityError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '活跃度过滤'
  }
}

export class GoldHunterError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '猎头过滤'
  }
}

export class UnknownError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'danger', options)
    this.name = '未知错误'
  }
}

export class PublishError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'danger', options)
    this.name = '投递出错'
  }
}

export class GreetError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'danger', options)
    this.name = '打招呼出错'
  }
}

export class LimitError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'danger', options)
    this.name = '达到限制'
  }
}

export class RateLimitError extends AgentDeliveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'danger', options)
    this.name = '操作频繁'
  }
}

export class DeliveryStoppedError extends AgentDeliveryError {
  constructor(message = '用户已停止投递', options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = '手动停止'
  }
}
