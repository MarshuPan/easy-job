import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  collectBundleSourceSensitiveValues,
  collectBundleSensitiveValues,
  findSensitiveValueLeaks,
  formatSensitiveLeakMessage,
  readExtensionArtifacts,
  readPublicSourceArtifacts,
} from './verify-public-config-paths.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('artifact scan includes every emitted text asset', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'agent-delivery-artifacts-'))
  await mkdir(join(outputDir, 'assets'), { recursive: true })
  await Promise.all([
    writeFile(join(outputDir, 'background.js'), 'background marker'),
    writeFile(join(outputDir, 'options.html'), '<main>options marker</main>'),
    writeFile(join(outputDir, 'assets', 'main.css'), '.main { color: red }'),
    writeFile(join(outputDir, 'asset.png'), 'binary marker'),
  ])

  try {
    const paths = (await readExtensionArtifacts(outputDir))
      .map((artifact) => relative(outputDir, artifact.path).replaceAll('\\', '/'))
      .sort()
    assert.deepEqual(paths, ['assets/main.css', 'background.js', 'options.html'])
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
})

test('public source scan includes working-tree text while excluding local and generated data', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'agent-delivery-sources-'))
  await Promise.all([
    mkdir(join(sourceDir, 'src'), { recursive: true }),
    mkdir(join(sourceDir, 'docs'), { recursive: true }),
    mkdir(join(sourceDir, 'data', 'private', 'exports'), { recursive: true }),
    mkdir(join(sourceDir, 'node_modules', 'package'), { recursive: true }),
    mkdir(join(sourceDir, '.output'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(sourceDir, 'src', 'public.ts'), 'export const marker = true'),
    writeFile(join(sourceDir, 'docs', 'public.md'), '# Public'),
    writeFile(join(sourceDir, 'data', 'private', 'resume.md'), 'private resume'),
    writeFile(join(sourceDir, 'data', 'private', 'exports', 'current-config-v1.json'), '{}'),
    writeFile(join(sourceDir, 'node_modules', 'package', 'index.js'), 'dependency'),
    writeFile(join(sourceDir, '.output', 'background.js'), 'generated'),
    writeFile(join(sourceDir, 'asset.png'), 'binary'),
  ])

  try {
    const paths = (await readPublicSourceArtifacts(sourceDir))
      .map((artifact) => relative(sourceDir, artifact.path).replaceAll('\\', '/'))
      .sort()
    assert.deepEqual(paths, ['docs/public.md', 'src/public.ts'])
  } finally {
    await rm(sourceDir, { recursive: true, force: true })
  }
})

test('sensitive leak reporting never echoes the sensitive value', () => {
  const secret = 'private-secret-exact-value'
  const artifacts = [{ path: join(root, '.output', 'background.js'), content: secret }]
  const leaks = findSensitiveValueLeaks(artifacts, [secret])
  assert.equal(leaks.length, 1)
  const message = formatSensitiveLeakMessage(leaks, root)
  assert.match(message, /\.output/)
  assert.equal(message.includes(secret), false)
})

