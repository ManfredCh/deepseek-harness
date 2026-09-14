import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset, SessionSeq, foldSurface, isAppendSurfaceEvent, selectActiveHistoryEvents } from '@deepseek-ai/dsh-session'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session'
import { createMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'fixture/worktree': { snapshot: string } } }

function user(session: Session, text: string) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
function text(session: Session) { return session.deriveMessages().flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []) }
function turn(session: Session, n: number, value: string) {
  session.append('turn/start', { turn: n }); const message = user(session, value)
  const end = session.append('turn/end', { turn: n, reason: { kind: 'completed' } })
  return { message, end }
}

describe('required reversible history checkout', () => {
  it('restores canonical replacement state and original human history across undo, redo and a new branch', () => {
    const session = Session.create(SessionId('checkout'))
    const a = turn(session, 1, 'A'), b = turn(session, 2, 'B')
    const summary = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'AB summary' }], source: { kind: 'plugin', plugin: 'fixture' } }), { surfaceOp: { op: 'replace', startSeq: a.message.seq, endSeq: b.message.seq }, sourceEventSeqs: [a.message.seq, b.message.seq] })
    const original = session.snapshotEvents(), generation = session.surface.replaceGeneration
    expect(text(session)).toEqual(['AB summary'])
    const checkout = session.checkout(a.end.seq, { operationId: 'files-transaction-1' })
    expect(checkout.data).toEqual({ throughSeq: a.end.seq, operationId: 'files-transaction-1' })
    expect(checkout.ignorable).toBeUndefined(); expect(checkout.surfaceOp).toBeUndefined()
    expect(text(session)).toEqual(['A']); expect(session.surface.replaceGeneration).toBe(generation + 1)
    expect(session.snapshotEvents(SessionLogOffset(0), SessionLogOffset(original.length))).toEqual(original)
    session.checkout(summary.seq)
    expect(text(session)).toEqual(['AB summary'])
    expect(selectActiveHistoryEvents(session.snapshotEvents()).filter(isAppendSurfaceEvent).map(event => event.seq)).toEqual([a.message.seq, b.message.seq])
    session.checkout(a.end.seq); const c = turn(session, 3, 'C')
    expect(text(session)).toEqual(['A', 'C'])
    expect(selectActiveHistoryEvents(session.snapshotEvents()).filter(isAppendSurfaceEvent).map(event => event.seq)).toEqual([a.message.seq, c.message.seq])
    expect(foldSurface(session.snapshotEvents()).nodes).toEqual(session.surface.nodes)
    const restored = Session.fromRestore(session.id, session.snapshotEvents(), session.header, SessionLogOffset(0), 'shared-frozen')
    expect(text(restored)).toEqual(text(session)); expect(restored.surface.nodes).toEqual(session.surface.nodes)
  })

  it('targets an earlier user boundary inside the same turn and step while requiring the writer to be idle', () => {
    const session = Session.create(SessionId('steer'))
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    const system = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system', 'fixture') }, { surfaceOp: 'append' })
    const first = user(session, 'earlier user'); const target = SessionSeq(session.seq - 1)
    user(session, 'later user')
    const before = session.snapshotEvents()
    expect(() => session.checkout(target)).toThrow(/stable boundary/)
    expect(session.snapshotEvents()).toEqual(before)
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.checkout(target)
    expect(session.surface.nodes).toEqual([system.seq, first.seq]); expect(text(session)).toEqual(['system', 'earlier user'])
  })

  it('rejects incomplete tool exchanges and accepts the same prefix after its original tool result', () => {
    const session = Session.create(SessionId('tools'))
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    const callId = ToolCallId('checkout-tool')
    const assistant = session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] }) }, { surfaceOp: 'append' })
    const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'original result' }], isError: false }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => session.checkout(assistant.seq)).toThrow(/unmatched tool calls/)
    session.checkout(result.seq)
    expect(session.surface.nodes).toEqual([assistant.seq, result.seq])
  })

  it('never downgrades checkout to ignorable and retains external informational metadata', () => {
    const session = Session.create(SessionId('external'))
    const info = session.append('fixture/worktree', { snapshot: 'owner-reference' }, { ignorable: true })
    expect(info.ignorable).toBe(true)
    expect(() => session.append('session/history-checkout', { throughSeq: -1 }, { ignorable: true })).toThrow(/informational/)
    const checkout = session.checkout(info.seq)
    expect(selectActiveHistoryEvents(session.snapshotEvents()).map(event => event.seq)).toEqual([info.seq, checkout.seq])
    for (const value of [-2, NaN, Infinity, -0, session.seq, 0.5]) expect(() => session.checkout(value as SessionSeqCursor)).toThrow()
    expect(() => session.checkout(-1, { operationId: '' })).toThrow(/operationId/)
    session.checkout(-1); expect(session.surface.nodes).toEqual([])
  })

  it('selects a partial durable window by absolute seq and rejects gaps or fractional UI positions', () => {
    const event = (seq: number, type = 'fixture', data: unknown = {}) => ({ type, seq, data })
    const window = [event(20), event(21), event(22, 'session/history-checkout', { throughSeq: 5 }), event(23)]
    expect(selectActiveHistoryEvents(window).map(event => event.seq)).toEqual([22, 23])
    expect(selectActiveHistoryEvents([...window, event(24, 'session/history-checkout', { throughSeq: 21 })]).map(event => event.seq)).toEqual([20, 21, 24])
    expect(() => selectActiveHistoryEvents([event(20), event(22)])).toThrow(/contiguous/)
    expect(() => selectActiveHistoryEvents([event(20.5)])).toThrow(/durable/)
  })

  it('keeps the derived cache canonical when a first system head follows already observed queued history', () => {
    const session = Session.create(SessionId('late-head-cache'))
    user(session, 'queued'); expect(text(session)).toEqual(['queued'])
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('late head', 'fixture') }, { surfaceOp: 'append' })
    expect(text(session)).toEqual(['late head', 'queued'])
    session.checkout(-1); expect(text(session)).toEqual([])
    user(session, 'new queued'); expect(text(session)).toEqual(['new queued'])
    session.append('system/message', { turn: 2, step: 1, message: createSystemMessage('new head', 'fixture') }, { surfaceOp: 'append' })
    expect(text(session)).toEqual(['new head', 'new queued'])
  })
})
