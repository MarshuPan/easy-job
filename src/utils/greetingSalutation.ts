function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const commonSingleSurnames = new Set(
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧肖尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘斜厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲台从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧利师巩聂关荆司查曾沙游竺权逯盖益桓公'.split(
    '',
  ),
)

const commonCompoundSurnames = [
  '欧阳',
  '太史',
  '端木',
  '上官',
  '司马',
  '东方',
  '独孤',
  '南宫',
  '万俟',
  '闻人',
  '夏侯',
  '诸葛',
  '尉迟',
  '公羊',
  '赫连',
  '澹台',
  '皇甫',
  '宗政',
  '濮阳',
  '公冶',
  '太叔',
  '申屠',
  '公孙',
  '慕容',
  '仲孙',
  '钟离',
  '长孙',
  '宇文',
  '司徒',
  '鲜于',
  '司空',
  '闾丘',
  '子车',
  '亓官',
  '司寇',
  '巫马',
  '公西',
  '颛孙',
  '壤驷',
  '公良',
  '漆雕',
  '乐正',
  '宰父',
  '谷梁',
  '拓跋',
  '夹谷',
  '轩辕',
  '令狐',
  '段干',
  '百里',
  '呼延',
  '东郭',
  '南门',
  '羊舌',
  '微生',
  '公户',
  '公玉',
  '公仪',
  '梁丘',
  '公仲',
  '公上',
  '公门',
  '公山',
  '公坚',
  '左丘',
  '公伯',
  '西门',
  '公祖',
  '第五',
  '公乘',
  '贯丘',
  '公皙',
  '南荣',
  '东里',
  '东宫',
  '仲长',
  '子书',
  '子桑',
  '即墨',
  '达奚',
  '褚师',
]

function extractLikelySurname(name?: string | null) {
  const trimmed = name?.trim()
  if (!trimmed) return null

  for (const surname of commonCompoundSurnames) {
    if (trimmed.startsWith(surname)) return surname
  }

  const firstChinese = trimmed.match(/[\u4e00-\u9fa5]/)?.[0]
  if (!firstChinese || !commonSingleSurnames.has(firstChinese)) return null
  return firstChinese
}

function buildKnownSalutations(name?: string | null) {
  const trimmed = name?.trim()
  const surname = extractLikelySurname(trimmed)
  const values = new Set<string>(['HR', 'hr', '招聘', '招聘经理', '招聘专家'])

  if (trimmed) values.add(trimmed)
  if (surname) {
    for (const suffix of ['老师', '女士', '先生', '小姐', '经理', '总']) {
      values.add(`${surname}${suffix}`)
    }
  }

  return Array.from(values)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
}

export function formatBossTeacherSalutation(name?: string | null) {
  const surname = extractLikelySurname(name)
  return surname ? `${surname}老师` : '老师'
}

function stripLeadingGreetingOpening(
  value: string,
  knownPattern: string,
  candidateName: string,
  separator: string,
  separatorRequired: string,
) {
  let current = value.trim()
  let strippedCandidateIntroduction = false

  for (let i = 0; i < 4; i++) {
    const before = current

    if (knownPattern) {
      current = current.replace(new RegExp(`^(?:${knownPattern})(?:您好|你好)${separator}`), '')
    }

    current = current
      .replace(
        /^(?:老师|[\u4e00-\u9fa5]{1,3}(?:老师|女士|先生|小姐|经理|总)|HR|hr)(?:您好|你好)[，,。；;、\s]*/,
        '',
      )
      .replace(/^(?:您好|你好)[，,。；;、\s]*/, '')

    if (knownPattern) {
      current = current.replace(new RegExp(`^(?:${knownPattern})${separatorRequired}`), '')
    }

    current = current.replace(
      /^(?:老师|[\u4e00-\u9fa5]{1,3}(?:老师|女士|先生|小姐|经理|总)|HR|hr)[，,。；;、\s]+/,
      '',
    )
    const candidateIntroductionPattern = new RegExp(
      candidateName ? `^(?:我是|我叫)\\s*(?:${escapeRegExp(candidateName)})[，,。；;、\\s]*` : 'a^',
    )
    if (candidateIntroductionPattern.test(current)) {
      strippedCandidateIntroduction = true
      current = current.replace(candidateIntroductionPattern, '')
    }
    current = current.replace(/^[，,。；;、\s]+/, '').trim()

    if (current === before) break
  }

  return { text: current, strippedCandidateIntroduction }
}

export function normalizeGreetingSalutation(
  messages: string[],
  bossName?: string | null,
  candidateName = '',
) {
  const result = [...messages]
  if (result.length === 0) return result

  const knownSalutations = buildKnownSalutations(bossName)
  const knownPattern = knownSalutations.map(escapeRegExp).join('|')
  const separator = '[，,。；;、\\s]*'
  const separatorRequired = '[，,。；;、\\s]+'
  const normalizedCandidateName = candidateName.trim()
  const first = stripLeadingGreetingOpening(
    result[0],
    knownPattern,
    normalizedCandidateName,
    separator,
    separatorRequired,
  )

  const prefix = `${formatBossTeacherSalutation(bossName)}您好${
    first.strippedCandidateIntroduction && normalizedCandidateName
      ? `，我是${normalizedCandidateName}`
      : ''
  }`
  result[0] = first.text ? `${prefix}。${first.text}` : prefix
  return result
}
