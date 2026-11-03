import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { createLocalLogSinkServer } from './local-log-sink.mjs'

const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    id: `event-${Math.random().toString(36).slice(2)}`,
    at: Date.now(),
    accountUid: 'account-anonymous',
    stream: 'deliveries',
    event: 'delivery.finished',
    data: {
      jobId: 'job-1',
      jobName: 'AI 产品经理',
      message: '投递成功',
      ...overrides,
    },
  }
}

describe('local log sink', () => {
  it('keeps structured detail, sequences and JSON boundaries through URL sanitization', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'easy-job-log-'))
    const sink = createLocalLogSinkServer({ root, port: 0 })
    servers.push(sink)
    const address = await sink.listen()
    const input = {
      ...event({
        message:
          '{"url":"https://example.test/job?secret=value","result":"waiting","durationMs":105000}',
        detail: { durationMs: 105000, reason: 'connection', count: 31 },
      }),
      sourceSessionId: 'session-test',
      sequence: 7,
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [input] }),
    })
    assert.deepEqual(await response.json(), { ok: true, accepted: 1 })
    const files = await readdir(path.join(root, 'deliveries'))
    const stored = JSON.parse(await readFile(path.join(root, 'deliveries', files[0]), 'utf8'))
    assert.equal(stored.sourceSessionId, 'session-test')
    assert.equal(stored.sequence, 7)
    assert.deepEqual(JSON.parse(stored.data.message), {
      url: 'https://example.test/job?secret=[已脱敏]',
      result: 'waiting',
      durationMs: 105000,
    })
    assert.deepEqual(stored.data.detail, { durationMs: 105000, reason: 'connection', count: 31 })
    await rm(root, { recursive: true, force: true })
  })
  it('writes complete business diagnostics while removing credentials', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'easy-job-log-'))
    const sink = createLocalLogSinkServer({ root, port: 0 })
    servers.push(sink)
    const address = await sink.listen()
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          event({
            apiKey: 'secret-key',
            fullPrompt: '完整 Prompt',
            resumeMarkdown: '简历全文',
            jd: '完整 JD',
            error: 'Bearer abc',
          }),
        ],
      }),
    })
    assert.equal(response.status, 202)
    const files = await readdir(path.join(root, 'deliveries'))
    assert.equal(files.length, 1)
    const saved = JSON.parse(await readFile(path.join(root, 'deliveries', files[0]), 'utf8'))
    assert.equal(saved.data.jobName, 'AI 产品经理')
    assert.equal(saved.data.apiKey, undefined)
    assert.equal(saved.data.fullPrompt, '完整 Prompt')
    assert.equal(saved.data.resumeMarkdown, '简历全文')
    assert.equal(saved.data.jd, '完整 JD')
    assert.equal(saved.data.error, 'Bearer [已脱敏]')
    await rm(root, { recursive: true, force: true })
  })

  it('preserves usage counters, ordinary key text, and non-credential URL parameters', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'easy-job-log-'))
    const sink = createLocalLogSinkServer({ root, port: 0 })
    servers.push(sink)
    const address = await sink.listen()
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          event({
            input_tokens: 1200,
            output_tokens: 340,
            reasoning_tokens: 80,
            max_output_tokens: 2048,
            keyName: 'key-business-domain',
            requestUrl:
              'wss://example.test/chat?access_token=private-token&direction=incoming&jobId=job-1',
          }),
        ],
      }),
    })
    assert.equal(response.status, 202)
    const files = await readdir(path.join(root, 'deliveries'))
    const saved = JSON.parse(await readFile(path.join(root, 'deliveries', files[0]), 'utf8'))
    assert.deepEqual(
      {
        input_tokens: saved.data.input_tokens,
        output_tokens: saved.data.output_tokens,
        reasoning_tokens: saved.data.reasoning_tokens,
        max_output_tokens: saved.data.max_output_tokens,
        keyName: saved.data.keyName,
        requestUrl: saved.data.requestUrl,
      },
      {
        input_tokens: 1200,
        output_tokens: 340,
        reasoning_tokens: 80,
        max_output_tokens: 2048,
        keyName: 'key-business-domain',
        requestUrl: 'wss://example.test/chat?access_token=[已脱敏]&direction=incoming&jobId=job-1',
      },
    )
    await rm(root, { recursive: true, force: true })
  })

  it('accepts a full extension batch of large but valid events', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'easy-job-log-'))
    const sink = createLocalLogSinkServer({ root, port: 0 })
    servers.push(sink)
    const address = await sink.listen()
    const events = Array.from({ length: 25 }, (_, index) =>
      event({
        jobId: `large-job-${index}`,
        fullPrompt: '完整 Prompt '.repeat(30_000),
      }),
    )
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { ok: true, accepted: 25 })
    await rm(root, { recursive: true, force: true })
  })

  it('exposes a local health endpoint and rejects malformed events', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'easy-job-log-'))
    const sink = createLocalLogSinkServer({ root, port: 0 })
    servers.push(sink)
    const address = await sink.listen()
    const health = await fetch(`http://127.0.0.1:${address.port}/health`)
    assert.deepEqual(await health.json(), { ok: true, schemaVersion: 1, retentionDays: 0 })
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ schemaVersion: 1 }] }),
    })
    assert.equal(response.status, 400)
    await rm(root, { recursive: true, force: true })
  })

  it('keeps old evidence when no retention policy is configured', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'easy-job-log-'))
    const sink = createLocalLogSinkServer({ root, port: 0 })
    servers.push(sink)
    const address = await sink.listen()
    const oldAt = Date.now() - 365 * 24 * 60 * 60 * 1000
    const input = { ...event({ jobId: 'old-evidence-job' }), at: oldAt }
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [input] }),
    })
    assert.equal(response.status, 202)
    const oldDay = new Date(oldAt).toISOString().slice(0, 10)
    const files = await readdir(path.join(root, 'deliveries'))
    assert.deepEqual(files, [`${oldDay}.ndjson`])
    await rm(root, { recursive: true, force: true })
  })

  it('stores greeting and conversation feedback in its own stream', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'easy-job-log-'))
    const sink = createLocalLogSinkServer({ root, port: 0 })
    servers.push(sink)
    const address = await sink.listen()
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            ...event({
              direction: 'incoming',
              text: '您好，方便聊一下这个岗位吗？',
              textLength: 15,
            }),
            stream: 'feedback',
            event: 'conversation.message',
          },
        ],
      }),
    })
    assert.equal(response.status, 202)
    const files = await readdir(path.join(root, 'feedback'))
    assert.equal(files.length, 1)
    const saved = JSON.parse(await readFile(path.join(root, 'feedback', files[0]), 'utf8'))
    assert.equal(saved.stream, 'feedback')
    assert.equal(saved.data.direction, 'incoming')
    assert.equal(saved.data.text, '您好，方便聊一下这个岗位吗？')
    await rm(root, { recursive: true, force: true })
  })

  it('deduplicates a retransmitted event ID after the receipt is lost', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'easy-job-log-'))
    const sink = createLocalLogSinkServer({ root, port: 0 })
    servers.push(sink)
    const address = await sink.listen()
    const input = event({ jobId: 'retry-job', message: '只应落盘一次' })
    const post = () =>
      fetch(`http://127.0.0.1:${address.port}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [input] }),
      })
    assert.deepEqual(await (await post()).json(), { ok: true, accepted: 1 })
    assert.deepEqual(await (await post()).json(), { ok: true, accepted: 1 })
    const files = await readdir(path.join(root, 'deliveries'))
    const lines = (await readFile(path.join(root, 'deliveries', files[0]), 'utf8'))
      .trim()
      .split(/\r?\n/)
    assert.equal(lines.length, 1)
    await rm(root, { recursive: true, force: true })
  })
})
