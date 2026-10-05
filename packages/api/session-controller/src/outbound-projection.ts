/** Consumer-owned projection of detached Session history copies sent to the browser. */

import type { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamRecord, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionWireEvent } from './types.ts'

/** Service name supplied by the Host's browser history consumer. */
export const SESSION_OUTBOUND_PROJECTION = 'sessionOutboundProjection'

/** Pure synchronous browser-copy projection; the native event envelope remains authoritative. */
export interface SessionOutboundProjectionService {
  /** Project event data on a detached native event without writing Session state. */
  projectEvent(event: unknown): unknown
  /** Project one detached content block; tool arguments may be incomplete JSON fragments. */
  projectBlock(block: unknown): unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Consumer-owned browser history projection, resolved again at each delivery. */
    sessionOutboundProjection: SessionOutboundProjectionService
  }
}

/** Outbound operations use the current provider and refuse missing or malformed providers. */
export interface SessionOutboundProjectors {
  /** Project only data; retain original seq, type, time and surface metadata. */
  event(event: SessionEvent): SessionWireEvent
  /** Project a model chunk without changing its correlation or timing fields. */
  block(chunk: StreamChunk): StreamChunk
  /** Project compact records without expanding, re-timing or reordering the stream. */
  stream(records: readonly AssistantStreamRecord[]): readonly AssistantStreamRecord[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectedJson(value: unknown): JsonValue {
  const copy = snapshotJsonValue(value)
  if (copy === undefined) throw new Error('sessionOutboundProjection returned non-JSON data')
  // The wire payload is admitted by the same lossless JSON check as Session appends.
  return copy as JsonValue
}

/**
 * Resolve the active consumer for every delivery, including provider replacement or disposal.
 * @param ctx - Host context carrying the browser history consumer.
 * @returns detached event, live chunk and compact stream projectors.
 */
export function sessionOutboundProjection(ctx: Context): SessionOutboundProjectors {
  const resolve = (): SessionOutboundProjectionService => {
    const service = ctx.get(SESSION_OUTBOUND_PROJECTION)
    if (service == null || typeof service.projectEvent !== 'function' || typeof service.projectBlock !== 'function') {
      throw new Error(`missing active ${SESSION_OUTBOUND_PROJECTION} service`)
    }
    return service
  }
  return {
    event(event) {
      const service = resolve()
      const projected = service.projectEvent(structuredClone(event))
      if (!record(projected) || !Object.hasOwn(projected, 'data')) throw new Error('sessionOutboundProjection returned no event data')
      const data = projected.data
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        if (!record(data)) throw new Error('sessionOutboundProjection returned invalid Assistant data')
        return { ...event, data: projectedJson({ ...data, stream: projectStream(event.data.stream, service) }) }
      }
      return { ...event, data: projectedJson(data) }
    },
    block(chunk) { return projectChunk(structuredClone(chunk), resolve()) },
    stream(records) { return projectStream(records, resolve()) },
  }
}

function projectChunk(chunk: StreamChunk, service: SessionOutboundProjectionService): StreamChunk {
  switch (chunk.type) {
    case 'block-end': {
      const value = service.projectBlock(structuredClone(chunk.block))
      if (!record(value) || value.type !== chunk.block.type) throw new Error('sessionOutboundProjection changed a content block type')
      const block = snapshotJsonValue(value)
      if (block === undefined) throw new Error('sessionOutboundProjection returned non-JSON content')
      if (Object.keys(chunk.block).some(key => !Object.hasOwn(block, key))) throw new Error('sessionOutboundProjection removed a content field')
      if ('text' in chunk.block && typeof block.text !== 'string') throw new Error('sessionOutboundProjection returned invalid content text')
      if (chunk.block.type === 'tool-call' && (block.id !== chunk.block.id || block.name !== chunk.block.name || typeof block.arguments !== 'string')) {
        throw new Error('sessionOutboundProjection changed a tool identity or arguments type')
      }
      if ('attachment' in chunk.block && JSON.stringify(block.attachment) !== JSON.stringify(chunk.block.attachment)) {
        throw new Error('sessionOutboundProjection changed an attachment identity')
      }
      return { ...chunk, block: Object.assign(structuredClone(chunk.block), block) }
    }
    case 'tool-call-delta': {
      const value = service.projectBlock({ type: 'tool-call', id: chunk.id, name: chunk.name ?? '', arguments: chunk.argumentsDelta })
      if (!record(value) || typeof value.arguments !== 'string') throw new Error('sessionOutboundProjection returned invalid tool arguments')
      return { ...chunk, argumentsDelta: value.arguments }
    }
    case 'text-delta':
    case 'reasoning-delta': {
      const value = service.projectBlock({ type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: chunk.text })
      if (!record(value) || typeof value.text !== 'string') throw new Error('sessionOutboundProjection returned invalid stream text')
      return { ...chunk, text: value.text }
    }
    default: return chunk
  }
}

function projectStream(records: readonly AssistantStreamRecord[], service: SessionOutboundProjectionService): AssistantStreamRecord[] {
  return records.map(source => {
    const current = structuredClone(source)
    switch (current.type) {
      case 'chunk': return { ...current, chunk: projectChunk(current.chunk, service) }
      case 'tool-call-chunks':
        return { ...current, args: current.args.map(argumentsDelta => {
          const chunk = projectChunk({ type: 'tool-call-delta', index: current.index, id: current.id,
            ...current.name === undefined ? {} : { name: current.name }, argumentsDelta }, service)
          if (chunk.type !== 'tool-call-delta') throw new Error('sessionOutboundProjection changed a compact tool chunk')
          return chunk.argumentsDelta
        }) }
      case 'text-chunks':
      case 'reasoning-chunks':
        return { ...current, texts: current.texts.map(text => {
          const chunk = projectChunk({ type: current.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: current.index, text }, service)
          if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') throw new Error('sessionOutboundProjection changed a compact text chunk')
          return chunk.text
        }) }
    }
  })
}
