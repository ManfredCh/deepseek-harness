/**
 * Browser resource ownership for the experimental providers. Resources belong
 * to an exact live Agent activation and never transfer to a resumed Session.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One provider-owned browser or connection and its quiescent cleanup. */
export interface OwnedSessionResource<T> {
  /** Provider-private handle exposed to operations. */
  value: T
  /** Failed acquisition whose partial resource stays owned until close confirms release. */
  acquisitionError?: Error
  /** Stop admission, interrupt pending operations, and await resource shutdown. */
  close: () => Promise<void>
  /**
   * Rebuild this owner's provider connection in place while retaining the resource
   * entry, its tool registrations, and exclusive ownership. Omit a provider that has
   * no connection to rebuild. The failed operation is never replayed.
   * @returns settlement after the replacement connection is ready.
   */
  recycle?: () => Promise<void>
  /**
   * Release this owner's connection and await the underlying process without
   * starting a replacement; {@link recycle} then mounts a fresh connection.
   * Cancellation awaits this so "canceled" never reports a process as stopped
   * while it is still alive. Concurrent calls share one release.
   * @returns settlement after the connection and its process are released.
   */
  release?: () => Promise<void>
}

/** One Session's automatic-rebuild budget after consecutive provider failures. */
export interface SessionRebuildHealth {
  /** Consecutive reported browser failures not yet cleared by a successful operation. */
  readonly failures: number
  /** Message from the most recent reported failure or failed rebuild. */
  readonly lastReason?: string
  /** Whether the budget is spent and automatic rebuilds have stopped. */
  readonly suspended: boolean
}

/** Resource creation and attachment ownership selected by one provider. */
export interface SessionResourceOptions<T> {
  /** Provider name included in lifecycle diagnostics. */
  label: string
  /** Reserve one existing browser for at most one live Session. */
  exclusive: boolean
  /**
   * Consecutive reported provider failures for one Session that may start a
   * replacement connection before automatic rebuilds stop. Omission keeps
   * rebuilds unbounded. The cap exists for providers whose replacement can fail
   * the same way as the failure it replaces; a successful operation or a new
   * activation starts a fresh budget.
   */
  rebuildBudget?: number
  /**
   * Acquire one resource; reject only after rolling back partial acquisition.
   * @param agent - exact live owner of this acquisition.
   * @param signal - aborts when that owner or the provider is disposed.
   * @returns the resource and cleanup, including acquisitionError when rollback
   *   cannot confirm release; that resource remains owned and cannot be used.
   */
  open: (agent: Agent, signal: AbortSignal) => Promise<OwnedSessionResource<T>>
}

interface Entry<T> {
  controller: AbortController
  ready: Promise<OwnedSessionResource<T>>
  tail: Promise<void>
  closing?: Promise<void>
  /** Consecutive reported failures for this Session, cleared by a successful operation. */
  failures: number
  /** Message from the most recent reported failure or failed rebuild. */
  lastReason?: string
  /** A launch condition that a replacement connection cannot repair. */
  blocked?: boolean
}

/** Stop a caller's wait while retaining handlers on the resource owner's work. */
function awaitOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('browser operation canceled', { cause: signal.reason })) }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then((value) => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted)
      reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
    })
  })
}

/**
 * Lazily acquires one resource per live Session and serializes its operations.
 * Provider disposal closes connections before awaiting operations, allowing
 * transport closure to interrupt work whose upstream API has no abort support.
 */
export class SessionResources<T> {
  private readonly entries = new Map<Agent, Entry<T>>()
  private readonly ownerCleanups = new Map<Agent, () => Promise<void>>()
  private readonly disposedOwners = new WeakSet<Agent>()
  private readonly recycling = new Map<Agent, Promise<void>>()
  private readonly releasing = new Map<Agent, Promise<void>>()
  private disposing: Promise<void> | undefined

