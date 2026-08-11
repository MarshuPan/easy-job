type PublicFormSchema =
  | 'boolean'
  | 'number'
  | 'string'
  | 'stringOrNumber'
  | 'stringArray'
  | 'primitiveArray'
  | { [key: string]: PublicFormSchema }

const selectSchema = {
  enable: 'boolean',
  include: 'boolean',
  options: 'stringArray',
  value: 'stringArray',
} satisfies PublicFormSchema
const checkboxSchema = { value: 'boolean' } satisfies PublicFormSchema
const accountAmapSchema = {
  origins: 'string',
  straightDistance: 'number',
  drivingDistance: 'number',
  drivingDuration: 'number',
  walkingDistance: 'number',
  walkingDuration: 'number',
  enable: 'boolean',
} satisfies PublicFormSchema
const accountFormSchema = {
  company: selectSchema,
  jobTitle: selectSchema,
  jobContent: selectSchema,
  hrPosition: selectSchema,
  jobAddress: selectSchema,
  salaryRange: {
    enable: 'boolean',
    value: 'primitiveArray',
    advancedValue: {
      H: 'primitiveArray',
      D: 'primitiveArray',
      M: 'primitiveArray',
    },
  },
  companySizeRange: { enable: 'boolean', value: 'primitiveArray' },
  customGreeting: { enable: 'boolean', value: 'string' },
  deliveryLimit: { search: 'number', group: 'number' },
  jobSources: {
    searchEnabled: 'boolean',
    recommendEnabled: 'boolean',
    enabledExpectIds: 'stringArray',
    expectationsInitialized: 'boolean',
  },
  searchConditions: {
    directions: 'stringArray',
    city: 'string',
    businessDistricts: 'stringArray',
    salary: 'string',
    experience: 'stringArray',
    degree: 'stringArray',
    jobType: 'stringArray',
  },
  activityFilter: checkboxSchema,
  friendStatus: checkboxSchema,
  sameCompanyFilter: checkboxSchema,
  sameHrFilter: checkboxSchema,
  goldHunterFilter: checkboxSchema,
  useCache: checkboxSchema,
  aiGreeting: { enable: 'boolean' },
  aiFiltering: { enable: 'boolean', score: 'number' },
  amap: accountAmapSchema,
  record: { enable: 'boolean' },
  delay: {
    deliveryInterval: 'number',
    deliveryIntervalMax: 'number',
    messageSending: 'number',
    greetingSegment: 'number',
    batchSize: 'number',
    batchRestMinutes: 'number',
  },
  version: 'string',
  userId: 'stringOrNumber',
} satisfies PublicFormSchema
const pageFormSchema = {
  ...accountFormSchema,
  aiGreeting: {
    enable: 'boolean',
    messageCount: 'number',
    targetTotalCharacters: 'number',
    prompt: 'string',
  },
  amap: { ...accountAmapSchema, key: 'string' },
} satisfies PublicFormSchema

function projectPublicFormValue(value: unknown, schema: PublicFormSchema): unknown {
  if (schema === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (schema === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  if (schema === 'string') return typeof value === 'string' ? value : undefined
  if (schema === 'stringOrNumber') {
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
      ? value
      : undefined
  }
  if (schema === 'stringArray') {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? [...value]
      : undefined
  }
  if (schema === 'primitiveArray') {
    return Array.isArray(value) &&
      value.every(
        (item) =>
          item == null ||
          typeof item === 'string' ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item)),
      )
      ? [...value]
      : undefined
  }
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return undefined

  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, childSchema] of Object.entries(schema)) {
    const projected = projectPublicFormValue(source[key], childSchema)
    if (projected !== undefined) result[key] = projected
  }
  return result
}

export function projectAccountFormData(
  value: unknown,
): (Record<string, unknown> & { userId?: string | number }) | undefined {
  return projectPublicFormValue(value, accountFormSchema) as
    | (Record<string, unknown> & { userId?: string | number })
    | undefined
}

export function projectPageFormData(
  value: unknown,
): (Record<string, unknown> & { userId?: string | number }) | undefined {
  return projectPublicFormValue(value, pageFormSchema) as
    | (Record<string, unknown> & { userId?: string | number })
    | undefined
}
