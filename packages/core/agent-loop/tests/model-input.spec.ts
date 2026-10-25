import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createAssistantMessage, createDeveloperMessage, createSystemMessage, createToolResultMessage, createUserMessage, markAgentLoopRequest, ToolCallId, type GenerateOptions, type Message, type RequestMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { type ModelMessageProjection } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { deriveModelRequestMessages } from '../src/model-input.ts'
import { contextSnapshotIntent, currentContextMessages } from '../src/runtime-context.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const image = { type: 'image' as const, attachment: { attachmentId: AttachmentId('fixture-image'), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 } }
class FixtureProjection extends Service implements ModelMessageProjection {
  constructor(ctx: Context, private readonly config: ModelMessageProjection) { super(ctx, 'modelMessageProjection') }
  project(...args: Parameters<ModelMessageProjection['project']>) { return this.config.project(...args) }
}
const formal: ModelMessageProjection = {
  project: messages => messages.map(message => message.role === 'system' && message.source.kind === 'system-prompt'
    ? { ...message, content: message.content.map(block => block.type === 'text' ? { ...block, text: 'Formal: ' + block.text } : block) } as Message
    : message),
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AgentLoopInvariant)
  return ctx
}
function dispatch(ctx: Context, request: GenerateOptions) {
  void ctx.waterfall('llm/stream', markAgentLoopRequest(Object.freeze(request)), () => (async function* () {})())
}

describe('deterministic model input over current RC2 Session', () => {
  it('sends the same Formal projection under the actual Agent scope and preserves tool-result images on the next native request', async () => {
    const ctx = await setup()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt, { personaPrefix: 'recorded identity' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      const scopes: object[] = []
      await ctx.plugin(FixtureProjection, { project: (messages, context) => {
        if (context.scope !== undefined) scopes.push(context.scope)
        return formal.project(messages, context)
      } })
      const adapter = new MockAdapter([toolCallResponse('image-call', 'capture', {}), textResponse('done')])
      ctx.llm.registerAdapter(['mock'], adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'capture', description: 'capture', parameters: {}, execute: async () => [{ type: 'text', text: 'original tool result' }, image] }))
      const agent = await ctx.agentLoop.create(SessionId('formal-rc2'), { provider: 'mock', model: 'm' })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'explicit original authorization' }] }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(2)
      expect(scopes.every(scope => scope === agent)).toBe(true)
      expect(adapter.requests[1]?.messages).toEqual(deriveModelRequestMessages(ctx, agent.session).slice(0, -1))
      expect(adapter.requests[1]?.messages.find(message => message.role === 'tool')).toMatchObject({ role: 'tool', toolCallId: 'image-call', content: [{ type: 'text', text: 'original tool result' }, image] })
      expect(adapter.requests[0]?.messages.find(message => message.role === 'user')?.content).toEqual([{ type: 'text', text: 'explicit original authorization' }])
      const originalSystem = 'You are an AI agent powered by DeepSeek Harness.\n\nrecorded identity'
      expect(adapter.requests[0]?.messages[0]?.content).toEqual([{ type: 'text', text: 'Formal: ' + originalSystem }])
      expect(agent.session.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: originalSystem }])
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps all binary blocks from earlier current snapshots and leaves unrelated producer inputs intact', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId('current-binary'))
      const first = createUserMessage({ source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'obsolete current context' }, image] })
      session.append('user/message', first, { surfaceOp: 'append' })
      const next = createUserMessage({ source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'current context' }] })
      expect(contextSnapshotIntent(session, next)).toEqual({ surfaceOp: 'append' })
      session.append('user/message', next, { surfaceOp: 'append' })
      const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'permission' }] })
      expect(currentContextMessages([first, next, human])).toEqual([{ ...first, content: [image] }, next, human])
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses a projector that changes authorization, source, role, or binary identity', async () => {
    for (const change of ['text', 'source', 'id', 'image'] as const) {
      const ctx = await setup()
      try {
        const session = ctx.sessions.create(SessionId('protected-' + change))
        session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'permission' }, image] }), { surfaceOp: 'append' })
        await ctx.plugin(FixtureProjection, { project: messages => messages.map(message => {
          if (change === 'text') return { ...message, content: [{ type: 'text', text: 'changed permission' }, image] } as Message
          if (change === 'source') return { ...message, source: { kind: 'runtime-context' as const } } as Message
          if (change === 'id') return { ...message, id: 'unlogged-id' } as Message
          return { ...message, content: [{ type: 'text', text: 'permission' }, { ...image, attachment: { ...image.attachment, attachmentId: AttachmentId('different') } }] } as Message
        }) })
        expect(() => deriveModelRequestMessages(ctx, session)).toThrow(/protected message/)
      } finally { await ctx.fiber.dispose() }
    }
  })

  it('freezes projection inputs before a projector can erase protected entries in place', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId('protected-in-place'))
      const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'permission' }] })
      session.append('user/message', input, { surfaceOp: 'append' })
      await ctx.plugin(FixtureProjection, { project: messages => { (messages as Message[]).splice(0, 1); return messages } })
      expect(() => deriveModelRequestMessages(ctx, session)).toThrow(TypeError)
      expect(session.deriveMessages()).toEqual([input])
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects dispatch mutations to users, toolCallId, images, schemas, source, and historical tool definitions after projection', async () => {
    const ctx = await setup()
    try {
      await ctx.plugin(FixtureProjection, formal)
      const session = ctx.sessions.create(SessionId('formal-invariant'))
      session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
      session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('logged') }, { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'authorization' }] }), { surfaceOp: 'append' })
      const callId = ToolCallId('call')
      session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'mock', model: 'm' }, content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] }) }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
      session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [image], isError: false }) }, { surfaceOp: 'append' })
      session.append('developer/message', { turn: 1, step: 1, message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [] }) }, { surfaceOp: 'append' })
      const tools = [{ name: 'read', description: 'original', parameters: { type: 'object', properties: {} } }]
      session.append('request/header', { header: { config: { provider: 'mock', model: 'm' }, tools }, reason: 'initial' })
      const messages = deriveModelRequestMessages(ctx, session)
      Object.freeze(messages)
      const baseline: GenerateOptions = { provider: 'mock', model: 'm', messages, tools, toolHistory: session.toolHistory(), sessionId: session.id }
      expect(() => dispatch(ctx, baseline)).not.toThrow()
      for (const change of ['authorization', 'source', 'toolCallId', 'image', 'schema', 'history'] as const) {
        const candidate = structuredClone(baseline)
        candidate.messages = candidate.messages.map<RequestMessage>((message, index) => {
          if (message.role === 'user' && message.source !== undefined && index === 1) {
            if (change === 'authorization') return { ...message, content: [{ type: 'text', text: 'new unauthorized input' }] }
            if (change === 'source') return { ...message, source: { kind: 'runtime-context' as const } }
          }
          if (message.role === 'tool') {
            if (change === 'toolCallId') return { ...message, toolCallId: ToolCallId('other') }
            if (change === 'image') return { ...message, content: message.content.map(block => block.type === 'image'
              ? { ...block, attachment: { ...block.attachment, bytes: 2 } } : block) }
          }
          return message
        })
        if (change === 'schema') candidate.tools = [{ ...tools[0]!, description: 'changed schema' }]
        if (change === 'history') candidate.toolHistory = { tools: [], updates: [] }
        Object.freeze(candidate.messages)
        expect(() => dispatch(ctx, candidate)).toThrow(/diverges/)
      }
    } finally { await ctx.fiber.dispose() }
  })
})
