/** Pure model-input derivation shared by the driver and its durable reconstruction check. */

import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Session } from '@deepseek-ai/dsh-session'
import { projectModelMessages } from '@deepseek-ai/dsh-system-prompt'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { currentContextMessages } from './runtime-context.ts'

/**
 * Rebuild the request from the same Session and installed deterministic projection.
 * Protected messages and binary content retain their logged identities and values.
 * @param ctx - actual Agent context, or the invariant context resolving that Agent.
 * @param session - authoritative Session whose current surface is projected.
 * @param scope - actual Agent scope; resolved from the registry when omitted.
 * @returns a fresh request array with unchanged protected message values.
 */
export function deriveModelRequestMessages(ctx: Context, session: Session, scope?: ScopeKey): Message[] {
  const agent = ctx.get('agents')?.get(session.id)
  const effectiveScope = scope ?? agent
  const messages = deepFreeze(currentContextMessages(session.deriveMessages()))
  const projected = projectModelMessages(agent?.ctx ?? ctx, messages, {
    ...effectiveScope === undefined ? {} : { scope: effectiveScope },
    sessionId: session.id,
    purpose: 'main',
  })
  const byId = new Map(projected.map(message => [message.id, message]))
  for (const message of messages) {
    const next = byId.get(message.id)
    const owned = message.role === 'system' && message.source.kind === 'system-prompt'
      || message.role === 'user' && isCurrentStateOwner(message)
    if (!owned && JSON.stringify(next) !== JSON.stringify(message)) {
      throw new Error(`model input projection changed protected message ${message.id}`)
    }
    const binaries = message.content.filter(block => block.type !== 'text')
    if (binaries.length > 0 && JSON.stringify(next?.content.filter(block => block.type !== 'text')) !== JSON.stringify(binaries)) {
      throw new Error(`model input projection changed non-text content of message ${message.id}`)
    }
    if (next !== undefined && (next.role !== message.role || JSON.stringify(next.source) !== JSON.stringify(message.source))) {
      throw new Error(`model input projection changed the role or source of message ${message.id}`)
    }
  }
  const ids = new Set(messages.map(message => message.id))
  if (byId.size !== projected.length || projected.some(message => !ids.has(message.id))) {
    throw new Error('model input projection introduced an unlogged or duplicated message identity')
  }
  return [...projected]
}

function isCurrentStateOwner(message: Message): boolean {
  const source = message.source as { kind: string; form?: string }
  return source.kind === 'runtime-context' || source.kind === 'lyapunov-domain-pointer'
    || source.kind === 'skill-catalog' && source.form === 'catalog'
    || (source.kind === 'lyapunov-engine-install' || source.kind === 'plugin:lyapunov-engine-install') && source.form === 'notice'
}
