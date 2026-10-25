import { describe, expect, it } from 'vitest'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { activeHistoryWindow, historyClosureEvents } from '../src/client/conversation/history-checkout.ts'
import { ConversationLocationIndex } from '../src/client/conversation/location-index.ts'

function row(seq: number, type: string, data: unknown, surfaceOp?: unknown): SessionEventLikeEntry {
  return { type: 'event', event: { seq, time: seq, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } } as SessionEventLikeEntry
}
const user = (seq: number, text: string) => row(seq, 'user/message', { id: text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, 'append')
const selectedText = (entries: readonly SessionEventLikeEntry[]) => activeHistoryWindow(entries).flatMap(entry => entry.event.type === 'user/message' && entry.event.surfaceOp === 'append' ? entry.event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])

describe('active human history windows', () => {
  it('uses original closed activity facts without returning hidden endings as renderer inputs', () => {
    const raw = [row(0, 'turn/start', { turn: 1 }), row(1, 'step/start', { turn: 1, step: 1 }), user(2, 'A'), user(3, 'withdrawn steering'), row(4, 'step/end', { turn: 1, step: 1 }), row(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), row(6, 'session/history-checkout', { throughSeq: 2 })]
    const active = activeHistoryWindow(raw), closures = historyClosureEvents(raw, active)
    expect(active.map(entry => entry.event.seq)).toEqual([0, 1, 2, 6])
    expect(closures.map(entry => entry.event.seq)).toEqual([4, 5])
    expect(closures[0]).toBe(raw[4])
    const locations = new ConversationLocationIndex()
    locations.rebuild([...active, ...closures].sort((left, right) => left.event.seq - right.event.seq))
    expect(locations.snapshot().turns.get(1)?.status).toBe('closed')
    expect(locations.snapshot().turns.get(1)?.steps[0]?.status).toBe('closed')
  })
  it('keeps compaction origins but removes checked-out messages across prepend and redo', () => {
    const events = [user(0, 'A'), user(1, 'B'), row(2, 'user/message', { source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text', text: 'model summary' }] }, { op: 'replace', startSeq: 0, endSeq: 1 })]
    expect(selectedText(events)).toEqual(['A', 'B'])
    events.push(row(3, 'session/history-checkout', { throughSeq: 0 }))
    expect(selectedText(events)).toEqual(['A'])
    expect(selectedText(events.slice(1))).toEqual([])
    expect(selectedText([events[0]!, ...events.slice(1)])).toEqual(['A'])
    events.push(row(4, 'session/history-checkout', { throughSeq: 2 }))
    expect(selectedText(events)).toEqual(['A', 'B'])
    events.push(row(5, 'session/history-checkout', { throughSeq: 0 }), user(6, 'C'))
    expect(selectedText(events)).toEqual(['A', 'C'])
  })

  it('does not show orphan undo/redo command halves or retired Assistant chunks', () => {
    const events = [user(0, 'A'), row(1, 'command/run', { commandId: 'undo', name: 'undo' }), row(2, 'session/history-checkout', { throughSeq: 0 }), row(3, 'command/done', { commandId: 'undo', kind: 'success' })]
    const commands = () => activeHistoryWindow(events).filter(entry => entry.event.type.startsWith('command/'))
    expect(commands()).toEqual([])
    events.push(row(4, 'command/run', { commandId: 'redo', name: 'redo' }), row(5, 'session/history-checkout', { throughSeq: 1 }), row(6, 'command/done', { commandId: 'redo', kind: 'success' }))
    expect(commands()).toEqual([])
    events.push(row(7, 'command/run', { commandId: 'normal', name: 'normal' }))
    expect(commands().map(entry => entry.event.seq)).toEqual([7])
    const chunks = [
      { type: 'transient', event: { type: 'assistant/live-chunk', seq: 1.5, time: 1, data: { turn: 1, step: 1 } } },
      { type: 'transient', event: { type: 'assistant/live-chunk', seq: 7.5, time: 1, data: { turn: 2, step: 1 } } },
    ] as SessionEventLikeEntry[]
    // Anchor 1 is retained by redo's raw checkout but its closed Command is
    // absent from the selected display. Model chunks use durable branch scope.
    expect(activeHistoryWindow([...events, ...chunks]).filter(entry => entry.type === 'transient').map(entry => entry.event.seq)).toEqual([1.5, 7.5])
    events.push(row(8, 'session/history-checkout', { throughSeq: 0 }))
    expect(activeHistoryWindow([...events, ...chunks]).some(entry => entry.type === 'transient')).toBe(false)
  })
})
