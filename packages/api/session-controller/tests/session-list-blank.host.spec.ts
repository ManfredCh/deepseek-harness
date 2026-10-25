/**
 * The summary blank bit means "conversation not started" (no turn has run),
 * not "log empty": standalone plugin events — command lifecycle records,
 * plan/mode, permission knob events, session titles — never flip it, so running /plan or /goal on a
 * fresh session keeps it list-hidden and reusable, while the first accepted
 * prompt's turn/start clears it. The host/session-added frame shares the
 * same predicate function (covered by the workspace spec's frame assertion).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import Commands from '@deepseek-ai/dsh-commands'
import { applySessionListMetadata } from '../src/list.ts'
// Side-effect type imports: the configuration-event SessionEventMap merges.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

async function harness(): Promise<{ ctx: Context; remote: TestSessionRemote; attach: (session: Session) => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return {
    ctx,
    remote: createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
    attach: async (session) => {
      await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    },
  }
}

/** Append the standalone (non-conversation) event family a fresh session can accumulate. */
function appendStandalone(session: Session): void {
  session.append('command/run', {
    commandId: CommandId('blank-cmd-1'), name: 'plan', args: '', source: { kind: 'user' },
  })
  session.append('plan/mode', { active: true })
  session.append('command/done', { commandId: CommandId('blank-cmd-1'), kind: 'success', text: 'Plan mode on.' })
  session.append('session/title', {
    title: 'standalone title', messageSeqs: [], source: { kind: 'fallback' },
  })
  // Permission configuration events from a /permission switch on a fresh session.
  session.append('permission/preset', { preset: 'danger-full-access' })
  session.append('sandbox/mode', { mode: 'danger-full-access' })
}

async function listBlank(remote: TestSessionRemote, id: string): Promise<boolean | undefined> {
  const result = await remote.list({})
  if (!result.ok) throw new Error('list failed')
  return result.value.items.find(item => item.sessionId === id)?.blank
}

describe('summary blank = conversation not started', () => {
  it('standalone events (command lifecycle, plan/mode, title) keep the session blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    expect(await listBlank(remote, session.id)).toBe(true)
    appendStandalone(session)
    expect(await listBlank(remote, session.id)).toBe(true)
  })

  it('the first turn clears blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    appendStandalone(session)
    session.append('turn/start', { turn: 0 })
    expect(await listBlank(remote, session.id)).toBe(false)
  })
})


describe('declared successful persistent user work is not a provisional Session', () => {
  it('uses the native command producer and current projection without adding a turn or prompt time', async () => {
    const { ctx, remote, attach } = await harness()
    await ctx.plugin(Commands)
    const session = ctx.sessions.create(), agent = { id: session.id, session, status: 'idle', ctx } as Agent
    await attach(session)
    ctx.commands.register({ name: 'save', description: 'Persist user work', retainsSession: true, handler: () => ({ kind: 'success', text: 'Saved' }) })
    expect(await listBlank(remote, session.id)).toBe(true)
    const execution = await ctx.commands.execute(agent, '/save', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect(await listBlank(remote, session.id)).toBe(false)
    const events = session.snapshotEvents()
    expect(events.some(event => event.type === 'turn/start' || event.type === 'user/message')).toBe(false)
    const persisted = JSON.parse(JSON.stringify(events)) as typeof events
    const folded = persisted.reduce(applySessionListMetadata, { blank: true, lastPromptAt: null })
    expect(folded).toEqual({ blank: false, lastPromptAt: null })
    await ctx.fiber.dispose()
  })
  it('old unmarked configuration history remains blank and a failed marked outcome cannot retain it', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    appendStandalone(session)
    session.append('command/done', { commandId: CommandId('invalid-success-marker'), kind: 'error', retainsSession: true, text: 'Failed' })
    expect(await listBlank(remote, session.id)).toBe(true)
    const state = session.snapshotEvents().reduce(applySessionListMetadata, { blank: true, lastPromptAt: null })
    expect(state).toEqual({ blank: true, lastPromptAt: null })
    await ctx.fiber.dispose()
  })
})
