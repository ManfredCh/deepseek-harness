import { createUserMessage, BlockAssembler, expandAssistantStream, claimLlmContinuation, registerLlmContinuation, parseLlmFailureDiagnostic } from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { createHash } from 'node:crypto'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../../llm-pi-ai/src/config.ts'
import { memoryAuth } from '../../llm-pi-ai/tests/auth-double.ts'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { MockLlmBehavior, MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as Retry from '../src/index.ts'

let context: Context | undefined
const servers: Promise<MockLlmServer>[] = []
let failureDiagnostics: (() => object) | undefined

afterEach(async (test) => {
  const diagnose = failureDiagnostics
  failureDiagnostics = undefined
  // Capture the pending request before disposal aborts it and closes its socket.
  if (test.task.result?.state === 'fail' && diagnose !== undefined) {
    console.error('transport recovery failure:', JSON.stringify(diagnose()))
  }
  const ownedContext = context
  context = undefined
  // A failed transport can still await a stalled socket while its context disposes.
  const results = await Promise.allSettled([
    ownedContext?.fiber.dispose(),
    ...servers.splice(0).map(async server => (await server).close()),
  ])
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
})

function start(
  sequence: readonly MockLlmBehavior[],
  options: Omit<Parameters<typeof startMockLlmServer>[0], 'sequence'> = {},
): Promise<MockLlmServer> {
  const server = startMockLlmServer({ sequence, ...options })
  servers.push(server)
  return server
}

async function harness(
  baseURL: string,
  options: { streamIdleTimeoutMs?: number; initialDelayMs?: number } = {},
): Promise<Context> {
  vi.stubEnv('DEEPSEEK_API_KEY', 'mock-key')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LlmDeepSeek, {
    baseURL,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 1_000,
    retryPolicy: {
      mode: 'normal',
      maxRetries: 2,
      backoff: {
        initialDelayMs: options.initialDelayMs ?? 10,
        maxDelayMs: options.initialDelayMs ?? 10,
        jitterRatio: 0,
      },
    },
  })
  await ctx.plugin(Retry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function sendAndWait(ctx: Context, agent: Agent): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover through the provider boundary' }], source: { kind: 'user' } }))
  return idle
}

function finalAssistantText(agent: Agent): string | undefined {
  const message = agent.session.deriveMessages().at(-1)
  if (message?.role !== 'assistant') return undefined
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

describe('bounded retry through the real DeepSeek HTTP/SSE adapter', () => {
  it('recovers from a true refused connection after the endpoint starts during backoff', async () => {
    const port = await unusedPort()
    context = await harness(`http://127.0.0.1:${port}`, { initialDelayMs: 100 })
    const agent = await context.agentLoop.create(SessionId('wire-refused'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })
    let recoveryServer: Promise<MockLlmServer> | undefined
    context.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'llm/retry' || event.data.retry !== 1) return
      recoveryServer = start(['success'], { port, apiKey: 'mock-key', successText: 'connected after retry' })
    })

    await sendAndWait(context, agent)
    const server = await recoveryServer

    expect(server).toBeDefined()
    expect(server?.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[1, 1]])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TRANSPORT'])
    expect(finalAssistantText(agent)).toBe('connected after retry')
  })

  it.each([
    ['stream_disconnect', 1] as const,
    ['partial_disconnect', 3] as const,
  ])('retries %s without committing failed chunks', async (behavior, failedChunkCount) => {
    const server = await start([behavior, 'success'], {
      apiKey: 'mock-key',
      partialText: 'discard me',
      chunkSize: 100,
      disconnectDelayMs: 20,
      successText: 'recovered response',
    })
    context = await harness(server.baseURL)
    const agent = await context.agentLoop.create(SessionId(`wire-${behavior}`), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]?.body).toEqual(server.requests[1]?.body)
    const retryEvent = agent.session.snapshotEvents().find(event => event.type === 'llm/retry')
    const failedAttempts = agent.session.snapshotEvents().filter((event): event is SessionEvent<'assistant/attempt'> =>
      event.type === 'assistant/attempt'
      && retryEvent !== undefined
      && event.seq < retryEvent.seq,
    )
    expect(failedAttempts).toHaveLength(1)
    expect(expandAssistantStream(failedAttempts[0]!.data.stream)).toHaveLength(failedChunkCount)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[1, 1]])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TRANSPORT'])
    expect(finalAssistantText(agent)).toBe('recovered response')
  })

  it('retries a wire-valid content-less completion without committing an empty message', async () => {
    const server = await start(['empty', 'success'], {
      apiKey: 'mock-key',
      successText: 'recovered from empty',
    })
    context = await harness(server.baseURL)
    const agent = await context.agentLoop.create(SessionId('wire-empty'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]?.body).toEqual(server.requests[1]?.body)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['EMPTY_RESPONSE'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[1, 1]])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    expect(finalAssistantText(agent)).toBe('recovered from empty')
  })

  it('exposes a clean partial EOF as non-default-retryable STREAM_CLOSED', async () => {
    const server = await start(['partial_eof', 'success'], {
      apiKey: 'mock-key',
      partialText: 'discarded clean eof',
      chunkSize: 100,
    })
    context = await harness(server.baseURL)
    const agent = await context.agentLoop.create(SessionId('wire-partial-eof'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(1)
    const attempt = agent.session.snapshotEvents().find(event => event.type === 'assistant/attempt' && event.data.turn === 1)
    expect(attempt?.type === 'assistant/attempt' ? expandAssistantStream(attempt.data.stream) : []).toHaveLength(3)
    expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'DeepSeek Messages stream ended before message_stop', code: 'STREAM_CLOSED' } } },
    })
  })

  it('turns a stalled body into TIMEOUT and succeeds on the next request', async () => {
    const started = performance.now()
    let phase = 'starting server'
    const observed: { server?: MockLlmServer; agent?: Agent } = {}
    let idleSettled = false
    failureDiagnostics = () => {
      const events = observed.agent?.session.snapshotEvents() ?? []
      return {
        node: process.version,
        phase,
        elapsedMs: Math.round(performance.now() - started),
        idleSettled,
        agentStatus: observed.agent?.status,
        requestCount: observed.server?.requests.length ?? 0,
        requests: observed.server?.requests.map(({ attempt, behavior, outcome, chunksSent }) =>
          ({ attempt, behavior, outcome, chunksSent })),
        retries: events.filter(event => event.type === 'llm/retry').map(event => event.data),
        lastEvents: events.slice(-10).map(event => ({ seq: event.seq, type: event.type })),
      }
    }
    const server = await start(['stall', 'success'], {
      apiKey: 'mock-key',
      successText: 'recovered after timeout',
    })
    observed.server = server
    phase = 'mounting context'
    // This crosses the real HTTP idle timer, so leave scheduler slack between
    // the stalled attempt and the mock server's immediate successful response.
    context = await harness(server.baseURL, { streamIdleTimeoutMs: 1_000 })
    phase = 'creating agent'
    const agent = await context.agentLoop.create(SessionId('wire-stall'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    observed.agent = agent
    phase = 'awaiting agent idle'
    await sendAndWait(context, agent).finally(() => { idleSettled = true })
    phase = 'asserting recovery'

    expect(server.requests.map(record => record.behavior)).toEqual(['stall', 'success'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TIMEOUT'])
    expect(finalAssistantText(agent)).toBe('recovered after timeout')
  })

  it('turns a body that never observes the abort into TIMEOUT and succeeds on the next request', async () => {
    const server = await start(['success'], {
      apiKey: 'mock-key',
      successText: 'recovered from an ignored abort',
    })
    const realFetch = globalThis.fetch
    let attempts = 0
    // A transport that ignores the abort on an in-flight read, as undici does when
    // the abort lands on a pending body read: the abandoned read never settles, so
    // only the idle deadline can end this attempt.
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1
      if (attempts > 1) return realFetch(input, init)
      return Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({ start() {} }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ))
    })
    context = await harness(server.baseURL, { streamIdleTimeoutMs: 1_000 })
    const agent = await context.agentLoop.create(SessionId('wire-ignored-abort'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(attempts).toBe(2)
    expect(server.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TIMEOUT'])
    expect(finalAssistantText(agent)).toBe('recovered from an ignored abort')
  })

  it('stops after the configured transport retry budget is exhausted', async () => {
    const server = await start(['connection_reset', 'connection_reset', 'connection_reset'], {
      apiKey: 'mock-key',
    })
    context = await harness(server.baseURL)
    const agent = await context.agentLoop.create(SessionId('wire-exhausted'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(3)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(2)
    const end = agent.session.snapshotEvents().at(-1)
    expect(end).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'TRANSPORT' } } },
    })
    if (end?.type === 'turn/end' && end.data.reason.kind === 'error') {
      expect(end.data.reason.error.message).toBe('DeepSeek Messages transport failed')
    }
  })
})

