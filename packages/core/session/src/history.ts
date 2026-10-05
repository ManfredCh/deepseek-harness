/** Durable history branch selection; checkout never removes or renumbers original log events. */
import type { SessionSeqCursor } from './types.ts'

export interface HistoryEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
  readonly ignorable?: true
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
}

/** Validate the required, log-only checkout envelope and its earlier inclusive target. */
export function assertHistoryCheckoutEvent(event: HistoryEvent): void {
  if (event.type !== 'session/history-checkout') return
  const data = event.data
  if (event.ignorable !== undefined || event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
    throw new Error('session/history-checkout must be required and log-only')
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('history checkout data must be an object')
  const value = data as Record<string, unknown>, target = value['throughSeq']
  if (Object.keys(value).some(key => key !== 'throughSeq' && key !== 'operationId')
    || typeof target !== 'number' || !Number.isSafeInteger(target) || Object.is(target, -0)
    || target < -1 || target >= event.seq) throw new Error('history checkout throughSeq must name an earlier event or -1')
  if (value['operationId'] !== undefined && (typeof value['operationId'] !== 'string' || value['operationId'].length === 0)) {
    throw new Error('history checkout operationId must be a non-empty string when provided')
  }
}

/** Require a complete-log prefix outside every turn, step and compaction activity. */
export function assertStableHistoryBoundary(events: readonly HistoryEvent[], throughSeq: SessionSeqCursor): void {
  if (!Number.isSafeInteger(throughSeq) || Object.is(throughSeq, -0) || throughSeq < -1
    || throughSeq >= events.length || (events.length > 0 && events[0]?.seq !== 0)) {
    throw new Error('history checkout requires an existing boundary in a complete log')
  }
  let turn = false, step = false, compaction = false
  for (let seq = 0; seq <= throughSeq; seq++) {
    const event = events[seq]
    if (event?.seq !== seq) throw new Error('history checkout cannot cross a missing event')
    if (event.type === 'turn/start') turn = true
    else if (event.type === 'turn/end') turn = false
    else if (event.type === 'step/start') step = true
    else if (event.type === 'step/end') step = false
    else if (event.type === 'compaction/start') compaction = true
    else if (event.type === 'compaction/end') compaction = false
    else if (event.type === 'session/end-seed') compaction = false
  }
  if (turn || step || compaction) throw new Error('history checkout requires a stable boundary outside turn, step and compaction')
}

/**
 * Select original events on the active branch, including log-only metadata.
 * Compaction does not hide append-origin human history. A partial contiguous
 * durable window is supported: a checkout before its first seq clears that
 * window's earlier items. Merge older pages with the newest window before
 * selecting, since an isolated old page cannot observe later checkout events.
 */
export function selectActiveHistoryEvents<T extends HistoryEvent>(events: readonly T[]): T[] {
  if (events.length === 0) return []
  const first = events[0]!.seq, bySeq = new Map<number, T>(), previous = new Map<number, number | undefined>()
  let tail: number | undefined
  for (const [index, event] of events.entries()) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || Object.is(event.seq, -0) || event.seq !== first + index) {
      throw new Error('active history requires a contiguous durable event window')
    }
    let parent = tail
    if (event.type === 'session/history-checkout') {
      assertHistoryCheckoutEvent(event)
      const throughSeq = (event.data as { throughSeq: number }).throughSeq
      if (throughSeq >= first && !bySeq.has(throughSeq)) throw new Error('history checkout target is missing from the loaded window')
      parent = throughSeq < first ? undefined : throughSeq
    }
    bySeq.set(event.seq, event); previous.set(event.seq, parent); tail = event.seq
  }
  const selected: T[] = []
  while (tail !== undefined) { selected.push(bySeq.get(tail)!); tail = previous.get(tail) }
  return selected.reverse()
}
