import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createWorkspaceTypeScriptLoader } from './load-typescript-module.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '..')
const chromeOutputDir = resolve(root, '.output/chrome-mv3')
const jiti = createWorkspaceTypeScriptLoader(root)
const { createDefaultDeliverySettings } = await jiti.import(resolve(root, 'src/config/defaults.ts'))
const generatedPrivatePaths = [
  resolve(root, 'src/private/generated.ts'),
  resolve(root, 'src/private/generated.background.ts'),
]
const textArtifactPattern = /\.(?:css|html|js|json|mjs|txt)$/i
const publicSourceTextPattern =
  /\.(?:cjs|css|html|js|json|jsx|md|mjs|mts|cts|ts|tsx|txt|vue|yaml|yml)$/i
const excludedPublicSourceDirectories = new Set([
  '.git',
  '.output',
  '.serena',
  '.worktrees',
  '.wxt',
  'coverage',
  'node_modules',
])
const excludedLocalPrivateFiles = new Set([
  'data/private/personal-config.json',
  'data/private/public-release-denylist.json',
  'data/private/resume-evidence.json',
  'data/private/resume.md',
  'src/private/generated.background.ts',
  'src/private/generated.ts',
])

export async function verifyPublicConfigPaths() {
  await buildWithoutGeneratedPrivateModules()
  runBehaviorTests()

  const artifacts = await readExtensionArtifacts(chromeOutputDir)
  const forbiddenRuntimeMarkers = [
    'signedKeyBaseUrl',
    'sync:signedKey',
    'generated.background',
    '未配置私有签名服务地址',
  ]
  const markerLeaks = findSensitiveValueLeaks(artifacts, forbiddenRuntimeMarkers)
  assert.equal(
    markerLeaks.length,
    0,
    markerLeaks.length === 0
      ? undefined
      : formatSensitiveLeakMessage(markerLeaks, root, 'legacy private runtime marker'),
  )

  const localBundle = await readJsonIfExists(
    resolve(root, 'data/private/exports/current-config-v1.json'),
  )
  if (localBundle) {
    const publicSettings = createDefaultDeliverySettings()
    const sensitiveLeaks = findSensitiveValueLeaks(
      artifacts,
      collectBundleSensitiveValues(localBundle, publicSettings),
    )
    assert.equal(
      sensitiveLeaks.length,
      0,
      sensitiveLeaks.length === 0
        ? undefined
        : formatSensitiveLeakMessage(sensitiveLeaks, root, 'local configuration value'),
    )

    const sourceLeaks = findSensitiveValueLeaks(
      await readPublicSourceArtifacts(root),
      collectBundleSourceSensitiveValues(localBundle),
    )
    assert.equal(
      sourceLeaks.length,
      0,
      sourceLeaks.length === 0
        ? undefined
        : formatSensitiveLeakMessage(
            sourceLeaks,
            root,
            'local configuration value',
            'public source files',
          ),
    )
  }

  const manifest = JSON.parse(await readFile(resolve(chromeOutputDir, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*'])
  assert.equal(
    (manifest.host_permissions ?? []).some((permission) =>
      /api\.|localhost|127\.0\.0\.1/i.test(permission),
    ),
    false,
  )

  console.log('Universal public build and configuration isolation checks passed.')
}

function runNodeScript(path, args = []) {
  const result = spawnSync(process.execPath, [path, ...args], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function buildWithoutGeneratedPrivateModules() {
  const backups = []
  for (const path of generatedPrivatePaths) {
    if (!(await pathExists(path))) continue
    const backup = `${path}.public-verification-backup`
    await rm(backup, { force: true })
    await rename(path, backup)
    backups.push({ path, backup })
  }

  try {
    await rm(chromeOutputDir, { recursive: true, force: true })
    runNodeScript(resolve(root, 'node_modules/wxt/bin/wxt.mjs'), ['build', '-b', 'chrome'])
  } finally {
    for (const { path, backup } of backups) {
      await rename(backup, path)
    }
  }
}

function runBehaviorTests() {
  const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
  const behaviorTests = [
    'src/config',
    'src/profile',
    'src/background/configService.test.ts',
    'src/message/background.test.ts',
    'src/message/contentScript.test.ts',
    'src/utils/backgroundAi.test.ts',
    'src/utils/backgroundAiConfigured.test.ts',
  ]
  const result = spawnSync(process.execPath, [vitest, 'run', ...behaviorTests], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

export async function readExtensionArtifacts(outputDir) {
  const artifacts = []
  const queue = [outputDir]
  while (queue.length > 0) {
    const directory = queue.shift()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        queue.push(path)
      } else if (entry.isFile() && textArtifactPattern.test(entry.name)) {
        artifacts.push({ path, content: await readFile(path, 'utf8') })
      }
    }
  }
  return artifacts
}

function isExcludedPublicSourcePath(relativePath, isDirectory) {
  const normalized = relativePath.replaceAll('\\', '/')
  if (normalized.split('/').some((segment) => excludedPublicSourceDirectories.has(segment))) {
    return true
  }
  if (normalized === 'data/private/exports' || normalized.startsWith('data/private/exports/')) {
    return true
  }
  return !isDirectory && excludedLocalPrivateFiles.has(normalized)
}

export async function readPublicSourceArtifacts(rootPath) {
  const artifacts = []
  const queue = [rootPath]
  while (queue.length > 0) {
    const directory = queue.shift()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const relativePath = relative(rootPath, path)
      if (isExcludedPublicSourcePath(relativePath, entry.isDirectory())) continue
      if (entry.isDirectory()) {
        queue.push(path)
      } else if (entry.isFile() && publicSourceTextPattern.test(entry.name)) {
        artifacts.push({ path, content: await readFile(path, 'utf8') })
      }
    }
  }
  return artifacts
}

function addSensitiveString(values, value) {
  if (typeof value === 'string' && value.length > 0) values.add(value)
}

function collectStrings(value, values) {
  if (typeof value === 'string') {
    if (value.length >= 8) values.add(value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, values))
    return
  }
  if (value == null || typeof value !== 'object') return
  Object.values(value).forEach((item) => collectStrings(item, values))
}

function collectResumeEvidenceStrings(evidence, values) {
  if (evidence == null || typeof evidence !== 'object') return
  for (const fact of Array.isArray(evidence.facts) ? evidence.facts : []) {
    for (const key of [
      'id',
      'sourceQuote',
      'action',
      'object',
      'domains',
      'skills',
      'allowedClaimVerbs',
    ]) {
      collectStrings(fact?.[key], values)
    }
  }
  for (const bucket of Array.isArray(evidence.buckets) ? evidence.buckets : []) {
    collectStrings(bucket?.id, values)
    collectStrings(bucket?.signals, values)
    collectStrings(bucket?.factIds, values)
  }
  collectStrings(evidence.claimPolicy, values)
}

function collectCoreSensitiveValues(bundle, values) {
  addSensitiveString(values, bundle?.profile?.displayName)
  addSensitiveString(values, bundle?.profile?.resume?.markdown)
  addSensitiveString(values, bundle?.profile?.resume?.sourceHash)
  for (const model of Array.isArray(bundle?.models) ? bundle.models : []) {
    addSensitiveString(values, model?.apiKey)
    addSensitiveString(values, model?.url)
    addSensitiveString(values, model?.model)
  }
  addSensitiveString(values, bundle?.settings?.commute?.apiKey)
  addSensitiveString(values, bundle?.settings?.commute?.origin)
}

function collectNonPublicWorkflowValues(bundle, publicSettings, values) {
  const publicWorkflowValues = new Set()
  collectStrings(publicSettings?.jobRules?.search?.directions, publicWorkflowValues)
  collectStrings(publicSettings?.filters, publicWorkflowValues)

  const configuredWorkflowValues = new Set()
  collectStrings(bundle?.settings?.jobRules?.search?.directions, configuredWorkflowValues)
  collectStrings(bundle?.settings?.filters, configuredWorkflowValues)
  for (const value of configuredWorkflowValues) {
    if (!publicWorkflowValues.has(value)) values.add(value)
  }
}

function collectResumeSourceStrings(evidence, values) {
  if (evidence == null || typeof evidence !== 'object') return
  for (const fact of Array.isArray(evidence.facts) ? evidence.facts : []) {
    for (const key of ['id', 'sourceQuote', 'company', 'role', 'start', 'end', 'object']) {
      collectStrings(fact?.[key], values)
    }
    collectStrings(fact?.metrics, values)
  }
}

export function collectBundleSensitiveValues(bundle, publicSettings = {}) {
  const values = new Set()
  collectCoreSensitiveValues(bundle, values)
  collectResumeEvidenceStrings(bundle?.profile?.resume?.evidence, values)
  collectNonPublicWorkflowValues(bundle, publicSettings, values)
  return [...values]
}

export function collectBundleSourceSensitiveValues(bundle) {
  const values = new Set()
  collectCoreSensitiveValues(bundle, values)
  collectResumeSourceStrings(bundle?.profile?.resume?.evidence, values)
  return [...values]
}

function representations(value) {
  if (typeof value !== 'string' || value.length === 0) return []
  const json = JSON.stringify(value)
  return [...new Set([value, json.slice(1, -1)])]
}

export function findSensitiveValueLeaks(artifacts, sensitiveValues) {
  const leaks = []
  for (const artifact of artifacts) {
    for (const value of sensitiveValues) {
      if (representations(value).some((candidate) => artifact.content.includes(candidate))) {
        leaks.push({ path: artifact.path, value })
      }
    }
  }
  return leaks
}

export function formatSensitiveLeakMessage(
  leaks,
  rootPath,
  label = 'sensitive value',
  location = 'extension artifacts',
) {
  const paths = [...new Set(leaks.map((leak) => relative(rootPath, leak.path)))]
  return `${label} found in ${location}:\n${paths.map((path) => `- ${path}`).join('\n')}`
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await verifyPublicConfigPaths()
}
