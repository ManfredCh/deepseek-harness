import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset, selectActiveHistoryEvents, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry, { type ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { 'fixture/history-prefix': number[] }
}
const user = (session: Session, text: string) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
const unit = (seen: (readonly SessionEvent[])[] = []): ProjectionDefinition<'fixture/history-prefix', number[]> => ({
  key: 'fixture/history-prefix', stateSchema: z.array(z.number()), stateVersion: 1, init: () => [],
  apply(state, event, history) {
    if (event.type !== 'session/history-checkout') {
      expect(history).toBeUndefined()
      return event.type === 'user/message' ? [...state, event.seq] : state
    }
    expect(history?.at(-1)).toBe(event)
    expect(history?.map(value => value.seq)).toEqual(Array.from({ length: event.seq + 1 }, (_, seq) => seq))
    expect(Object.isFrozen(history)).toBe(true)
    expect(Object.isFrozen(history?.[0])).toBe(true)
    seen.push(history!)
    return selectActiveHistoryEvents(history!).filter(value => value.type === 'user/message').map(value => value.seq)
  },
})

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

describe('checkout projection requires the complete immutable durable prefix', () => {
  it('supplies the same complete prefix for committed drive, late full build, and lazy advance', async () => {
    const ctx = await setup()
    try {
      const seen: (readonly SessionEvent[])[] = []
      ctx.sessionProjections.register(unit(seen))
      const live = ctx.sessions.create(SessionId('projection-live'))
      const a = user(live, 'A'); user(live, 'B'); const operation = live.checkout(a.seq)
      expect(ctx.sessionProjections.stateOf(live, 'fixture/history-prefix')).toEqual([a.seq])
      expect(seen[0]).toEqual(live.snapshotEvents())
      expect(seen[0]?.at(-1)).toBe(operation)
      const manual = Session.create(SessionId('projection-manual'))
      const first = user(manual, 'A')
      expect(ctx.sessionProjections.stateOf(manual, 'fixture/history-prefix')).toEqual([first.seq])
      user(manual, 'B'); manual.checkout(first.seq)
      expect(ctx.sessionProjections.stateOf(manual, 'fixture/history-prefix')).toEqual([first.seq])
      const late = Session.create(SessionId('projection-late'))
      const before = user(late, 'A'); user(late, 'B'); late.checkout(before.seq)
      expect(ctx.sessionProjections.stateOf(late, 'fixture/history-prefix')).toEqual([before.seq])
      expect(seen).toHaveLength(3)
    } finally { await ctx.fiber.dispose() }
  })

  it('rebuilds a full-prefix checkpoint and hydration while refusing a detached tail containing checkout', async () => {
    const ctx = await setup()
    try {
      const seen: (readonly SessionEvent[])[] = []
      ctx.sessionProjections.register(unit(seen))
      const session = Session.create(SessionId('projection-cold'))
      const a = user(session, 'A'), b = user(session, 'B')
      const checkpoint = { 'fixture/history-prefix': { ver: 1, seq: b.seq, val: [a.seq, b.seq] } }
      session.checkout(a.seq)
      const events = session.snapshotEvents()
      const restored = ctx.sessionProjections.restore(checkpoint, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
      expect(restored.checkpoint['fixture/history-prefix']?.val).toEqual([a.seq])
      expect(() => ctx.sessionProjections.restore(checkpoint, events.slice(2), SessionLogOffset(2), session.header, session.inheritedEventCount)).toThrow(/complete prefix/)
      ctx.sessionProjections.hydrate(session, checkpoint, events, SessionLogOffset(0))
      expect(ctx.sessionProjections.stateOf(session, 'fixture/history-prefix')).toEqual([a.seq])
      expect(seen).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })
})
