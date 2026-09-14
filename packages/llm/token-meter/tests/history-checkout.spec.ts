import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq, foldSurface } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

async function context() {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(TokenMeter)
  return ctx
}
function user(session: Session, text: string) { return session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' }) }

describe('canonical history checkout pricing', () => {
  it('rebuilds hot, cold and persisted-checkpoint meter surfaces without resetting cumulative log facts', async () => {
    const ctx = await context(), cold = await context()
    try {
      const session = ctx.sessions.create(SessionId('meter-checkout'))
      session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
      const system = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system v1', 'fixture') }, { surfaceOp: 'append' })
      const a = user(session, '用户 A 中文内容')
      session.append('request/header', { header: { config: { provider: 'fixture', model: 'first' } }, reason: 'initial' })
      session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const first = SessionSeq(session.seq - 1)
      session.append('turn/start', { turn: 2 }); session.append('step/start', { turn: 2, step: 1 })
      session.append('system/message', { turn: 2, step: 1, message: createSystemMessage('system v2', 'fixture') }, { surfaceOp: { op: 'replace', startSeq: system.seq, endSeq: system.seq }, sourceEventSeqs: [system.seq] })
      const beforeSecondUser = SessionSeq(session.seq - 1)
      user(session, '用户 B 应在undo后隐藏')
      session.append('request/header', { header: { config: { provider: 'fixture', model: 'latest' }, tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }] }, reason: 'change' })
      session.append('step/end', { turn: 2, step: 1 }); session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      const redo = SessionSeq(session.seq - 1), before = ctx.tokenMeter.measure(session)
      const checkpoint = ctx.sessionProjections.checkpoint(session)
      session.checkout(first)
      const live = ctx.tokenMeter.measure(session), snapshot = ctx.sessionProjections.snapshot(session)
      expect(live.nodes.map(node => node.seq)).toEqual([system.seq, a.seq])
      expect(live.surfaceTokens).toBeLessThan(before.surfaceTokens)
      expect(session.requestHeader()?.config.model).toBe('latest')
      const restored = Session.fromRestore(session.id, session.snapshotEvents(), session.header, SessionLogOffset(0), 'shared-frozen')
      expect(cold.tokenMeter.measure(restored)).toEqual({ ...live, logRevision: restored.seq })
      expect(cold.sessionProjections.snapshot(restored).values).toEqual(snapshot.values)
      const tail = session.snapshotEvents(SessionLogOffset(redo))
      expect(() => ctx.sessionProjections.restore(checkpoint, tail, SessionLogOffset(redo), session.header, SessionLogOffset(0))).toThrow(/re-read from seq 0/)
      const replay = ctx.sessionProjections.restore(checkpoint, session.snapshotEvents(), SessionLogOffset(0), session.header, SessionLogOffset(0))
      expect(replay.snapshot.values).toEqual(snapshot.values)
      session.checkout(redo)
      expect(ctx.tokenMeter.measure(session)).toEqual({ ...before, logRevision: session.seq })
      session.checkout(beforeSecondUser)
      expect(ctx.tokenMeter.measure(session).nodes.map(node => node.seq)).toEqual(foldSurface(session.snapshotEvents()).nodes)
      expect(ctx.sessionProjections.snapshot(session).values.contextBreakdown).toEqual(cold.sessionProjections.restore({}, session.snapshotEvents(), SessionLogOffset(0), session.header, SessionLogOffset(0)).snapshot.values.contextBreakdown)
    } finally { await cold.fiber.dispose(); await ctx.fiber.dispose() }
  })
})
