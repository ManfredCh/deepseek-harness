/** Explicit Alpha4 history extensions; released first-party vocabularies stay frozen. */

import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/** Product-owned event names written by Alpha4, independent of official format vocabularies. */
export const PRODUCT_HISTORY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session/history-checkout', 'worktree/checkpoint', 'worktree/history-operation', 'worktree/capture',
  'lyapunov/tool-observation', 'lyapunov/request-diagnostics', 'lyapunov/recovery-handoff', 'lyapunov/service-diagnostic',
])

function object(value: SessionFormatJsonValue | undefined, subject: string): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError(`${subject} must be an object`)
  return value
}

function keys(value: SessionFormatJsonObject, required: readonly string[], optional: readonly string[], subject: string): void {
  const missing = required.find(key => !Object.hasOwn(value, key))
  const extra = Object.keys(value).find(key => !required.includes(key) && !optional.includes(key))
  if (missing !== undefined || extra !== undefined) throw new SessionFormatError(`${subject} has invalid field ${missing ?? extra}`)
}

function text(value: SessionFormatJsonValue | undefined, subject: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new SessionFormatError(`${subject} must be a nonempty string`)
}

function strings(value: SessionFormatJsonValue | undefined, subject: string): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new SessionFormatError(`${subject} must be a string array`)
}

function coordinate(value: SessionFormatJsonValue | undefined, seq: number, subject: string, cursor = false): number {
  if (cursor && value === -1) return -1
  const ref = sessionFormatCount(value, subject)
  if (ref >= seq) throw new SessionFormatError(`${subject} must name an earlier event`)
  return ref
}

function snapshot(value: SessionFormatJsonValue | undefined): void {
  if (value === null) return
  const data = object(value, 'worktree snapshot')
  keys(data, ['version', 'worktree', 'tree'], [], 'worktree snapshot')
  if (data['version'] !== 1) throw new SessionFormatError('worktree snapshot requires version 1')
  text(data['worktree'], 'worktree snapshot worktree'); text(data['tree'], 'worktree snapshot tree')
}

function diagnostic(value: SessionFormatJsonValue | undefined): void {
  if (value !== null) object(value, 'product diagnostic')
}

/**
 * Validate only listed product payloads before recovery can discard malformed rows.
 * @param event - decoded Alpha4 or current product event.
 * @returns whether this is one of the explicitly owned product event types.
 */
