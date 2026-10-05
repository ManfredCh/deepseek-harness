import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { assertProductHistoryEvent, remapProductHistoryReferences, restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { RELEASED_V3_EVENT_TYPES } from '../src/index.ts'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const header = { type: 'session', version: 3, id: 'alpha4-product-fixture', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const image = { type: 'image', attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
const user = (id: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
const row = (type: string, data: SessionFormatJsonObject, surface = false, ignorable = false) => ({ type, data, ...(surface ? { surfaceOp: 'append' } : {}), ...(ignorable ? { ignorable: true } : {}) })
const assistant = (turn: number, callId: string) => row('assistant/message', { turn, step: 1, stream: [], message: { id: 'assistant-' + callId, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] } }, true)
const call = (turn: number, callId: string) => row('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
const result = (turn: number, callId: string) => row('tool/result', { turn, step: 1, message: { id: 'tool-result-' + callId, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'original result' }, image] }] } }, true)
const observation = (turn: number, callId: string, callSeq: number, registryId: string) => row('lyapunov/tool-observation', { callId, rootCallId: callId, name: 'read', turn, step: 1, argumentsHash: 'fixture-hash', target: {}, facts: {}, diagnostic: { code: 'OUTCOME_UNKNOWN', effect: 'unknown' }, images: ['fixture-image'], job: { jobId: 'bash-1', registryId, hostInstanceId: null, startedAt: turn, callId, callSeq, seq: callSeq, status: 'running' }, isError: false, late: false, waited: false }, false, true)
function fixture(): SessionFormatEvent[] {
  const snapshot = { version: 1, worktree: 'fixture-worktree', tree: 'fixture-tree' }
  const rows = [
    row('turn/start', { turn: 1 }), row('step/start', { turn: 1, step: 1 }),
    row('system/message', { turn: 1, step: 1, message: { id: 'system', role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [{ type: 'text', text: 'formal fixture' }] } }, true),
    row('user/message', user('original authorization'), true), assistant(1, 'call-a'), call(1, 'call-a'), result(1, 'call-a'), observation(1, 'call-a', 5, 'registry-a'),
    row('step/end', { turn: 1, step: 1 }), row('agent/inbox/spliced', { target: 'next-turn', inserted: [user('next')] }),
    row('turn/start', { turn: 2 }), row('step/start', { turn: 2, step: 1 }), row('user/message', user('next authorization'), true),
    assistant(2, 'call-b'), call(2, 'call-b'), result(2, 'call-b'), observation(2, 'call-b', 14, 'registry-b'),
    row('step/end', { turn: 2, step: 1 }), row('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    row('worktree/checkpoint', { version: 1, phase: 'before', turn: 2, step: 1, snapshot, messageIds: ['next authorization'] }, false, true),
    row('worktree/checkpoint', { version: 1, phase: 'after', turn: 2, step: 1, snapshot, messageIds: ['next authorization'], beforeSeq: 19, paths: ['fixture.txt'] }, false, true),
    row('worktree/history-operation', { version: 1, operationId: 'undo-id', action: 'undo', throughSeq: 6, restoreUserSeq: 12, nextRedo: [{ throughSeq: 18, userSeq: 12, snapshot, paths: ['fixture.txt'] }], files: { mode: 'git', paths: ['fixture.txt'] } }, false, true),
    row('session/history-checkout', { throughSeq: 6, operationId: 'undo-id' }),
    row('worktree/history-operation', { version: 1, operationId: 'redo-id', action: 'redo', throughSeq: 21, restoreUserSeq: null, nextRedo: [], files: { mode: 'git', paths: ['fixture.txt'] } }, false, true),
    row('session/history-checkout', { throughSeq: 21, operationId: 'redo-id' }),
    row('worktree/capture', { version: 1, phase: 'ready', full: true, files: 1, hashed: 1, bytesRead: 4, elapsedMs: 1 }, false, true),
    row('lyapunov/service-diagnostic', { callId: 'call-b', intentKey: 'fixture-intent', code: 'RECONCILIATION_REQUIRED', diagnostic: { effect: 'unknown' }, outcome: 'error' }, false, true),
    row('lyapunov/request-diagnostics', { turn: 2, step: 1, provider: 'mock', model: 'mock', messageCount: 5, imageCount: 1, toolCount: 1, toolsBytes: 2, toolsHash: 'hash', contexts: [], basis: 'harness-before-adapter' }, false, true),
    row('lyapunov/recovery-handoff', { turn: 2, step: 1, code: 'OUTCOME_UNKNOWN', stagnant: 1, waiting: true }, false, true),
    row('lyapunov/unrecognized', { seq: 12 }, false, true),
  ]
  return rows.map((value, seq) => ({ ...value, seq, time: seq + 1 }) as SessionFormatEvent)
}
function restore(events: readonly SessionFormatEvent[]) {
  const reader = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const event of events) reader.decodeRow(event)
  return reader.finish()
}

