import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionSeq, SessionLogOffset, foldSurface, selectActiveHistoryEvents } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const source = process.argv[2], output = process.argv[3]
await mkdir(output, { recursive: true })
const originalBytes = await readFile(source), original = JSON.parse(originalBytes)
const artifact = original.events ? original : original.artifact
assert(artifact?.events?.length, '需要现成真实Session artifact')
const open = artifact => Session.fromRestore(SessionId(artifact.header.id), structuredClone(artifact.events), structuredClone(artifact.header), SessionLogOffset(artifact.inheritedEventCount ?? 0), 'detached')
const session = open(artifact), before = session.snapshotEvents(), beforeSurface = [...session.surface.nodes]
const users = before.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
assert(users.length > 1)
const targetUser = users.at(-1), throughSeq = targetUser.seq === 0 ? -1 : SessionSeq(targetUser.seq - 1)
const expected = foldSurface(before.slice(0, throughSeq + 1)).nodes
const ctx = new Context(), coldCtx = new Context()
for (const owner of [ctx, coldCtx]) { await owner.plugin(SessionProjectionRegistry); await owner.plugin(TokenMeter) }
const encoded = current => {
  const header = sessionFormatCatalog.encodeCurrentHeader(current.header, current.inheritedEventCount)
  const rows = current.snapshotEvents().map(event => sessionFormatCatalog.encodeCurrentEvent(event))
  const decoder = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const row of rows) decoder.decodeRow(row)
  const restored = decoder.finish()
  assert.deepEqual(restored.events, current.snapshotEvents())
  return { header, rows, restored }
}
try {
  const informational = open(artifact)
  informational.append('fixture/worktree-checkpoint', { snapshot: 'external-owner-reference' }, { ignorable: true })
  const info = encoded(informational)
  await writeFile(join(output, 'informational.jsonl'), [info.header, ...info.rows].map(row => JSON.stringify(row)).join('\n') + '\n')
  const pricedBefore = ctx.tokenMeter.measure(session)
  const operation = session.checkout(throughSeq, { operationId: 'native-file-transaction-test' })
  assert.deepEqual(session.surface.nodes, expected)
  assert.deepEqual(session.snapshotEvents(0, before.length), before)
  assert(!selectActiveHistoryEvents(session.snapshotEvents()).some(event => event.seq === targetUser.seq))
  const priced = ctx.tokenMeter.measure(session)
  assert.deepEqual(priced.nodes.map(node => node.seq), expected)
  const undo = encoded(session), reopened = open(undo.restored)
  assert.deepEqual(reopened.surface.nodes, expected)
  assert.deepEqual(reopened.deriveMessages(), session.deriveMessages())
  assert.deepEqual(coldCtx.tokenMeter.measure(reopened), { ...priced, logRevision: reopened.seq })
  assert.deepEqual(coldCtx.sessionProjections.snapshot(reopened).values, ctx.sessionProjections.snapshot(session).values)
  await writeFile(join(output, 'undo.jsonl'), [undo.header, ...undo.rows].map(row => JSON.stringify(row)).join('\n') + '\n')
  session.checkout(SessionSeq(before.length - 1), { operationId: 'native-redo-test' })
  assert.deepEqual(session.surface.nodes, beforeSurface)
  assert.deepEqual(ctx.tokenMeter.measure(session), { ...pricedBefore, logRevision: session.seq })
  encoded(session)
  session.checkout(throughSeq)
  const branch = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '隔离Session原生checkout后的新分支追加' }] }), { surfaceOp: 'append' })
  const active = selectActiveHistoryEvents(session.snapshotEvents())
  assert(active.some(event => event.seq === branch.seq)); assert(!active.some(event => event.seq === targetUser.seq))
  const final = encoded(session)
  assert.deepEqual(open(final.restored).surface.nodes, session.surface.nodes)
  assert((await readFile(source)).equals(originalBytes))
  await writeFile(join(output, 'branch.jsonl'), [final.header, ...final.rows].map(row => JSON.stringify(row)).join('\n') + '\n')
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'PASS_NATIVE_HISTORY_CHECKOUT_CODEC', source, originalEvents: artifact.events.length, sourceUnchanged: true, throughSeq, targetUserSeq: targetUser.seq, checkoutSeq: operation.seq, operationId: operation.data.operationId, restoredSurface: expected, redoSurfaceExact: true, hotColdMeterExact: true, strictCodecEventsExact: true, allOriginalEventsPreserved: true, activeBranchExcludesUndoneUser: true, modelRequests: 0 }, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'PASS_NATIVE_HISTORY_CHECKOUT_CODEC', output, originalEvents: artifact.events.length, throughSeq }))
} finally { await coldCtx.fiber.dispose(); await ctx.fiber.dispose() }