export function assertProductHistoryEvent(event: SessionFormatEvent): boolean {
  if (!PRODUCT_HISTORY_EVENT_TYPES.has(event.type)) return false
  const subject = `${event.type} at seq ${event.seq}`
  if (event['surfaceOp'] !== undefined || event['sourceEventSeqs'] !== undefined) throw new SessionFormatError(`${subject} must be log-only`)
  if (event.type === 'session/history-checkout') {
    if (event['ignorable'] !== undefined) throw new SessionFormatError('session/history-checkout must be required and log-only')
  } else if (event['ignorable'] !== true) throw new SessionFormatError(`${subject} must carry ignorable: true`)
  const data = object(event.data, subject)
  const counts = (names: readonly string[]) => { for (const name of names) sessionFormatCount(data[name], `${subject} ${name}`) }
  switch (event.type) {
    case 'session/history-checkout':
      keys(data, ['throughSeq'], ['operationId'], subject)
      coordinate(data['throughSeq'], event.seq, 'history checkout throughSeq', true)
      if (data['operationId'] !== undefined) text(data['operationId'], 'history checkout operationId')
      break
    case 'worktree/checkpoint':
      keys(data, ['version', 'phase', 'turn', 'step', 'snapshot', 'messageIds'], ['beforeSeq', 'paths'], subject)
      if (data['version'] !== 1 || !['before', 'after'].includes(String(data['phase']))) throw new SessionFormatError(`${subject} has invalid version or phase`)
      counts(['turn', 'step']); snapshot(data['snapshot']); strings(data['messageIds'], 'checkpoint messageIds')
      if (data['phase'] === 'after') coordinate(data['beforeSeq'], event.seq, 'checkpoint beforeSeq')
      else if (data['beforeSeq'] !== undefined) throw new SessionFormatError('before checkpoint cannot carry beforeSeq')
      if (data['paths'] !== undefined) strings(data['paths'], 'checkpoint paths')
      break
    case 'worktree/history-operation': {
      keys(data, ['version', 'operationId', 'action', 'throughSeq', 'restoreUserSeq', 'nextRedo', 'files'], [], subject)
      if (data['version'] !== 1 || !['undo', 'redo'].includes(String(data['action']))) throw new SessionFormatError(`${subject} has invalid version or action`)
      text(data['operationId'], 'history operationId'); coordinate(data['throughSeq'], event.seq, 'history operation throughSeq', true)
      if (data['restoreUserSeq'] !== null) coordinate(data['restoreUserSeq'], event.seq, 'history restoreUserSeq')
      if (!Array.isArray(data['nextRedo'])) throw new SessionFormatError('history nextRedo must be an array')
      for (const value of data['nextRedo']) {
        const point = object(value, 'redo point')
        keys(point, ['throughSeq', 'userSeq', 'snapshot', 'paths'], [], 'redo point')
        coordinate(point['throughSeq'], event.seq, 'redo throughSeq', true); coordinate(point['userSeq'], event.seq, 'redo userSeq')
        snapshot(point['snapshot']); strings(point['paths'], 'redo paths')
      }
      const files = object(data['files'], 'history files')
      keys(files, ['mode', 'paths'], [], 'history files')
      if (!['git', 'not-git', 'disabled'].includes(String(files['mode']))) throw new SessionFormatError('history files has invalid mode')
      strings(files['paths'], 'history files paths')
      break
    }
    case 'worktree/capture':
      keys(data, ['version', 'phase', 'full'], ['files', 'hashed', 'bytesRead', 'elapsedMs'], subject)
      if (data['version'] !== 1 || !['preparing', 'ready'].includes(String(data['phase'])) || typeof data['full'] !== 'boolean') throw new SessionFormatError(`${subject} has invalid capture fields`)
      for (const name of ['files', 'hashed', 'bytesRead', 'elapsedMs']) if (data[name] !== undefined) counts([name])
      break
    case 'lyapunov/tool-observation': {
      keys(data, ['callId', 'rootCallId', 'name', 'turn', 'step', 'argumentsHash', 'target', 'facts', 'diagnostic', 'images', 'job', 'isError', 'late', 'waited'], [], subject)
      for (const name of ['callId', 'rootCallId', 'name', 'argumentsHash']) text(data[name], `${subject} ${name}`)
      counts(['turn', 'step']); object(data['target'], 'observation target'); object(data['facts'], 'observation facts')
      diagnostic(data['diagnostic']); strings(data['images'], 'observation images')
      for (const name of ['isError', 'late', 'waited']) if (typeof data[name] !== 'boolean') throw new SessionFormatError(`${subject} ${name} must be boolean`)
      if (data['job'] !== null) {
        const job = object(data['job'], 'observation job')
        keys(job, ['jobId', 'registryId', 'hostInstanceId', 'startedAt', 'callId', 'callSeq', 'seq', 'status'], [], 'observation job')
        text(job['jobId'], 'jobId'); text(job['status'], 'job status')
        for (const name of ['registryId', 'hostInstanceId', 'callId']) if (job[name] !== null) text(job[name], `job ${name}`)
        if (job['startedAt'] !== null) sessionFormatCount(job['startedAt'], 'job startedAt')
        if (job['callSeq'] !== null) coordinate(job['callSeq'], event.seq, 'job callSeq')
        coordinate(job['seq'], event.seq, 'job seq')
      }
      break
    }
    case 'lyapunov/request-diagnostics':
      keys(data, ['turn', 'step', 'provider', 'model', 'messageCount', 'imageCount', 'toolCount', 'toolsBytes', 'toolsHash', 'contexts', 'basis'], [], subject)
      counts(['turn', 'step', 'messageCount', 'imageCount', 'toolCount', 'toolsBytes'])
      for (const name of ['provider', 'model', 'toolsHash']) text(data[name], `${subject} ${name}`)
      if (data['basis'] !== 'harness-before-adapter' || !Array.isArray(data['contexts'])) throw new SessionFormatError(`${subject} has invalid request diagnostics`)
      for (const value of data['contexts']) {
        const context = object(value, 'request context')
        keys(context, ['owner', 'form', 'bytes', 'hash', 'images', 'sections'], [], 'request context')
        for (const name of ['owner', 'form', 'hash']) text(context[name], `context ${name}`)
        for (const name of ['bytes', 'images']) sessionFormatCount(context[name], `context ${name}`)
        if (!Array.isArray(context['sections'])) throw new SessionFormatError('context sections must be an array')
        for (const value of context['sections']) {
          const section = object(value, 'context section')
          keys(section, ['name', 'bytes', 'hash'], [], 'context section')
          text(section['name'], 'section name'); text(section['hash'], 'section hash'); sessionFormatCount(section['bytes'], 'section bytes')
        }
      }
      break
    case 'lyapunov/recovery-handoff':
      keys(data, ['turn', 'step', 'code', 'stagnant', 'waiting'], [], subject)
      counts(['turn', 'step', 'stagnant']); text(data['code'], 'handoff code')
      if (typeof data['waiting'] !== 'boolean') throw new SessionFormatError('handoff waiting must be boolean')
      break
    case 'lyapunov/service-diagnostic':
      keys(data, ['callId', 'intentKey', 'code', 'diagnostic'], ['outcome'], subject)
      for (const name of ['callId', 'intentKey', 'code']) text(data[name], `${subject} ${name}`)
      diagnostic(data['diagnostic'])
      if (data['outcome'] !== undefined && !['success', 'error'].includes(String(data['outcome']))) throw new SessionFormatError('service diagnostic has invalid outcome')
      break
  }
  return true
}