describe('Alpha4 product history migration into RC2 V4', () => {
  it('read-open leaves V3 unchanged and write-open publishes only a V4 successor with identical product facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alpha4-product-history-'))
    const ctx = new Context(), id = SessionId(header.id)
    try {
      const source = join(root, '_no-cwd', header.id, 'session.v3.jsonl')
      const successor = join(root, '_no-cwd', header.id, 'session.v4.jsonl')
      const bytes = Buffer.from([header, ...fixture()].map(value => JSON.stringify(value)).join('\n') + '\n')
      await mkdir(dirname(source), { recursive: true }); await writeFile(source, bytes)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const read = await ctx.sessionPersistence.open(id, 'read')
      let expected: readonly SessionEvent[]
      try { expected = (await read.read()).events; expect(read.header.version).toBe(4) } finally { await read.close() }
      expect(await readFile(source)).toEqual(bytes)
      expect(await readdir(dirname(source))).toEqual(['session.v3.jsonl'])
      const write = await ctx.sessionPersistence.open(id, 'write')
      try { expect((await write.read()).events).toEqual(expected!) } finally { await write.close() }
      expect(await readFile(source)).toEqual(bytes)
      expect((await readdir(dirname(source))).filter(name => name !== 'session.lock').sort()).toEqual(['session.v3.jsonl', 'session.v4.jsonl'])
      expect((await readFile(successor, 'utf8')).split('\n').filter(Boolean).map(value => JSON.parse(value)).slice(1)).toEqual(expected!)
      const reopened = await ctx.sessionPersistence.open(id, 'read')
      try { expect((await reopened.read()).events).toEqual(expected!) } finally { await reopened.close() }
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('a required unknown product event refuses read/write without publishing V4 or changing source bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alpha4-product-refusal-'))
    const ctx = new Context(), id = SessionId(header.id)
    try {
      const source = join(root, '_no-cwd', header.id, 'session.v3.jsonl')
      const rows = [...fixture(), { type: 'lyapunov/not-listed', seq: 30, time: 31, data: {} }]
      const bytes = Buffer.from([header, ...rows].map(value => JSON.stringify(value)).join('\n') + '\n')
      await mkdir(dirname(source), { recursive: true }); await writeFile(source, bytes)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      for (const mode of ['read', 'write'] as const) {
        await expect(ctx.sessionPersistence.open(id, mode)).rejects.toThrow(/unknown event type.*lyapunov\/not-listed/)
        expect(await readFile(source)).toEqual(bytes)
        expect((await readdir(dirname(source))).filter(name => name !== 'session.lock')).toEqual(['session.v3.jsonl'])
      }
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('preserves explicit namespaces, images, authorization, Job identities and undo/redo through inserted interrupted-turn positions', () => {
    const source = fixture(), original = structuredClone(source)
    const artifact = restore(source)
    expect(RELEASED_V3_EVENT_TYPES.has('session/history-checkout')).toBe(false)
    expect(RELEASED_V3_EVENT_TYPES.has('lyapunov/tool-observation')).toBe(false)
    expect(artifact.events[10]).toMatchObject({ type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })
    expect(artifact.events[17]).toMatchObject({ type: 'lyapunov/tool-observation', data: { diagnostic: { effect: 'unknown' }, job: { registryId: 'registry-b', startedAt: 2, callSeq: 15, seq: 15 } } })
    expect(artifact.events[21]).toMatchObject({ type: 'worktree/checkpoint', data: { beforeSeq: 20 } })
    expect(artifact.events[22]).toMatchObject({ type: 'worktree/history-operation', data: { throughSeq: 6, restoreUserSeq: 13, nextRedo: [{ throughSeq: 19, userSeq: 13 }] } })
    expect(artifact.events[23]).toMatchObject({ type: 'session/history-checkout', data: { throughSeq: 6, operationId: 'undo-id' } })
    expect(artifact.events[25]).toMatchObject({ type: 'session/history-checkout', data: { throughSeq: 22, operationId: 'redo-id' } })
    expect(artifact.events.at(-1)).toMatchObject({ type: 'plugin:lyapunov/unrecognized', data: { seq: 12 }, ignorable: true })
    const tool = artifact.events[16]!.data as SessionFormatJsonObject
    expect(tool['message']).toMatchObject({ id: 'tool-result-call-b', role: 'tool', toolCallId: 'call-b', content: [{ type: 'text', text: 'original result' }, image] })
    const { id: restoredId, parentSession, ...metadata } = artifact.header
    const nativeHeader: SessionHeader = {
      ...metadata, version: 4, id: SessionId(restoredId),
      ...parentSession === undefined ? {} : { parentSession: SessionId(parentSession) },
    }
    const native = Session.fromRestore(nativeHeader.id, artifact.events as SessionEvent[], nativeHeader, SessionLogOffset(0), 'detached')
    expect(native.deriveMessages().filter(message => message.role === 'user').map(message => message.content)).toContainEqual(user('original authorization').content)
    expect(native.deriveMessages().filter(message => message.role === 'tool')).toHaveLength(2)
    const reopen = sessionFormatCatalog.createRestore({ ...header, version: 4 }, { recovery: 'strict', validation: 'current' })
    for (const event of artifact.events) reopen.decodeRow(event)
    expect(reopen.finish()).toEqual(artifact)
    expect(source).toEqual(original)
  })

  it('still refuses unrecognized required product-prefix events and a frozen V3 reader cannot consume V4 tool-role syntax', () => {
    const unknown = [...fixture(), { ...row('worktree/not-listed', {}), seq: 30, time: 31 }] as SessionFormatEvent[]
    expect(() => restore(unknown)).toThrow(/unknown event type.*worktree\/not-listed/)
    const target = restore(fixture())
    expect(() => restoreReleasedV3Artifact(
      { ...target, header: { ...target.header, version: 3 } }, new Set(RELEASED_V3_EVENT_TYPES),
    )).toThrow()
  })

  it.each([
    ['session/history-checkout', { throughSeq: 10, operationId: '' }, undefined],
    ['session/history-checkout', { throughSeq: -1 }, true],
    ['worktree/checkpoint', { version: 1, phase: 'after', turn: 1, step: 1, snapshot: null, messageIds: [], beforeSeq: 40 }, true],
    ['worktree/history-operation', { version: 1, operationId: 'invalid', action: 'undo', throughSeq: 1, restoreUserSeq: 40, nextRedo: [], files: { mode: 'disabled', paths: [] } }, true],
    ['lyapunov/tool-observation', { ...(fixture()[16]!.data as SessionFormatJsonObject), job: { jobId: 'bash-1', registryId: 'r', hostInstanceId: null, startedAt: 1, callId: 'c', callSeq: 40, seq: 40, status: 'running' } }, true],
  ])('rejects malformed %s before a recoverable tail can hide it', (type, data, ignorable) => {
    const event = { type, seq: 31, time: 32, data, ...(ignorable ? { ignorable: true } : {}) } as SessionFormatEvent
    expect(() => assertProductHistoryEvent(event)).toThrow()
    const reader = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'recoverable', validation: 'current' })
    for (const good of fixture()) reader.decodeRow(good)
    expect(() => reader.decodeRow(event)).toThrow()
  })

  it('remaps -1 and null cursors without guessing missing earlier references', () => {
    const source = { type: 'worktree/history-operation', seq: 3, time: 1, ignorable: true, data: { version: 1, operationId: 'empty', action: 'undo', throughSeq: -1, restoreUserSeq: null, nextRedo: [{ throughSeq: -1, userSeq: 1, snapshot: null, paths: [] }], files: { mode: 'disabled', paths: [] } } } as SessionFormatEvent
    expect(remapProductHistoryReferences(source, 4, [0, 2, 3]).data).toMatchObject({
      throughSeq: -1, restoreUserSeq: null, nextRedo: [{ throughSeq: -1, userSeq: 2 }],
    })
    expect(() => remapProductHistoryReferences(source, 4, [0])).toThrow(/missing from the source prefix/)
  })
})