test('bundle scan covers model, profile and user-rule values without treating prompts as leaks', () => {
  const values = collectBundleSensitiveValues(
    {
      profile: {
        displayName: 'candidate-private-name',
        resume: {
          markdown: 'candidate-private-resume',
          sourceHash: 'sha256:private-hash',
          evidence: {
            facts: [
              {
                id: 'private-fact-id',
                sourceQuote: 'private-evidence-quote',
                action: 'private-action',
                object: 'private-object',
                ownership: 'contributed',
                domains: ['private-domain'],
                skills: ['private-skill'],
                evidenceType: 'direct_fact',
                allowedClaimVerbs: ['private-claim-verb'],
                confidence: 'high',
              },
            ],
            buckets: [],
            claimPolicy: { adjacentOnly: [], forbiddenClaims: ['private-forbidden-claim'] },
          },
        },
      },
      models: [
        {
          apiKey: 'private-api-key',
          url: 'https://private.example.test/v1',
          model: 'private-model',
        },
      ],
      tasks: { aiGreeting: { prompt: 'default prompt may be bundled' } },
      settings: {
        commute: { apiKey: 'private-amap-key', origin: 'private-home-address' },
        jobRules: {
          search: { directions: ['public-default-direction', 'private-job-direction'] },
        },
        filters: {
          company: { values: ['public-default-filter', 'private-company-rule'] },
        },
      },
    },
    {
      jobRules: { search: { directions: ['public-default-direction'] } },
      filters: {
        company: { values: ['public-default-filter'] },
      },
    },
  )

  assert.ok(values.includes('private-api-key'))
  assert.ok(values.includes('candidate-private-resume'))
  assert.ok(values.includes('private-evidence-quote'))
  assert.ok(values.includes('private-forbidden-claim'))
  assert.ok(values.includes('private-job-direction'))
  assert.ok(values.includes('private-company-rule'))
  assert.equal(values.includes('public-default-direction'), false)
  assert.equal(values.includes('public-default-filter'), false)
  assert.equal(values.includes('contributed'), false)
  assert.equal(values.includes('direct_fact'), false)
  assert.equal(values.includes('default prompt may be bundled'), false)
})

test('source scan covers identity, models and direct resume facts without flagging generic rules', () => {
  const values = collectBundleSourceSensitiveValues({
    profile: {
      displayName: 'candidate-private-name',
      resume: {
        markdown: 'candidate-private-resume',
        sourceHash: 'sha256:private-hash',
        evidence: {
          facts: [
            {
              id: 'private-fact-id',
              sourceQuote: 'private direct resume evidence quote',
              object: 'private resume project object',
              metrics: [{ value: 'private metric value' }],
            },
          ],
          claimPolicy: {
            adjacentOnly: ['generic policy may appear in public documentation'],
          },
        },
      },
    },
    models: [
      {
        apiKey: 'private-api-key',
        url: 'https://private.example.test/v1',
        model: 'private-model',
      },
    ],
    tasks: {
      aiFiltering: { prompt: 'public filtering prompt' },
      aiGreeting: { prompt: 'private customized greeting prompt' },
    },
    settings: {
      commute: { apiKey: 'private-amap-key', origin: 'private-home-address' },
      jobRules: {
        search: { directions: ['public-default-direction', 'private-job-direction'] },
      },
      filters: {
        company: { values: ['public-default-filter', 'private-company-rule'] },
      },
    },
  })

  assert.ok(values.includes('candidate-private-name'))
  assert.ok(values.includes('private-api-key'))
  assert.ok(values.includes('https://private.example.test/v1'))
  assert.ok(values.includes('private-model'))
  assert.ok(values.includes('private direct resume evidence quote'))
  assert.ok(values.includes('private metric value'))
  assert.equal(values.includes('generic policy may appear in public documentation'), false)
  assert.equal(values.includes('public filtering prompt'), false)
  assert.equal(values.includes('private customized greeting prompt'), false)
  assert.equal(values.includes('private-job-direction'), false)
  assert.equal(values.includes('public-default-direction'), false)
  assert.equal(values.includes('public-default-filter'), false)
})

test('ordinary commands and verifier do not generate build-time private modules', async () => {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const scripts = packageJson.scripts ?? {}
  for (const name of [
    'dev',
    'dev:edge',
    'dev:firefox',
    'test',
    'check',
    'lint',
    'build',
    'build:chrome',
    'build:firefox',
    'build:edge',
    'zip',
    'zip:chrome',
    'zip:firefox',
    'zip:edge',
  ]) {
    assert.equal(String(scripts[name]).includes('generate-private-config'), false, name)
    assert.equal(Object.hasOwn(scripts, `pre${name}`), false, `pre${name}`)
  }
  assert.equal(Object.hasOwn(scripts, 'generate:private'), false)

  const verifier = await readFile(join(root, 'scripts/verify-public-config-paths.mjs'), 'utf8')
  assert.equal(verifier.includes('generate-private-config'), false)
  assert.equal(verifier.includes('private-config-artifacts'), false)
})
