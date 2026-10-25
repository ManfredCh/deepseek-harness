import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Why one session's composer is inert. */
export interface ComposerBlock {
  /** Explicit model-only refusal; absent or unknown classifications keep native commands locked. */
  readonly kind?: 'model-unavailable'
  /** Localized placeholder owned by the plugin that raised the block. */
  readonly reason: string
  /** A model-only refusal may leave the existing file-permission control available. Other blocks stay locked. */
  readonly allowPermissionChanges?: boolean
}

/** The registry face other plugins reach through `ctx.conversation.blocks`. */
export interface ComposerBlocks {
  /**
   * Raise or clear this session's block.
   * @param sessionId - Session whose composer is affected.
   * @param block - Block to raise, or undefined to clear it.
   */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void
  /**
   * Resolve the observable block state for one Session.
   * @param sessionId - Session to observe.
   * @returns Identity-stable block store.
   */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined>
  /**
   * Drop one Session's store.
   * @param sessionId - Session being released.
   */
  forget(sessionId: SessionId): void
}