/**
 * Remap only audited local product references; preserve ids, binary identities and side-effect facts.
 * @param event - admitted source event before target renumbering.
 * @param seq - target event coordinate.
 * @param mapping - coordinates of all earlier source events.
 * @returns a remapped product event with its original namespace and informational marker.
 */
export function remapProductHistoryReferences(event: SessionFormatEvent, seq: number, mapping: readonly number[]): SessionFormatEvent {
  assertProductHistoryEvent(event)
  const source = object(event.data, event.type)
  const reference = (value: SessionFormatJsonValue | undefined, cursor = false): number => {
    const old = coordinate(value, event.seq, 'product history reference', cursor)
    if (old === -1) return -1
    const target = mapping[old]
    if (target === undefined) throw new SessionFormatError('product history reference is missing from the source prefix')
    return target
  }
  let data = source
  if (event.type === 'session/history-checkout') data = { ...source, throughSeq: reference(source['throughSeq'], true) }
  if (event.type === 'worktree/checkpoint' && source['beforeSeq'] !== undefined) data = { ...source, beforeSeq: reference(source['beforeSeq']) }
  if (event.type === 'worktree/history-operation') data = {
    ...source, throughSeq: reference(source['throughSeq'], true),
    restoreUserSeq: source['restoreUserSeq'] === null ? null : reference(source['restoreUserSeq']),
    nextRedo: (source['nextRedo'] as SessionFormatJsonValue[]).map(value => {
      const point = object(value, 'redo point')
      return { ...point, throughSeq: reference(point['throughSeq'], true), userSeq: reference(point['userSeq']) }
    }),
  }
  if (event.type === 'lyapunov/tool-observation' && source['job'] !== null) {
    const job = object(source['job'], 'observation job')
    data = { ...source, job: { ...job, callSeq: job['callSeq'] === null ? null : reference(job['callSeq']), seq: reference(job['seq']) } }
  }
  return { ...event, seq, data }
}

