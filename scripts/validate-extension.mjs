import { access, readdir, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const [, , outDirArg = '.output/chrome-mv3', target = 'chrome'] = process.argv
// Edge 商店的名称/描述长度限制与 Chrome 一致，两者共用同一套上限。
const isChromium = target === 'chrome' || target === 'edge'
const root = process.cwd()
const outDir = resolve(root, outDirArg)
const manifestPath = resolve(outDir, 'manifest.json')
const errors = []

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error instanceof Error ? error.message : error}`)
    return null
  }
}

async function existsRelative(path, label) {
  if (typeof path !== 'string' || path.trim() === '') {
    errors.push(`${label} must be a non-empty string`)
    return false
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    errors.push(`${label} must be relative and must not start with "/": ${path}`)
    return false
  }
  if (path.includes('\\')) {
    errors.push(`${label} must use "/" instead of "\\": ${path}`)
    return false
  }
  if (path.split('/').includes('..')) {
    errors.push(`${label} must not contain "..": ${path}`)
    return false
  }
  try {
    await access(resolve(outDir, path.split('/').join(sep)))
    return true
  } catch {
    errors.push(`${label} references a missing file: ${path}`)
    return false
  }
}

function asArray(value, label) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return []
  }
  return value
}

function validateMatchPattern(pattern, label) {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    errors.push(`${label} must be a non-empty string`)
    return
  }
  if (pattern === '<all_urls>') return
  const valid =
    /^(http|https|\*|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.test(pattern) ||
    /^file:\/\/\/.*$/.test(pattern)
  if (!valid) {
    errors.push(`${label} is not a supported extension match pattern: ${pattern}`)
  }
}

function resolveMessage(text, localeMessages, label) {
  const match = typeof text === 'string' ? /^__MSG_([A-Za-z0-9_@]+)__$/.exec(text) : null
  if (!match) return text
  const key = match[1]
  const message = localeMessages?.[key]?.message
  if (typeof message !== 'string') {
    errors.push(`${label} references missing locale key: ${key}`)
    return ''
  }
  return message
}

async function readDefaultLocale(manifest) {
  let localeEntries = []
  try {
    localeEntries = await readdir(resolve(outDir, '_locales'), { withFileTypes: true })
  } catch {
    localeEntries = []
  }
  const hasLocales = localeEntries.some((entry) => entry.isDirectory())
  if (hasLocales && !manifest.default_locale) {
    errors.push('default_locale is required when _locales exists in the extension output')
    return null
  }
  if (!manifest.default_locale) return null
  const localePath = resolve(outDir, '_locales', manifest.default_locale, 'messages.json')
  return readJson(localePath, `default locale ${manifest.default_locale}`)
}

async function validateLocales(manifest, defaultMessages) {
  const usesMessages = [manifest.name, manifest.description, manifest.short_name].some(
    (value) => typeof value === 'string' && value.includes('__MSG_'),
  )
  if (usesMessages && !manifest.default_locale) {
    errors.push('default_locale is required when manifest uses __MSG_*__ values')
  }
  if (manifest.default_locale && defaultMessages == null) return

  const name = resolveMessage(manifest.name, defaultMessages, 'manifest.name')
  const description = resolveMessage(manifest.description, defaultMessages, 'manifest.description')
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push('resolved manifest.name must be non-empty')
  } else if (isChromium && name.length > 45) {
    errors.push(`resolved manifest.name is too long for ${target} (${name.length}/45)`)
  }
  if (typeof description === 'string' && isChromium && description.length > 132) {
    errors.push(
      `resolved manifest.description is too long for ${target} (${description.length}/132)`,
    )
  }

  if (defaultMessages) {
    for (const [key, value] of Object.entries(defaultMessages)) {
      if (typeof value?.message !== 'string') {
        errors.push(`locale message "${key}" must contain a string message`)
      }
    }
  }
}

/**
 * Chromium MV3 跑 service worker，Firefox MV3 跑 event page（`background.scripts`）。
 * 形状搞反了扩展根本起不来，所以按目标断言，而不是「有哪个就查哪个」——
 * 后者在 Firefox 拿到 service_worker 时会一声不响地跳过。
 */
async function validateBackground(manifest) {
  const background = manifest.background
  if (background == null) {
    errors.push('background is required')
    return
  }
  if (target === 'firefox') {
    const scripts = asArray(background.scripts ?? [], 'background.scripts')
    if (scripts.length === 0) {
      errors.push('background.scripts must not be empty for Firefox (MV3 has no service worker)')
    }
    if (background.service_worker) {
      errors.push('background.service_worker is not supported by Firefox')
    }
    for (const [index, path] of scripts.entries()) {
      await existsRelative(path, `background.scripts[${index}]`)
    }
    return
  }
  if (!background.service_worker) {
    errors.push(`background.service_worker is required for ${target}`)
    return
  }
  await existsRelative(background.service_worker, 'background.service_worker')
}

/**
 * 用户自填的 AI 接口地址靠 `permissions.request({ origins })` 授权，origin 没在
 * manifest 里声明过就必然被拒。这个键在 MV2 转换中会被静默丢弃，丢了不报错、
 * 构建照样通过，只有真机上 AI 功能才会失效——所以必须在这里守住。
 */
function validateOptionalHostPermissions(manifest) {
  const origins = asArray(manifest.optional_host_permissions ?? [], 'optional_host_permissions')
  if (origins.length === 0) {
    errors.push('optional_host_permissions must not be empty; AI endpoints cannot be granted')
  }
  origins.forEach((origin, index) =>
    validateMatchPattern(origin, `optional_host_permissions[${index}]`),
  )
  if (target !== 'firefox') return
  // 旧版 Firefox 只读 optional_permissions 里的 origin。
  const fallback = asArray(manifest.optional_permissions ?? [], 'optional_permissions')
  for (const origin of origins) {
    if (!fallback.includes(origin)) {
      errors.push(
        `optional_permissions must mirror optional_host_permissions for Firefox: ${origin}`,
      )
    }
  }
}

/** Firefox 没有 gecko id 无法安装，也无法提交签名。 */
function validateFirefoxSettings(manifest) {
  if (target !== 'firefox') return
  const gecko = manifest.browser_specific_settings?.gecko
  if (gecko == null) {
    errors.push('browser_specific_settings.gecko is required for Firefox')
    return
  }
  if (
    typeof gecko.id !== 'string' ||
    !/^[a-z0-9\-._]*@[a-z0-9\-._]+$|^\{[0-9a-fA-F-]{36}\}$/.test(gecko.id)
  ) {
    errors.push(`browser_specific_settings.gecko.id is missing or malformed: ${gecko.id}`)
  }
  if (typeof gecko.strict_min_version !== 'string') {
    errors.push('browser_specific_settings.gecko.strict_min_version is required for Firefox')
  }
}

async function validateManifestFiles(manifest) {
  if (manifest.options_ui?.page) {
    await existsRelative(manifest.options_ui.page, 'options_ui.page')
  }
  for (const [size, path] of Object.entries(manifest.icons ?? {})) {
    if (!/^\d+$/.test(size)) errors.push(`icon size must be numeric: ${size}`)
    await existsRelative(path, `icons.${size}`)
  }
}

async function validateContentScripts(manifest) {
  const scripts = asArray(manifest.content_scripts ?? [], 'content_scripts')
  for (const [index, script] of scripts.entries()) {
    const label = `content_scripts[${index}]`
    const matches = asArray(script.matches ?? [], `${label}.matches`)
    if (matches.length === 0) errors.push(`${label}.matches must not be empty`)
    matches.forEach((match, matchIndex) =>
      validateMatchPattern(match, `${label}.matches[${matchIndex}]`),
    )

    const js = asArray(script.js ?? [], `${label}.js`)
    const css = asArray(script.css ?? [], `${label}.css`)
    if (js.length === 0) {
      errors.push(`${label}.js must not be empty`)
    }
    if (js.length === 0 && css.length === 0) {
      errors.push(`${label} must define js or css`)
    }
    for (const [jsIndex, path] of js.entries()) {
      await existsRelative(path, `${label}.js[${jsIndex}]`)
    }
    for (const [cssIndex, path] of css.entries()) {
      await existsRelative(path, `${label}.css[${cssIndex}]`)
    }
  }
}

async function validateWebAccessibleResources(manifest) {
  const resources = asArray(manifest.web_accessible_resources ?? [], 'web_accessible_resources')
  for (const [index, entry] of resources.entries()) {
    const label = `web_accessible_resources[${index}]`
    const files = asArray(entry.resources ?? [], `${label}.resources`)
    const matches = asArray(entry.matches ?? [], `${label}.matches`)
    if (files.length === 0) errors.push(`${label}.resources must not be empty`)
    if (matches.length === 0) errors.push(`${label}.matches must not be empty`)
    for (const [fileIndex, path] of files.entries()) {
      await existsRelative(path, `${label}.resources[${fileIndex}]`)
    }
    matches.forEach((match, matchIndex) =>
      validateMatchPattern(match, `${label}.matches[${matchIndex}]`),
    )
  }
}

function validateHostPermissions(manifest) {
  const permissions = asArray(manifest.host_permissions ?? [], 'host_permissions')
  for (const [index, permission] of permissions.entries()) {
    validateMatchPattern(permission, `host_permissions[${index}]`)
  }
}

async function main() {
  const manifest = await readJson(manifestPath, 'manifest.json')
  if (!manifest) return

  if (manifest.manifest_version !== 3) {
    errors.push(`manifest_version must be 3, got ${manifest.manifest_version}`)
  }
  const defaultMessages = await readDefaultLocale(manifest)
  await validateLocales(manifest, defaultMessages)
  await validateBackground(manifest)
  await validateManifestFiles(manifest)
  await validateContentScripts(manifest)
  await validateWebAccessibleResources(manifest)
  validateHostPermissions(manifest)
  validateOptionalHostPermissions(manifest)
  validateFirefoxSettings(manifest)

  if (errors.length > 0) {
    console.error(`Extension validation failed for ${outDirArg}:`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  console.log(`Extension validation passed for ${outDirArg}.`)
}

await main()