// 真正的 PiAi → LlmRuntime → AgentLoop → 原 Retry，使用 loopback HTTP/SSE，零付费。
type CentralBehavior = 'valid' | 'missing-token' | 'wrong-body' | 'missing-optin' | 'invalid-summary' | 'missing-body-hash' | 'wrong-request' | 'generic-first' | 'resume-fails'
const centralServers: Server[] = []
afterEach(async () => {
  await Promise.all(centralServers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function centralFixture(behavior: CentralBehavior = 'valid') {
  const requestId = 'fixture-central-lease'
  const privateToken = 'd'.repeat(64)
  const records: { body: string; headers: IncomingMessage['headers'] }[] = []
  const controlReceived = Promise.withResolvers<void>()
  let initialHash = '', reserved = 0, claimed = 0, revoked = 0
  const server = createServer((request, response) => {
    const bytes: Buffer[] = []
    request.on('data', bytes.push.bind(bytes))
    request.on('end', () => {
      const body = Buffer.concat(bytes).toString('utf8')
      records.push({ body, headers: request.headers })
      if (behavior === 'generic-first' && records.length === 1) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fixture initial HTTP 503' } })); return }
      const hash = createHash('sha256').update(body).digest('hex')
      const continuationHeaders = {
        'x-lyapunov-request-id': requestId,
        ...behavior === 'missing-optin' ? {} : { 'x-lyapunov-continuation': '1' },
        ...behavior === 'missing-token' ? {} : { 'x-lyapunov-resume-token': privateToken },
      }
      const emit = (data: unknown) => response.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
      const failure = (continuation: boolean) => ({ error: {
        code: 'upstream_timeout', message: 'Upstream stream timed out',
        diagnostic: { version: 1, domain: 'model', code: 'TIMEOUT', stage: 'upstream_stream', fieldPath: null,
          retryable: false, effect: 'reserved', requestId,
          ...continuation ? { continuation: { version: 1, requestId, attempt: 1,
            bodySha256: behavior === 'wrong-body' ? 'a'.repeat(64) : initialHash,
            ...behavior === 'invalid-summary' ? { unexpected: 'refused' } : {},
            ...behavior === 'missing-body-hash' ? { bodySha256: undefined } : {},
            ...behavior === 'wrong-request' ? { requestId: 'another-request' } : {},
          } } : {},
        },
      } })
      if (request.headers['x-lyapunov-resume-control'] === 'cancel') {
        if (body === records[0]?.body && hash === initialHash
          && request.headers['x-lyapunov-resume-request'] === requestId
          && request.headers['x-lyapunov-resume-attempt'] === '1'
          && request.headers['x-lyapunov-resume-token'] === privateToken
          && request.headers['x-lyapunov-body-sha256'] === hash) revoked += 1
        response.writeHead(204); response.end(); controlReceived.resolve(); return
      }
      if (request.headers['x-lyapunov-resume-request'] !== undefined) {
        const valid = claimed === 0 && reserved === 1 && body === records[0]?.body && hash === initialHash
          && request.headers['x-lyapunov-resume-request'] === requestId
          && request.headers['x-lyapunov-resume-attempt'] === '1'
          && request.headers['x-lyapunov-resume-token'] === privateToken
          && request.headers['x-lyapunov-body-sha256'] === hash
          && request.headers.authorization === records[0]?.headers.authorization
        if (!valid) { response.writeHead(409); response.end(); return }
        claimed += 1
        response.writeHead(200, { 'content-type': 'text/event-stream', ...continuationHeaders })
        if (behavior === 'resume-fails') { emit(failure(false)); response.end(); return }
        const completeArgs = JSON.stringify({ target: 'fresh-parser', xyz: [1, 2, 3] })
        emit({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-fresh', type: 'function', function: { name: 'get_scene_info', arguments: '' } }] }, index: 0, finish_reason: null }] })
        emit({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: completeArgs } }] }, index: 0, finish_reason: null }] })
        emit({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })
        emit('[DONE]'); response.end(); return
      }
      reserved += 1
      initialHash = hash
      response.writeHead(200, { 'content-type': 'text/event-stream', ...continuationHeaders })
      emit({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-partial', type: 'function', function: { name: 'get_scene_info', arguments: '' } }] }, index: 0, finish_reason: null }] })
      // 半参数恰好249字节；不带 finish、usage 或闭合JSON。
      emit({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"target":"' + 'x'.repeat(238) } }] }, index: 0, finish_reason: null }] })
      emit(failure(true)); response.end()
    })
  })
  centralServers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { baseURL, requestId, privateToken, records, controlReceived: controlReceived.promise,
    counters: () => ({ reserved, claimed, revoked }) }
}

async function centralHarness(baseURL: string, managed = true, beforeRetry?: (ctx: Context) => void, normal = false) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  const profiles = resolveProfiles({ central: { api: 'openai-completions', baseURL,
    ...managed ? { managedBaseURL: baseURL } : {}, models: [{ id: 'public-model' }, { id: 'changed-model' }],
    retryPolicy: { ...normal ? { mode: 'normal' as const, maxRetries: 1 } : { mode: 'always' as const }, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  } })
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('fixture-auth'), auth: memoryAuth() })
  const disposeAdapter = ctx.llm.registerAdapter(['central'], adapter)
  beforeRetry?.(ctx)
  const retryFiber = await ctx.plugin(Retry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const calls: unknown[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'get_scene_info', description: 'read fixture scene', parameters: {},
    async execute(args, exec) { calls.push(args); exec.concludeTurn(); return [{ type: 'text', text: 'scene fixture' }] },
  }))
  return { ctx, calls, retryFiber, disposeAdapter }
}

