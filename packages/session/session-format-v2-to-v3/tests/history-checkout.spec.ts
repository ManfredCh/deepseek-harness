import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec, restoreReleasedV3Artifact } from '../src/index.ts'

function fixture() {
  const id = SessionId('codec-checkout')
  const session = Session.create(id, undefined, { version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('head', 'fixture') }, { surfaceOp: 'append' })
  const user = (text: string) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  const first = user('first'), target = first.seq
  user('second')
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.checkout(target, { operationId: 'filesystem-atomic-link' })
  const artifact = { header: session.header, events: session.snapshotEvents(), inheritedEventCount: 0 } as unknown as SessionFormatArtifact
  return { session, artifact }
}

describe('native V3 required history checkout', () => {
  it('preserves operationId and original events across strict codec and current relationship validation', () => {
    const { artifact } = fixture()
    const header = releasedV3SessionFormatCodec.encodeHeader(artifact.header, 0)
    const decoder = releasedV3SessionFormatCodec.createDecoder(header, 'strict'), collected = new SessionFormatEventCollector()
    for (const event of artifact.events) decoder.decodeRow(releasedV3SessionFormatCodec.encodeEvent(event), collected)
    decoder.finish(collected)
    expect(collected.values).toEqual(artifact.events)
    expect(restoreReleasedV3Artifact({ ...artifact, events: collected.values }, KNOWN_SESSION_EVENT_TYPES)).toEqual(artifact)
  })

  it('refuses the required event when the reader vocabulary predates checkout', () => {
    const { artifact } = fixture(), old = new Set(KNOWN_SESSION_EVENT_TYPES)
    old.delete('session/history-checkout')
    expect(() => restoreReleasedV3Artifact(artifact, old)).toThrow(/unknown event type.*session\/history-checkout/)
  })

  it.each([
    { ignorable: true },
    { surfaceOp: 'append' },
    { data: { throughSeq: -2 } },
    { data: { throughSeq: 1000 } },
    { data: { throughSeq: 3, operationId: '' } },
    { data: { throughSeq: 3, unexpected: true } },
  ])('never discards malformed checkout as a recoverable tail: %j', override => {
    const { artifact } = fixture(), good = artifact.events.at(-1)!
    const bad = { ...good, ...override } as SessionFormatEvent
    const decoder = releasedV3SessionFormatCodec.createDecoder(releasedV3SessionFormatCodec.encodeHeader(artifact.header, 0), 'recoverable')
    const collected = new SessionFormatEventCollector()
    for (const event of artifact.events.slice(0, -1)) decoder.decodeRow(event, collected)
    expect(() => decoder.decodeRow(bad, collected)).toThrow()
    expect(() => releasedV3SessionFormatCodec.encodeEvent(bad)).toThrow()
  })

  it('rejects a checkout appended inside an active raw turn even when its target surface is safe', () => {
    const { session, artifact } = fixture()
    const events = [...artifact.events, { type: 'turn/start', seq: session.seq, time: 1, data: { turn: 2 } }, { type: 'session/history-checkout', seq: SessionSeq(session.seq + 1), time: 1, data: { throughSeq: 3 } }] as SessionFormatEvent[]
    expect(() => restoreReleasedV3Artifact({ ...artifact, events }, KNOWN_SESSION_EVENT_TYPES)).toThrow(/stable boundary/)
  })
})
