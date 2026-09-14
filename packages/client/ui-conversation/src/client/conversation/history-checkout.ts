import { selectActiveHistoryEvents } from '@deepseek-ai/dsh-session/surface'
import type { SessionEventLikeEntry, SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'

/** Select the active conversation from the complete loaded raw Client window. */
export function activeHistoryWindow(entries: readonly SessionEventLikeEntry[]): readonly SessionEventLikeEntry[] {
  const durable = entries.filter((entry): entry is SessionLiveEventEntry => entry.type === 'event')
  if (!durable.some(entry => entry.event.type === 'session/history-checkout')) return entries
  const active = new Set(selectActiveHistoryEvents(durable.map(entry => entry.event)).map(event => Number(event.seq)))
  const runs = new Map(durable.flatMap(({ event }) => event.type === 'command/run' ? [[event.data.commandId, event.seq] as const] : []))
  const done = new Map(durable.flatMap(({ event }) => event.type === 'command/done' ? [[event.data.commandId, event.seq] as const] : []))
  // Client Assistant chunks live in the gap after their durable cursor, using
  // cursor + 1 - 1/(ordinal + 1). They are not valid native checkout targets.
  return entries.filter(entry => {
    if (!active.has(entry.type === 'event' ? entry.event.seq : Math.floor(entry.event.seq))) return false
    const event = entry.event
    if (event.type === 'command/run') {
      const completion = done.get(event.data.commandId)
      return completion === undefined || active.has(completion)
    }
    if (event.type === 'command/done') {
      const start = runs.get(event.data.commandId)
      return start !== undefined && active.has(start)
    }
    return true
  })
}

/** Real closed activity facts retained only for Location state, never renderer inputs. */
export function historyClosureEvents(raw: readonly SessionEventLikeEntry[], active: readonly SessionEventLikeEntry[]): readonly SessionLiveEventEntry[] {
  if (!raw.some(entry => entry.event.type === 'session/history-checkout')) return []
  const turns = new Set<number>(), steps = new Set<string>(), visible = new Set(active.map(entry => entry.event.seq))
  for (const entry of active) {
    const data = entry.event.data as { turn?: unknown; step?: unknown }
    if (typeof data.turn !== 'number') continue
    turns.add(data.turn)
    if (typeof data.step === 'number') steps.add(`${data.turn}:${data.step}`)
  }
  return raw.filter((entry): entry is SessionLiveEventEntry => {
    if (entry.type !== 'event' || visible.has(entry.event.seq)) return false
    const event = entry.event
    return (event.type === 'turn/end' && turns.has(event.data.turn))
      || (event.type === 'step/end' && steps.has(`${event.data.turn}:${event.data.step}`))
  })
}
