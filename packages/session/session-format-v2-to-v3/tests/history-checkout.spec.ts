import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec, restoreReleasedV3Artifact } from '../src/index.ts'

function fixture() {
  const user = (id: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
  const rows = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', data: { turn: 1, step: 1, message: { id: 'head', role: 'system', source: { kind: 'plugin', plugin: 'fixture' }, content: [{ type: 'text', text: 'head' }] } }, surfaceOp: 'append' },
    { type: 'user/message', data: user('first'), surfaceOp: 'append' },
    { type: 'user/message', data: user('second'), surfaceOp: 'append' },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/history-checkout', data: { throughSeq: 3, operationId: 'filesystem-atomic-link' } },
  ]
  const artifact: SessionFormatArtifact = {
    header: { version: 3, id: 'codec-checkout', createdAt: 1, isSeeded: false, delegationDepth: 0 },
    events: rows.map((event, seq) => ({ ...event, seq, time: seq + 1 }) as SessionFormatEvent), inheritedEventCount: 0,
  }
  return { artifact }
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
    const { artifact } = fixture(), seq = artifact.events.length
    const events = [...artifact.events, { type: 'turn/start', seq, time: 1, data: { turn: 2 } }, { type: 'session/history-checkout', seq: seq + 1, time: 1, data: { throughSeq: 3 } }] as SessionFormatEvent[]
    expect(() => restoreReleasedV3Artifact({ ...artifact, events }, KNOWN_SESSION_EVENT_TYPES)).toThrow(/stable boundary/)
  })
})
