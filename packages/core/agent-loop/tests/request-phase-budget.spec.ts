import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

class BudgetAdapter extends MockAdapter {
  override providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', requestPhaseTimeoutMs: 30 }, 'fixture.retryPolicy') }
}
async function harness(adapter: BudgetAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'fixture' }); await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('phase-fixture'), { provider: 'mock', model: 'm' })
  const send = () => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'original authorization' }] }))
  return { ctx, agent, send }
}

describe('model request phase deadline preserves native turn and tool cancellation', () => {
  it('times out request preparation before committing prompt or user input', async () => {
    const { ctx, agent, send } = await harness(new BudgetAdapter([textResponse('unused')]))
    try {
      ctx.on('agent/request', async (_request, next) => { await next(); return new Promise<never>(() => {}) })
      send(); await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      expect(events.some(event => event.type === 'system/message' || event.type === 'user/message')).toBe(false)
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'REQUEST_PHASE_TIMEOUT' } } } })
    } finally { await ctx.fiber.dispose() }
  })

  it('settles a started timed-out stream as a durable attempt, retaining original admitted authorization', async () => {
    const { ctx, agent, send } = await harness(new BudgetAdapter(['hang']))
    try {
      send(); await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      expect(events.find(event => event.type === 'user/message')?.data.content).toEqual([{ type: 'text', text: 'original authorization' }])
      expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'REQUEST_PHASE_TIMEOUT' } } } })
      expect(events.some(event => event.type === 'tool/call')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('disposes the phase deadline before native tools run and keeps their original turn signal live', async () => {
    const { ctx, agent, send } = await harness(new BudgetAdapter([toolCallResponse('tool', 'wait-fixture', {}), textResponse('done')]))
    try {
      let start!: () => void, finish!: () => void
      const started = new Promise<void>(resolve => { start = resolve }), done = new Promise<void>(resolve => { finish = resolve })
      let toolSignal: AbortSignal | undefined
      ctx.tools.register(defineContentToolFixture({ name: 'wait-fixture', description: 'fixture', parameters: {}, execute: async (_args, execution) => {
        toolSignal = execution.signal; start(); await done; return [{ type: 'text', text: 'original result' }]
      } }))
      send(); await started
      await new Promise(resolve => setTimeout(resolve, 70))
      expect(toolSignal?.aborted).toBe(false)
      finish(); await agent.whenIdle()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally { await ctx.fiber.dispose() }
  })

  it('retains explicit user cancellation as aborted instead of a request timeout', async () => {
    const adapter = new BudgetAdapter(['hang'])
    const { ctx, agent, send } = await harness(adapter)
    try {
      send()
      while (adapter.requests.length === 0) await new Promise(resolve => setImmediate(resolve))
      agent.cancel({ kind: 'user' }); await agent.whenIdle()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    } finally { await ctx.fiber.dispose() }
  })
})