const SURFACES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** Detached historical surface fold; it never imports or reinterprets current core Session types. */
export class ProductHistorySurface {
  nodes: number[] = []
  readonly headSeqs = new Set<number>()
  readonly checkouts = new Map<number, readonly number[]>()
  private readonly snapshots = new Map<number, readonly number[]>([[-1, []]])
  private readonly targets: ReadonlySet<number>
  private turn = false
  private step = false
  private compaction = false

  constructor(private readonly events: readonly SessionFormatEvent[], private readonly version: 3 | 4) {
    this.targets = new Set(events.flatMap(event => event.type === 'session/history-checkout'
      && isSessionFormatJsonObject(event.data) && typeof event.data['throughSeq'] === 'number' ? [event.data['throughSeq']] : []))
  }

  /**
   * Fold an event while validating original coordinates and checkout tool completeness.
   * @param event - next dense event from the supplied complete log.
   * @param interpret - whether the installed reader understands this event's lifecycle and surface fields.
   */
  apply(event: SessionFormatEvent, interpret = true): void {
    if (interpret && event.type === 'session/history-checkout') {
      assertProductHistoryEvent(event)
      if (this.turn || this.step || this.compaction) throw new SessionFormatError('history checkout requires a stable boundary outside turn, step and compaction')
      const target = object(event.data, 'history checkout')['throughSeq'] as number
      const nodes = this.snapshots.get(target)
      if (nodes === undefined) throw new SessionFormatError('history checkout requires a complete prefix')
      assertToolPairs(this.events, nodes, this.version)
      this.nodes = [...nodes]; this.checkouts.set(event.seq, nodes)
    } else if (interpret && SURFACES.has(event.type)) {
      if (event['surfaceOp'] === 'append') {
        const first = this.events[this.nodes[0] ?? -1]
        if (event.type === 'system/message' && first?.type !== 'system/message') {
          this.nodes.unshift(event.seq); this.headSeqs.add(event.seq)
        } else this.nodes.push(event.seq)
      } else {
        const range = object(event['surfaceOp'], 'surface replacement')
        const start = this.nodes.indexOf(range['startSeq'] as number), end = this.nodes.indexOf(range['endSeq'] as number)
        if (start < 0 || end < start) throw new SessionFormatError('surface replacement range is not on the current surface')
        this.nodes.splice(start, end - start + 1, event.seq)
      }
    }
    if (interpret && event.type === 'turn/start') this.turn = true
    if (interpret && event.type === 'turn/end') this.turn = false
    if (interpret && event.type === 'step/start') this.step = true
    if (interpret && event.type === 'step/end') this.step = false
    if (interpret && event.type === 'compaction/start') this.compaction = true
    if (interpret && (event.type === 'compaction/end' || event.type === 'session/end-seed')) this.compaction = false
    if (this.targets.has(event.seq)) this.snapshots.set(event.seq, [...this.nodes])
  }
}

function assertToolPairs(events: readonly SessionFormatEvent[], nodes: readonly number[], version: 3 | 4): void {
  const calls = new Set<string>()
  for (const seq of nodes) {
    const event = events[seq]
    if (event === undefined || event.seq !== seq) throw new SessionFormatError('checkout references a missing surface event')
    if (event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    const message = object(object(event.data, 'message data')['message'], 'message')
    const content = message['content']
    if (!Array.isArray(content)) throw new SessionFormatError('checkout message content must be an array')
    if (event.type === 'assistant/message') {
      for (const value of content) {
        const block = object(value, 'assistant block')
        if (block['type'] !== 'tool-call') continue
        const id = block['id'] as string
        if (calls.has(id)) throw new SessionFormatError('checkout repeats an unmatched tool call')
        calls.add(id)
      }
    } else {
      const id = version === 4 ? message['toolCallId'] : object(content[0], 'V3 tool-result block')['toolCallId']
      if (typeof id !== 'string' || !calls.delete(id)) throw new SessionFormatError('checkout contains an unmatched tool result')
    }
  }
  if (calls.size > 0) throw new SessionFormatError('checkout ends with unmatched tool calls')
}