describe('managed central same-request continuation through original AgentLoop', () => {
  it('discards half tool arguments and resumes exact POST once with fresh parser and one tool side effect', async () => {
    const server = await centralFixture()
    const mounted = await centralHarness(server.baseURL)
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId('central-fresh-parser'), { provider: 'central', model: 'public-model' })
    const order: string[] = [], attemptIds: string[] = []
    context.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject === agent && frame.type === 'start') { order.push('attempt-start'); attemptIds.push(frame.attemptId) }
    })
    context.on('session/event', (session, event) => {
      if (session === agent.session && ['assistant/attempt', 'llm/retry', 'llm/retry-started', 'assistant/message'].includes(event.type)) order.push(event.type)
    })
    await sendAndWait(context, agent)
    expect(server.counters()).toEqual({ reserved: 1, claimed: 1, revoked: 0 })
    expect(server.records).toHaveLength(2)
    expect(server.records[0]?.body).toBe(server.records[1]?.body)
    expect(server.records[0]?.headers['x-lyapunov-continuation']).toBe('1')
    expect(mounted.calls).toEqual([{ target: 'fresh-parser', xyz: [1, 2, 3] }])
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    const scheduled = events.filter(event => event.type === 'llm/retry')
    const started = events.filter(event => event.type === 'llm/retry-started')
    expect(scheduled).toHaveLength(1); expect(started).toHaveLength(1)
    expect(scheduled[0]?.data).toMatchObject({ mode: 'normal', retry: 1, maxRetries: 1, delayMs: 0,
      policyKey: '["central-continuation",1]', failure: { diagnostic: { effect: 'reserved', retryable: false } } })
    expect(started[0]?.data.retryId).toBe(scheduled[0]?.data.retryId)
    expect(events.find(event => event.type === 'assistant/attempt')!.seq).toBeLessThan(scheduled[0]!.seq)
    expect(scheduled[0]!.seq).toBeLessThan(started[0]!.seq)
    expect(started[0]!.seq).toBeLessThan(events.find(event => event.type === 'assistant/message')!.seq)
    expect(order).toEqual(['attempt-start', 'assistant/attempt', 'llm/retry', 'llm/retry-started', 'attempt-start', 'assistant/message'])
    expect(attemptIds).toHaveLength(2); expect(attemptIds[0]).not.toBe(attemptIds[1])
    const partial = events.find(event => event.type === 'assistant/attempt')!
    if (partial.type === 'assistant/attempt') {
      const finish = expandAssistantStream(partial.data.stream).find(item => item.chunk.type === 'finish')?.chunk
      expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { diagnostic: { effect: 'reserved', retryable: false } } } })
    }
    expect(JSON.stringify(events)).not.toContain(server.privateToken)
    expect(JSON.stringify(events)).not.toContain('fixture-auth')
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it.each(['missing-token', 'wrong-body', 'missing-optin', 'invalid-summary', 'missing-body-hash', 'wrong-request'] as const)('never creates a new request when %s invalidates the private continuation', async behavior => {
    const server = await centralFixture(behavior)
    const mounted = await centralHarness(server.baseURL)
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId(`central-${behavior}`), { provider: 'central', model: 'public-model' })
    await sendAndWait(context, agent)
    expect(server.records).toHaveLength(1)
    expect(server.counters()).toEqual({ reserved: 1, claimed: 0, revoked: 0 })
    expect(mounted.calls).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('does not negotiate or resume an arbitrary unmanaged provider', async () => {
    const server = await centralFixture()
    const mounted = await centralHarness(server.baseURL, false)
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId('central-unmanaged'), { provider: 'central', model: 'public-model' })
    await sendAndWait(context, agent)
    expect(server.records).toHaveLength(1)
    expect(server.records[0]?.headers['x-lyapunov-continuation']).toBeUndefined()
    expect(mounted.calls).toHaveLength(0)
  })

  it('does not turn a failed claimed continuation into a third chargeable POST', async () => {
    const server = await centralFixture('resume-fails')
    const mounted = await centralHarness(server.baseURL)
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId('central-once'), { provider: 'central', model: 'public-model' })
    await sendAndWait(context, agent)
    expect(server.records).toHaveLength(2)
    expect(server.counters()).toEqual({ reserved: 1, claimed: 1, revoked: 0 })
    expect(mounted.calls).toHaveLength(0)
  })

  it('cancels the existing lease with original bytes and auth when user Stops during recovery', async () => {
    const server = await centralFixture()
    const mounted = await centralHarness(server.baseURL, true, ctx => {
      ctx.on('agent/request-error', async (payload, next) => {
        payload.agent.cancel({ kind: 'user' })
        return next()
      })
    })
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId('central-stop'), { provider: 'central', model: 'public-model' })
    await sendAndWait(context, agent)
    await server.controlReceived
    expect(server.counters()).toEqual({ reserved: 1, claimed: 0, revoked: 1 })
    expect(server.records).toHaveLength(2)
    expect(server.records[1]?.headers['x-lyapunov-resume-control']).toBe('cancel')
    expect(mounted.calls).toHaveLength(0)
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain(server.privateToken)
  })

  it('requires live transport capability, not a copied public persisted diagnostic', () => {
    const diagnostic = parseLlmFailureDiagnostic({ version: 1, domain: 'model', code: 'TIMEOUT', stage: 'upstream_stream', fieldPath: null,
      retryable: false, effect: 'reserved', requestId: 'historical', continuation: { version: 1, requestId: 'historical', attempt: 1, bodySha256: 'b'.repeat(64) } })
    expect(diagnostic).toBeDefined()
    if (!diagnostic) throw new Error('fixture diagnostic rejected')
    expect(claimLlmContinuation({ code: 'TIMEOUT', message: 'old', diagnostic }, 'central', new AbortController().signal)).toBe(false)
  })
  it('separates simultaneous continuations on one native callerSignal by exact request/body/provider identity', () => {
    const signal = new AbortController().signal
    const summaryA = { version: 1 as const, requestId: 'parallel-a', attempt: 1 as const, bodySha256: 'a'.repeat(64) }
    const summaryB = { version: 1 as const, requestId: 'parallel-b', attempt: 1 as const, bodySha256: 'b'.repeat(64) }
    const claims: string[] = []
    const releaseA = registerLlmContinuation(signal, 'central', summaryA, () => { claims.push('a'); return true })
    const releaseB = registerLlmContinuation(signal, 'central', summaryB, () => { claims.push('b'); return true })
    const failure = (summary: typeof summaryA) => ({ code: 'TIMEOUT', message: 'fixture', diagnostic: {
      version: 1 as const, domain: 'model' as const, code: 'TIMEOUT', stage: 'upstream_stream', fieldPath: null,
      retryable: false, effect: 'reserved' as const, requestId: summary.requestId, continuation: summary,
    } })
    expect(claimLlmContinuation(failure(summaryA), 'other', signal)).toBe(false)
    expect(claimLlmContinuation(failure({ ...summaryA, bodySha256: 'b'.repeat(64) }), 'central', signal)).toBe(false)
    expect(claimLlmContinuation(JSON.parse(JSON.stringify(failure(summaryB))), 'central', signal)).toBe(true)
    expect(claimLlmContinuation(failure(summaryB), 'central', signal)).toBe(false)
    expect(claimLlmContinuation(JSON.parse(JSON.stringify(failure(summaryA))), 'central', signal)).toBe(true)
    expect(claims).toEqual(['b', 'a'])
    releaseA(); releaseB()
  })

  it('drops cancelled and expired in-memory capabilities instead of reviving from a public diagnostic', () => {
    const controller = new AbortController()
    const summary = { version: 1 as const, requestId: 'expired', attempt: 1 as const, bodySha256: 'c'.repeat(64) }
    const failure = { code: 'TIMEOUT', message: 'fixture', diagnostic: { version: 1 as const, domain: 'model' as const,
      code: 'TIMEOUT', stage: 'upstream_headers', fieldPath: null, retryable: false, effect: 'reserved' as const,
      requestId: summary.requestId, continuation: summary } }
    const claim = vi.fn(() => true)
    const clear = registerLlmContinuation(controller.signal, 'central', summary, claim)
    controller.abort('user')
    expect(claimLlmContinuation(failure, 'central', controller.signal)).toBe(false)
    expect(claim).not.toHaveBeenCalled()
    clear()
    const openSignal = new AbortController().signal
    const clearExpired = registerLlmContinuation(openSignal, 'central', summary, claim)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
    expect(claimLlmContinuation(failure, 'central', openSignal)).toBe(false)
    now.mockRestore()
    expect(claim).not.toHaveBeenCalled()
    clearExpired()
  })


  it('keeps distinct same-signal calls independent and resumes only the explicitly claimed original input', async () => {
    const first = await centralFixture()
    const controller = new AbortController()
    const profiles = resolveProfiles({ central: { api: 'openai-completions', baseURL: first.baseURL, managedBaseURL: first.baseURL,
      models: [{ id: 'public-model' }],
    } })
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('fixture-auth'), auth: memoryAuth() })
    const messages = new Map<string, ReturnType<typeof createUserMessage>>()
    const collect = async (text: string) => {
      if (!messages.has(text)) messages.set(text, createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({ provider: 'central', model: 'public-model', signal: controller.signal,
        messages: [messages.get(text)!],
      })) assembler.push(chunk)
      return assembler.finish
    }
    // B shares the exact native cancellation signal, provider and model, but has different public input.
    const a = await collect('request A')
    const b = await collect('request B')
    expect(first.records).toHaveLength(2)
    expect(first.records[1]?.body).not.toBe(first.records[0]?.body)
    expect(first.records[1]?.headers['x-lyapunov-resume-request']).toBeUndefined()
    // Public summary is copied as the real accumulator copies it; matching A still owns its original bytes.
    expect(a.kind).toBe('error'); expect(b.kind).toBe('error')
    if (a.kind !== 'error' || b.kind !== 'error') throw new Error('fixture must fail both initial attempts')
    expect(claimLlmContinuation(a.failure, 'central', controller.signal)).toBe(true)
    // The fixture uses one ID and remembers latest body intentionally, so its CAS rejects A; transport still sends cached A.
    await collect('request A')
    expect(first.records).toHaveLength(3)
    expect(first.records[2]?.body).toBe(first.records[0]?.body)
    expect(first.records[2]?.headers['x-lyapunov-resume-request']).toBe(first.requestId)
    expect(claimLlmContinuation(a.failure, 'central', controller.signal)).toBe(false)
    controller.abort('fixture cleanup')
    await Promise.race([first.controlReceived, Promise.resolve()])
  })

  it('keeps transport continuation separate from an exhausted ordinary retry budget', async () => {
    const server = await centralFixture('generic-first')
    const mounted = await centralHarness(server.baseURL, true, undefined, true)
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId('central-generic-budget'), { provider: 'central', model: 'public-model' })
    const snapshots: unknown[] = []
    context.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry-started') snapshots.push(context!.sessionProjections.stateOf(session, 'llmRetry'))
    })
    await sendAndWait(context, agent)
    expect(server.records).toHaveLength(3)
    expect(server.counters()).toEqual({ reserved: 1, claimed: 1, revoked: 0 })
    const retries = agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
    expect(retries).toHaveLength(2)
    expect(retries[0]!.data).toMatchObject({ retry: 1, maxRetries: 1, failure: { code: 'SERVER' } })
    expect(retries[1]!.data).toMatchObject({ retry: 1, maxRetries: 1, delayMs: 0, policyKey: '["central-continuation",1]' })
    expect(retries[0]!.data.policyKey).not.toBe(retries[1]!.data.policyKey)
    const final = snapshots.at(-1) as Record<string, { retry: number }>
    expect(Object.keys(final)).toHaveLength(2)
    expect(Object.values(final).map(entry => entry.retry)).toEqual([1, 1])
    expect(mounted.calls).toEqual([{ target: 'fresh-parser', xyz: [1, 2, 3] }])
  })

  it.each(['llm/retry', 'llm/retry-started'] as const)('does not send a claimed continuation after user Stop from %s', async stage => {
    const server = await centralFixture()
    const mounted = await centralHarness(server.baseURL)
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId(`central-stop-${stage}`), { provider: 'central', model: 'public-model' })
    context.on('session/event', (session, event) => { if (session === agent.session && event.type === stage) agent.cancel({ kind: 'user' }) })
    await sendAndWait(context, agent)
    await server.controlReceived
    expect(server.counters()).toEqual({ reserved: 1, claimed: 0, revoked: 1 })
    expect(server.records).toHaveLength(2)
    expect(mounted.calls).toHaveLength(0)
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(events.filter(event => event.type === 'llm/retry-started')).toHaveLength(stage === 'llm/retry' ? 0 : 1)
    expect(JSON.stringify(events)).not.toContain(server.privateToken)
  })

  it('does not send a claimed continuation after the original Retry plugin is disposed during its zero-delay wait', async () => {
    const server = await centralFixture()
    const mounted = await centralHarness(server.baseURL)
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId('central-dispose'), { provider: 'central', model: 'public-model' })
    let disposing: Promise<unknown> | undefined
    context.on('session/event', (session, event) => { if (session === agent.session && event.type === 'llm/retry') disposing = mounted.retryFiber.dispose() })
    await sendAndWait(context, agent)
    await disposing
    expect(server.records).toHaveLength(1)
    expect(server.counters()).toEqual({ reserved: 1, claimed: 0, revoked: 0 })
    expect(mounted.calls).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry-started')).toHaveLength(0)
    // 用户原请求仍保持保守未知；此处停止本测试拥有的 signal 并清理其剩余租约。
    agent.cancel({ kind: 'disposed' })
  })

  it.each(['llm/retry', 'llm/retry-started'] as const)('does not dispatch after the durable %s append fails', async stage => {
    const server = await centralFixture()
    const mounted = await centralHarness(server.baseURL)
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId(`central-append-${stage}`), { provider: 'central', model: 'public-model' })
    const append = agent.session.append.bind(agent.session)
    const spy = vi.spyOn(agent.session, 'append').mockImplementation((...args) => {
      if (args[0] === stage) throw new Error('fixture durable retry append rejected')
      return Reflect.apply(append, agent.session, args)
    })
    try { await sendAndWait(context, agent) } finally { spy.mockRestore() }
    expect(server.records).toHaveLength(1)
    expect(server.counters()).toEqual({ reserved: 1, claimed: 0, revoked: 0 })
    expect(mounted.calls).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry-started')).toHaveLength(0)
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain(server.privateToken)
  })

  it.each(['maxTokens', 'model', 'provider', 'adapter'] as const)('rejects an armed original series when native request preparation changes %s, without a fresh POST', async variation => {
    const server = await centralFixture()
    const mounted = await centralHarness(server.baseURL)
    context = mounted.ctx
    let disposeReplacement: (() => void) | undefined
    if (variation === 'provider') {
      const alternateProfiles = resolveProfiles({ alternate: { api: 'openai-completions', baseURL: server.baseURL,
        managedBaseURL: server.baseURL, models: [{ id: 'public-model' }],
      } })
      context.llm.registerAdapter(['alternate'], new PiAiAdapter({ profiles: () => alternateProfiles,
        resolveApiKey: () => Promise.resolve('fixture-auth'), auth: memoryAuth() }))
    }
    const first = await context.agentLoop.create(SessionId(`central-armed-changed-${variation}`), {
      provider: 'central', model: 'public-model', maxTokens: 128,
    })
    let prepares = 0
    context.on('agent/request', async (payload, next) => {
      const config = await next()
      if (payload.agent !== first || ++prepares < 2) return config
      if (variation === 'maxTokens') return { ...config, maxTokens: 256 }
      if (variation === 'model') return { ...config, model: 'changed-model' }
      if (variation === 'provider') return { ...config, provider: 'alternate' }
      // 原 native registration 原子替换；provider/model未变也不能改adapter身份。
      mounted.disposeAdapter()
      const replacementProfiles = resolveProfiles({ central: { api: 'openai-completions', baseURL: server.baseURL,
        managedBaseURL: server.baseURL, models: [{ id: 'public-model' }],
      } })
      disposeReplacement = context!.llm.registerAdapter(['central'], new PiAiAdapter({ profiles: () => replacementProfiles,
        resolveApiKey: () => Promise.resolve('fixture-auth'), auth: memoryAuth() }))
      return config
    })
    try {
      await sendAndWait(context, first)
      expect(prepares).toBe(2)
      expect(server.records).toHaveLength(1)
      expect(server.counters()).toEqual({ reserved: 1, claimed: 0, revoked: 0 })
      expect(mounted.calls).toHaveLength(0)
      const events = first.session.snapshotEvents()
      expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
      expect(events.filter(event => event.type === 'llm/retry-started')).toHaveLength(1)
      const terminal = events.at(-1)
      expect(terminal).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: {
        code: 'CENTRAL_CONTINUATION_BINDING_INVALID', diagnostic: { effect: 'reserved', retryable: false },
      } } } })
      expect(JSON.stringify(events)).not.toContain(server.privateToken)
      expect(JSON.stringify(events)).not.toContain('fixture-auth')
    } finally { disposeReplacement?.() }
  })

  it('keeps an expired armed original series fail-closed after its timers fire, without a fresh paid POST', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const scheduled = Promise.withResolvers<void>(), secondPrepare = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let task: Promise<void> | undefined
    try {
      const server = await centralFixture()
      const mounted = await centralHarness(server.baseURL)
      context = mounted.ctx
      const agent = await context.agentLoop.create(SessionId('central-expired-armed'), { provider: 'central', model: 'public-model', maxTokens: 128 })
      let prepares = 0, abortedAtDispatch: boolean | undefined
      context.on('agent/request', async (payload, next) => {
        const config = await next()
        if (payload.agent === agent && ++prepares === 2) {
          secondPrepare.resolve(); await release.promise; abortedAtDispatch = payload.signal.aborted
        }
        return config
      })
      context.on('session/event', (session, event) => { if (session === agent.session && event.type === 'llm/retry') scheduled.resolve() })
      task = sendAndWait(context, agent)
      await scheduled.promise; await vi.advanceTimersByTimeAsync(0); await secondPrepare.promise
      await vi.advanceTimersByTimeAsync(60_001)
      const expiredWallClock = Date.now()
      vi.useRealTimers(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(expiredWallClock)
      release.resolve(); await task
      expect(abortedAtDispatch).toBe(false)
      expect(server.records).toHaveLength(1)
      expect(server.counters()).toEqual({ reserved: 1, claimed: 0, revoked: 0 })
      expect(mounted.calls).toHaveLength(0)
      const events = agent.session.snapshotEvents()
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: {
        code: 'CENTRAL_CONTINUATION_BINDING_INVALID', diagnostic: { effect: 'reserved', retryable: false },
      } } } })
      expect(JSON.stringify(events)).not.toContain(server.privateToken)
      expect(JSON.stringify(events)).not.toContain('fixture-auth')
    } finally { vi.useRealTimers(); release.resolve(); await task?.catch(() => {}) }
  })

})