  /**
   * @param ctx - provider context with the live Agent registry.
   * @param options - provider-owned acquisition and attachment policy.
   */
  constructor(private readonly ctx: Context, private readonly options: SessionResourceOptions<T>) {
    const budget = options.rebuildBudget
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1)) {
      throw new Error(`${options.label}: rebuildBudget must be a positive integer`)
    }
  }

  /**
   * Check admission without reserving or acquiring a browser.
   * @param agent - exact live Agent that would own the resource.
   * @returns whether this owner can use or acquire the configured browser.
   */
  available(agent: Agent): boolean {
    return this.disposing === undefined && !this.disposedOwners.has(agent)
      && this.ctx.get('agents')?.get(agent.id) === agent
      && this.entries.get(agent)?.blocked !== true
      && (this.entries.has(agent) || !this.options.exclusive || this.entries.size === 0)
  }

  /**
   * Obtain the current activation's resource, acquiring it once when absent.
   * @param agent - exact live owner, never merely a durable Session id.
   * @param signal - optional cancellation of this wait; acquisition remains Session-owned.
   * @returns the provider's resource after acquisition and ownership checks.
   */
  async get(agent: Agent, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const entry = this.entry(agent)
    const resource = await (signal === undefined ? entry.ready : awaitOperation(entry.ready, signal))
    signal?.throwIfAborted()
    entry.controller.signal.throwIfAborted()
    if (resource.acquisitionError !== undefined) throw resource.acquisitionError
    return resource.value
  }

  /**
   * Rebuild one live Session's provider connection without releasing its ownership.
   * Concurrent callers share one rebuild, so a burst of failures or cancellations
   * cannot start several replacement providers for the same Session.
   * @param agent - exact live resource owner.
   * @returns settlement after the replacement connection is ready, or immediately
   *   when the owner has no entry or its provider declares no rebuild.
   */
  recycle(agent: Agent): Promise<void> {
    const pending = this.recycling.get(agent)
    if (pending !== undefined) return pending
    const entry = this.entries.get(agent)
    if (entry === undefined) return Promise.resolve()
    const task = entry.ready.catch(() => undefined).then(async (resource) => {
      if (resource?.acquisitionError !== undefined) throw resource.acquisitionError
      if (resource?.recycle !== undefined) await resource.recycle()
    }).finally(() => {
      if (this.recycling.get(agent) === task) this.recycling.delete(agent)
    })
    this.recycling.set(agent, task)
    return task
  }

  /**
   * Release one live Session's provider connection without starting a
   * replacement, and await the release. Concurrent callers share one release.
   * @param agent - exact live resource owner.
   * @returns settlement after the connection and its process are released, or
   *   immediately when the owner has no entry or its provider declares no release.
   */
  release(agent: Agent): Promise<void> {
    const pending = this.releasing.get(agent)
    if (pending !== undefined) return pending
    const entry = this.entries.get(agent)
    if (entry === undefined) return Promise.resolve()
    const task = entry.ready.catch(() => undefined).then(async (resource) => {
      if (resource?.release !== undefined) await resource.release()
    }).finally(() => {
      if (this.releasing.get(agent) === task) this.releasing.delete(agent)
    })
    this.releasing.set(agent, task)
    return task
  }

  /**
   * Record one provider-observed browser failure and rebuild this Session's
   * connection while its budget allows. A burst of reports shares one rebuild,
   * and a failed rebuild is counted too, so a resource whose replacements keep
   * failing stops instead of starting a process every round.
   * @param agent - exact live resource owner.
   * @param reason - provider message describing what failed.
   * @param options - a permanent launch condition can suspend without rebuilding.
   * @returns the health after this report, or undefined when the owner has no entry.
   */
  reportFailure(agent: Agent, reason: string, options: { rebuild?: boolean } = {}): SessionRebuildHealth | undefined {
    const entry = this.entries.get(agent)
    if (entry === undefined) return undefined
    entry.failures += 1
    entry.lastReason = reason
    if (options.rebuild === false) entry.blocked = true
    const budget = this.options.rebuildBudget
    if (entry.blocked || (budget !== undefined && entry.failures >= budget)) {
      this.ctx.logger.warn(`${this.options.label}: automatic browser rebuild stopped after ${entry.failures} consecutive failures: ${reason}; a new Session activation can probe again`)
      return this.healthOf(entry)
    }
    void this.recycle(agent).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      entry.failures += 1
      entry.lastReason = `connection rebuild failed: ${message}`
      this.ctx.logger.warn(`${this.options.label}: automatic browser rebuild failed (${entry.failures}): ${message}`)
    })
    return this.healthOf(entry)
  }

  /**
   * Clear a Session's consecutive-failure budget after a successful operation.
   * Connection establishment and tool discovery must not call this: only an
   * actual provider operation's success shows the resource works.
   * @param agent - exact live resource owner.
   */
  reportSuccess(agent: Agent): void {
    const entry = this.entries.get(agent)
    if (entry === undefined) return
    entry.failures = 0
    delete entry.lastReason
    delete entry.blocked
  }

  /**
   * Read one Session's current automatic-rebuild health.
   * @param agent - exact live resource owner.
   * @returns the health, or undefined before this Session acquired a resource.
   */
  health(agent: Agent): SessionRebuildHealth | undefined {
    const entry = this.entries.get(agent)
    return entry === undefined ? undefined : this.healthOf(entry)
  }

  /**
   * Whether this live owner is releasing or rebuilding its connection.
   * @param agent - exact live resource owner.
   * @returns whether a following operation must wait for owner settlement.
   */
  recovering(agent: Agent): boolean {
    return this.releasing.has(agent) || this.recycling.has(agent)
  }

  /**
   * Await this owner's complete release/rebuild chain. Cancellation may first
   * release a connection and enqueue its replacement only after that release;
   * inspecting just the rebuild map can enter the gap between those states.
   * A refused release or rebuild remains a failure and cannot admit an operation.
   * @param agent - exact live resource owner.
   * @param signal - cancellation of this wait, without canceling owner recovery.
   * @returns settlement after the owner has no pending connection transition.
   */
  async waitForRecovery(agent: Agent, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted()
      const pending = [this.releasing.get(agent), this.recycling.get(agent)]
        .filter((task): task is Promise<void> => task !== undefined)
      if (pending.length === 0) return
      const settled = Promise.all(pending).then(() => {})
      await (signal === undefined ? settled : awaitOperation(settled, signal))
    }
  }

  /**
   * Run after earlier operations on this Session settle; other Sessions proceed independently.
   * Cancellation stops this caller's acquisition wait without canceling Session-owned initialization.
   * It reaches an active provider operation and prevents queued work from starting.
   * @param agent - exact live resource owner.
   * @param signal - cancellation for this operation.
   * @param operation - provider call, which must retain ownership until its work settles.
   * @returns the operation result or its acquisition, cancellation, or execution failure.
   */
  run<R>(agent: Agent, signal: AbortSignal, operation: (resource: T, signal: AbortSignal) => Promise<R>): Promise<R> {
    signal.throwIfAborted()
    const entry = this.entry(agent)
    const combined = AbortSignal.any([signal, entry.controller.signal])
    const releaseDisposed = () => {
      const reason = signal.reason as { kind?: unknown } | undefined
      if (reason?.kind !== 'disposed') return
      this.disposedOwners.add(agent)
      // AgentHandle waits for idle before disposing its scope; close interrupts the owned operation first.
      void this.closeEntry(agent, entry).catch((error: unknown) => {
        this.ctx.logger.warn(`${this.options.label}: browser cleanup during Session cancellation failed: ${String(error)}`)
      })
    }
    // A user or parent cancellation must also end the provider's underlying work,
    // not merely reject this caller: closing the connection is what interrupts an
    // upstream call that ignores its signal. This caller does not report
    // settlement until that release settles, so a canceled operation never claims
    // a process stopped that is still alive. A disposed owner is already closing.
    // `started` is this call's own execution slot: a call still queued behind an
    // earlier one owns no connection, so its cancellation must not release the
    // connection that earlier call still owns.
    let started = false
    let interrupted: Promise<void> | undefined
    const releaseOnAbort = (): void => {
      if (!started || entry.closing !== undefined) return
      const released = this.release(agent)
      interrupted = released.catch((error: unknown) => {
        throw new Error(
          `${this.options.label}: the canceled browser operation could not confirm that its owned connection and process were released (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        )
      })
      // Restore this Session's connection in the background so its browser tools
      // stay available; the canceled caller waits only for the release. A refused
      // release keeps whatever the provider still owns, so a replacement is
      // requested only after the release itself settles.
      void released.then(
        () => this.recycle(agent).catch((error: unknown) => {
          this.ctx.logger.warn(`${this.options.label}: restoring the browser connection after cancellation failed: ${String(error)}`)
        }),
        () => {},
      )
    }
    signal.addEventListener('abort', releaseDisposed, { once: true })
    signal.addEventListener('abort', releaseOnAbort, { once: true })
    const task = entry.tail.then(async () => {
      combined.throwIfAborted()
      await this.waitForRecovery(agent, combined)
      combined.throwIfAborted()
      const resource = await awaitOperation(entry.ready, combined)
      combined.throwIfAborted()
      if (resource.acquisitionError !== undefined) throw resource.acquisitionError
      started = true
      try {
        const result = await operation(resource.value, combined)
        combined.throwIfAborted()
        return result
      } finally {
        started = false
        // Await the release a cancellation started during this operation. A
        // rejection replaces the plain cancellation, so a refused release is
        // reported as a failure instead of a clean stop.
        if (interrupted !== undefined) await interrupted
      }
    }).finally(() => {
      signal.removeEventListener('abort', releaseDisposed)
      signal.removeEventListener('abort', releaseOnAbort)
    })
    // The queue tracks settlement independently of a caller observing its error.
    entry.tail = task.then(() => {}, () => {})
    return task
  }

  /**
   * Stop new acquisitions and await every acquired resource and owned operation.
   * A failed close retains its entry and rejects disposal, preserving exclusive ownership.
   * @returns the shared quiescent disposal promise.
   */
  dispose(): Promise<void> {
    return this.disposing ??= Promise.resolve().then(async () => {
      const settled = await Promise.allSettled([...this.entries].map(([agent, entry]) => this.closeEntry(agent, entry)))
      const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (errors.length > 0) throw new AggregateError(errors, `${this.options.label}: browser cleanup failed`)
      await Promise.all([...this.ownerCleanups.values()].map(close => close()))
    })
  }

  private entry(agent: Agent): Entry<T> {
    if (this.disposing !== undefined || this.disposedOwners.has(agent) || this.ctx.get('agents')?.get(agent.id) !== agent) {
      throw new Error(`${this.options.label}: Session is not a live browser owner`)
    }
    const current = this.entries.get(agent)
    if (current !== undefined) return current
    if (this.options.exclusive && this.entries.size > 0) {
      throw new Error(`${this.options.label}: attached browser is already reserved by another Session`)
    }
    if (!this.ownerCleanups.has(agent)) {
      const cleanup = agent.ctx.effect(() => async () => {
        this.disposedOwners.add(agent)
        const owned = this.entries.get(agent)
        if (owned !== undefined) await this.closeEntry(agent, owned)
        this.ownerCleanups.delete(agent)
      }, `${this.options.label}.session`)
      this.ownerCleanups.set(agent, cleanup)
    }
    const controller = new AbortController()
    const entry: Entry<T> = {
      controller,
      ready: Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return this.options.open(agent, controller.signal)
      }).then((resource) => {
        if (resource.acquisitionError !== undefined) {
          entry.blocked = true
          entry.lastReason = resource.acquisitionError.message
        }
        return resource
      }).catch((error: unknown) => {
        // open() owns rollback; a failed acquisition has no remaining resource.
        this.entries.delete(agent)
        throw error
      }),
      tail: Promise.resolve(),
      failures: 0,
    }
    // Acquisition can outlive every canceled caller; later consumers still receive its failure.
    void entry.ready.catch(() => {})
    this.entries.set(agent, entry)
    return entry
  }

  private healthOf(entry: Entry<T>): SessionRebuildHealth {
    const budget = this.options.rebuildBudget
    return {
      failures: entry.failures,
      ...entry.lastReason === undefined ? {} : { lastReason: entry.lastReason },
      suspended: entry.blocked === true || (budget !== undefined && entry.failures >= budget),
    }
  }

  private closeEntry(agent: Agent, entry: Entry<T>): Promise<void> {
    return entry.closing ??= Promise.resolve().then(async () => {
      entry.controller.abort(new Error(`${this.options.label}: Session browser is closing`))
      // A rebuild started before this close must settle before the scope is disposed,
      // so a replacement connection cannot be mounted onto a disposed owner.
      const [resource] = await Promise.all([
        entry.ready.catch(() => undefined),
        this.recycling.get(agent)?.catch(() => undefined),
        this.releasing.get(agent)?.catch(() => undefined),
      ])
      try {
        await resource?.close()
      } finally {
        await entry.tail
      }
      this.entries.delete(agent)
    })
  }
}
