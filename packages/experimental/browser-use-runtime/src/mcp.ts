/** Session-owned MCP browser processes and provider catalog activation. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { ConnectionDisposal } from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { SessionResources, type OwnedSessionResource } from './index.ts'
import type { SessionRebuildHealth } from './index.ts'
import { BrowserRootObserver, type BrowserRootObservation } from './root-state.ts'
import type {} from '@deepseek-ai/dsh-browser-use'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Browser launch settings shared by the MCP integrations. */
export interface BrowserMcpLaunchConfig {
  /** Launch a new isolated Chromium browser for each live Session. */
  mode: 'launch'
  /** Whether Chromium runs without a visible window; defaults to true. */
  headless: boolean
  /** Chromium executable; omission uses the upstream server's installation discovery. */
  executablePath?: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Attachment to an externally owned Chromium browser. */
export interface BrowserMcpAttachConfig {
  /** Exclusively attach one live Session to the configured browser. */
  mode: 'attach'
  /** HTTP(S) debugging URL or WS(S) browser debugging endpoint. */
  endpoint: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Fixed launch or attachment choice for one MCP browser provider. */
export type BrowserMcpConfig = BrowserMcpLaunchConfig | BrowserMcpAttachConfig

/** A provider-observed browser failure, distinct from model or other tool failures. */
export interface BrowserRuntimeFailure {
  /** The condition actually named by the provider; a closed connection alone is not crash proof. */
  kind: 'page-closed' | 'closure-unverified' | 'browser-closed' | 'browser-crashed' | 'sandbox-unavailable' | 'display-unavailable' | 'profile-in-use' | 'executable-unavailable' | 'launch-failed' | 'transport-closed' | 'schema-unavailable' | 'release-unverified'
  /** Preserve a live browser, rebuild this owner, or wait for the launch condition to be fixed. */
  recovery: 'select-page' | 'rebuild' | 'blocked'
  /** Provider message, retained for the existing error result. */
  reason: string
}

/**
 * Classify the failure's meaning, never a CDP method name alone. A selected page
 * or execution context can close while its browser and other pages remain live.
 * @param error - provider throw or tool-error message, including a nested launch cause.
 * @returns a diagnosed browser condition, otherwise undefined.
 */
export function browserRuntimeFailure(error: unknown, root?: BrowserRootObservation): BrowserRuntimeFailure | undefined {
  const messages: string[] = []
  const seen = new Set<unknown>()
  for (let current = error; current !== undefined && !seen.has(current);) {
    seen.add(current)
    const detail = current as { message?: unknown; cause?: unknown } | null
    messages.push(typeof detail?.message === 'string' ? detail.message : String(current))
    current = typeof current === 'object' && current !== null ? detail?.cause : undefined
  }
  const reason = messages.join(': ')
  const classified = (kind: BrowserRuntimeFailure['kind'], recovery: BrowserRuntimeFailure['recovery']): BrowserRuntimeFailure => ({ kind, recovery, reason })
  if (/No usable sandbox|SUID sandbox helper|Failed to move to new namespace|Running as root without.*sandbox/iu.test(reason)) return classified('sandbox-unavailable', 'blocked')
  if (/Missing X server|cannot open display|could not open display|failed to connect to.*Wayland|ozone.*(?:initializ|display)/iu.test(reason)) return classified('display-unavailable', 'blocked')
  if (/SingletonLock|ProcessSingleton|profile.*(?:in use|locked)|browser is already running/iu.test(reason)) return classified('profile-in-use', 'blocked')
  if (/Could not find (?:Chrome|Chromium)|Browser was not found|executable.*(?:does not exist|not found)|spawn .*ENOENT/iu.test(reason)) return classified('executable-unavailable', 'blocked')
  if (/Failed to launch (?:the )?browser|browser launch failed/iu.test(reason)) return classified('launch-failed', 'blocked')
  if (/BROWSER_ROOT_UNVERIFIED/iu.test(reason)) return classified('closure-unverified', 'blocked')
  if (/MCP_PROVIDER_UNAVAILABLE|McpError|MCP error|transport.*closed|server.*exited|ECONNRESET/iu.test(reason)
    || (/Connection closed/iu.test(reason) && !/Protocol error/iu.test(reason))) return classified('transport-closed', 'blocked')
  const closed = /selected page.*closed|No page found|No target with given id|Cannot find (?:context|target)|Execution context was destroyed|Target closed|Session closed|Connection closed|Target page, context or browser has been closed|Browser (?:has been )?closed|browser disconnected|browser (?:process )?(?:has )?(?:crashed|exited)|browser.*SIG(?:ABRT|SEGV)/iu.test(reason)
  if (closed) {
    if (root?.rootConnected === false && root.ownership === 'session') return classified(root.processExited === true && ((root.exitCode !== undefined && root.exitCode !== null && root.exitCode !== 0) || root.signalCode === 'SIGABRT' || root.signalCode === 'SIGSEGV') ? 'browser-crashed' : 'browser-closed', 'rebuild')
    if ((root?.rootConnected === true && root.targetAlive === false) || /selected page.*closed|No page found|No target with given id|Cannot find (?:context|target)|Execution context was destroyed/iu.test(reason)) return classified('page-closed', 'select-page')
    if (root?.ownership === 'external' && root.rootConnected === false) return classified('closure-unverified', 'blocked')
    if (/MCP_PROVIDER_UNAVAILABLE|transport.*closed|server.*exited|ECONNRESET/iu.test(reason)) return classified('transport-closed', 'blocked')
    return classified('closure-unverified', 'select-page')
  }
  if (/MCP_PROVIDER_UNAVAILABLE|Connection closed|transport.*closed|server.*exited|ECONNRESET/iu.test(reason)) return classified('transport-closed', 'blocked')
  if (/UNKNOWN_TOOL|ToolNotFoundError|(?:tool|schema).*(?:not found|missing|not registered|unavailable)/iu.test(reason)) return classified('schema-unavailable', 'blocked')
  return undefined
}

/** Task-facing action after one diagnosed failure; it grants no additional authority. */
export function browserFailureAdvice(failure: BrowserRuntimeFailure): string {
  switch (failure.kind) {
    case 'page-closed': return 'The current page or page handle is closed. Preserve this session\'s browser, read the page list and select an existing page, then obtain a fresh observation and handles.'
    case 'closure-unverified': return 'A closure error was observed, but the browser root connection, page, and ownership remain unverified. Preserve the current owner and read the page catalog for new facts. No successful refresh, browser rebuild, or replay of the failed operation is established. An external connection must be checked and reactivated by its original owner.'
    case 'browser-closed':
    case 'browser-crashed': return 'Recover only the browser connection owned by this session. Read the page list after recovery; old page/uid/context handles cannot be reused, and the failed operation is not automatically replayed.'
    case 'sandbox-unavailable': return 'The Chromium sandbox for this session\'s browser is unavailable. A desktop window\'s sandbox state does not establish readiness. Fix the configured browser sandbox before reactivating this session.'
    case 'display-unavailable': return 'The display environment is unavailable to this session\'s browser. Reactivate the session in a valid display environment without expanding desktop permissions.'
    case 'profile-in-use': return 'The browser profile is in use. Preserve its directory and owner, check the isolated launch configuration, then reactivate this session.'
    case 'executable-unavailable': return 'The configured browser executable is unavailable. Check the actual installation and executable before reactivating this session.'
    case 'launch-failed': return 'Browser launch failed; this error does not establish target closure. Check the launch error and runtime environment before reactivating this session.'
    case 'transport-closed': return 'This session\'s browser MCP connection is unavailable. An exited MCP service was not automatically replaced. Check its status before reactivating this session.'
    case 'schema-unavailable': return 'The browser tool currently has no available schema. Use the tool catalog in this context and wait for this session\'s connection during recovery; do not guess parameters from historical tool names.'
    case 'release-unverified': return 'Release of the previous browser connection is unverified. Preserve its owner; no replacement connection was started. Confirm release before reactivating this session.'
  }
}

/**
 * Recognize one browser operation failure caused by a closed browser target.
 * @param error - value thrown by the provider tool call.
 * @returns the provider's message when the browser target is gone, otherwise undefined.
 */
export function browserTargetFailureReason(error: unknown, root?: BrowserRootObservation): string | undefined {
  const failure = browserRuntimeFailure(error, root)
  return failure?.recovery === 'rebuild' ? failure.reason : undefined
}

/**
 * Consecutive browser failures for one live Session before automatic rebuilds
 * stop. Fixed rather than configurable: the cap only bounds the case where the
 * MCP server starts but every browser target it reaches is already closed, so
 * each replacement process is doomed the same way and no deployment tuning
 * would help. A successful browser operation or a new activation starts over.
 */
const BROWSER_REBUILD_BUDGET = 3

/** A browser failure already observed and budgeted by this provider. */
class BrowserConnectionError extends Error {}

/**
 * Require the MCP connection owner to confirm transport closure before this
 * Session sheds ownership of its browser connection and process. Cordis fiber
 * teardown contains effect failures, and the connection's own dispose resolves
 * even when closure is unconfirmed, so only the owner's recorded outcome
 * settles release.
 * @param outcome - the connection owner's recorded disposal outcome.
 * @param name - provider name for the failure message.
 * @returns nothing when the owner confirmed transport closure.
 * @throws {BrowserConnectionError} when closure is unverified; the caller must
 *   keep the previous owner and must not start a replacement beside it.
 */
export function requireVerifiedRelease(outcome: ConnectionDisposal | undefined, name: string): void {
  if (outcome?.closed === true) return
  const detail = outcome?.reason ?? 'the MCP connection owner recorded no disposal outcome'
  throw new BrowserConnectionError(
    `${name}: this Session's browser connection and process could not be confirmed released (${detail}); the previous connection stays owned by this Session and no replacement was started.`,
  )
}

/** Validate the browser mode before the provider reserves browser use. */
export const BrowserMcpConfig: Schema<BrowserMcpAttachConfig | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean }), BrowserMcpConfig> = Schema.union([
  Schema.object({
    mode: Schema.const('launch').required(),
    headless: Schema.boolean().default(true),
    executablePath: Schema.string().pattern(/\S/u),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
  Schema.object({
    mode: Schema.const('attach').required(),
    endpoint: Schema.string().pattern(/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u).required(),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
])

/**
 * Reject an invalid debugging endpoint before acquiring provider or browser resources.
 * @param config - schema-validated browser selection.
 */
export function validateBrowserMcpConfig(config: BrowserMcpConfig): void {
  if (config.mode !== 'attach') return
  let endpoint: URL
  try {
    endpoint = new URL(config.endpoint)
  } catch (error) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL', { cause: error })
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || /\s/u.test(config.endpoint)) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL without whitespace')
  }
}

/** Provider-owned connection options for one live Session. */
export interface SessionMcpOptions {
  /** Provider identity and MCP tool namespace. */
  name: string
  /** Whether another live Session must wait for the attached browser to be released. */
  exclusive: boolean
  /** Executable used to start the installed MCP server. */
  command: string
  /** Arguments passed directly without a shell. */
  args: string[]
  /** Explicit overrides merged into the MCP client's scrubbed child environment. */
  env?: Record<string, string>
  /** Per-call timeout override; omission retains the MCP client default. */
  toolCallTimeoutMs?: number
  /** Read facts only from this generation's decorated Chrome MCP owner. */
  observeBrowserRoot?: boolean
}

interface ClientState {
  status: 'ready' | 'blocked'
  mask?: Scope
}

/**
 * Await one MCP client during each future Agent's creation.
 * A busy attachment leaves that activation without browser tools; its other turns continue.
 * Calls are serialized per Session; unload closes every server before releasing registration.
 * @param ctx - provider context supplying browser use, Agents, tools, and prompt assembly.
 * @param options - provider identity, attachment exclusivity, and executable configuration.
 */
export function mountSessionMcp(ctx: Context, options: SessionMcpOptions): void {
  let resources!: SessionResources<Scope>
  const clients = new Map<Agent, ClientState>()
  // Whether each Session currently has a mounted client, so a rebuild that could
  // not start is observed as a failure instead of a missing-tool mystery.
  const connections = new Map<Agent, { mounted: boolean; failure?: BrowserRuntimeFailure; observer?: BrowserRootObserver }>()
  const toolPrefix = `mcp__${options.name}__`
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  let stopping = false
  let refreshingMasks = false

  const refreshBlockedMasks = (): void => {
    if (stopping || refreshingMasks) return
    refreshingMasks = true
    try {
      for (const [agent, state] of clients) {
        if (state.status !== 'blocked') continue
        const inherited = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith(toolPrefix))
        if (inherited.length === 0) continue
        state.mask ??= createScope(ctx, agent)
        state.mask.ctx.tools.restrict({ deny: inherited.map(tool => tool.name) })
      }
    } finally {
      refreshingMasks = false
    }
  }

  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(options.name))
    resources = new SessionResources(ctx, {
      label: options.name,
      exclusive: options.exclusive,
      rebuildBudget: BROWSER_REBUILD_BUDGET,
      async open(agent, signal) {
        const scope = createScope(ctx, agent)
        let cancellation: Promise<void> | undefined
        const cancel = (): void => { cancellation = scope.dispose() }
        signal.addEventListener('abort', cancel, { once: true })
        const observer = options.observeBrowserRoot ? await BrowserRootObserver.create() : undefined
        const connection: { mounted: boolean; failure?: BrowserRuntimeFailure; observer?: BrowserRootObserver } = { mounted: false, ...observer ? { observer } : {} }
        connections.set(agent, connection)
        const clientConfig = McpClient.Config({
          transport: 'stdio',
          serverName: options.name,
          command: options.command,
          args: options.args,
          ...options.env === undefined ? {} : { env: options.env },
          ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd },
          ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
          failOnStartupError: true,
          reconnect: { enabled: false },
        })
        // The MCP client is remounted in place on a dead browser target: the scope,
        // its namespaced tools, and this Session's ownership entry all stay.
        let client: (PromiseLike<unknown> & { dispose: () => Promise<void>, ctx: Context }) | undefined
        let clientOwner: ReturnType<typeof McpClient.connectionHandleOf>
        let releasing: Promise<void> | undefined
        const mountClient = async (): Promise<void> => {
          const rootEnvironment = await observer?.begin()
          client = scope.ctx.plugin(McpClient, { ...clientConfig, ...rootEnvironment ? { env: { ...options.env, ...rootEnvironment } } : {} }) as unknown as typeof client
        }
        // One shared release: a cancellation awaits it as proof the old process
        // is gone, and a rebuild reuses it before mounting the replacement. The
        // client owner is dropped only after the MCP connection handle records a
        // confirmed transport closure, so an unverified release keeps the previous
        // owner and a replacement can never run beside a process that may live.
        const releaseClient = (): Promise<void> => {
          if (releasing !== undefined) return releasing
          const previous = client
          if (previous === undefined) return Promise.resolve()
          const owner = McpClient.connectionHandleOf(previous.ctx) ?? clientOwner
          releasing = previous.dispose().then(async () => {
            requireVerifiedRelease(owner?.disposal(), options.name)
            await observer?.verifyRelease()
            if (client === previous) {
              client = undefined
              connection.mounted = false
            }
          }).catch((error: unknown) => {
            connection.mounted = false
            connection.failure = { kind: 'release-unverified', recovery: 'blocked', reason: error instanceof Error ? error.message : String(error) }
            throw error
          }).finally(() => { releasing = undefined })
          return releasing
        }
        const owned: OwnedSessionResource<Scope> = {
          value: scope,
          async release() {
            await releaseClient()
          },
          async recycle() {
            await releaseClient()
            if (signal.aborted) return
            await mountClient()
            await client
            clientOwner = client === undefined ? undefined : McpClient.connectionHandleOf(client.ctx)
            signal.throwIfAborted()
            connection.mounted = true
          },
          async close() {
            clients.delete(agent)
            connection.mounted = false
            clientOwner ??= client === undefined ? undefined : McpClient.connectionHandleOf(client.ctx)
            await scope.dispose()
            if (client !== undefined || clientOwner !== undefined) {
              requireVerifiedRelease(clientOwner?.disposal(), options.name)
              await observer?.verifyRelease()
            }
            await observer?.dispose()
          },
        }
        try {
          signal.throwIfAborted()
          if (observer) scope.ctx.on('mcp/tool-call-metadata', exec => exec.agent === agent && exec.name.startsWith(toolPrefix) ? observer.metadata() : undefined)
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix)) return next()
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next()
              throw new Error(`${options.name}: browser tool belongs to another Session`)
            }
            return next()
          })
          await mountClient()
          await client
          clientOwner = client === undefined ? undefined : McpClient.connectionHandleOf(client.ctx)
          signal.throwIfAborted()
          connection.mounted = true
          return owned
        } catch (error) {
          connection.mounted = false
          try {
            await cancellation
            await owned.close()
          } catch (releaseError) {
            connection.failure = { kind: 'release-unverified', recovery: 'blocked', reason: releaseError instanceof Error ? releaseError.message : String(releaseError) }
            return { ...owned, acquisitionError: new AggregateError(
              [error, releaseError],
              `${options.name}: browser startup failed (${String(error)}); release is unverified (${String(releaseError)})`,
              { cause: error },
            ) }
          }
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    })
    yield async () => {
      stopping = true
      await resources.dispose()
      clients.clear()
      connections.clear()
    }
  }, `${options.name}.sessions`)
  ctx.on('agent/created', async ({ agent, signal }) => {
    const state: ClientState = { status: resources.available(agent) ? 'ready' : 'blocked' }
    agent.ctx.effect(() => async () => {
      clients.delete(agent)
      connections.delete(agent)
      await state.mask?.dispose()
    }, `${options.name}.activation`)
    if (state.status === 'blocked') {
      clients.set(agent, state)
      refreshBlockedMasks()
      return
    }
    await resources.get(agent, signal)
    clients.set(agent, state)
  }, { prepend: true })
  ctx.on('tools/change', refreshBlockedMasks)
  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { server?: unknown }).server === options.name
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    if (agent === undefined || clients.get(agent)?.status !== 'ready') {
      throw new Error(`${options.name}: browser tool belongs to another Session`)
    }
    // Only a real browser tool call counts as a browser operation. Discovery,
    // connection establishment, and MCP resource reads do not: Chrome often
    // starts, and reports a closed target, only on the first real call.
    const browserOperation = exec.name.startsWith(toolPrefix)
    const suspended = (health: SessionRebuildHealth): BrowserConnectionError => new BrowserConnectionError(
      `${options.name}: this Session's browser is suspended after ${health.failures} consecutive failures`
      + `${health.lastReason === undefined ? '' : ` (last: ${health.lastReason})`}. `
      + `Automatic restart was stopped so a failing browser cannot loop, and other tools are unaffected. `
      + `Fix the configured browser and then open or resume this Session as a new activation to probe again.`,
    )
    const lost = (reason: string, cause: unknown): BrowserConnectionError => new BrowserConnectionError(
      `${options.name}: the browser connection for this Session was lost (${reason}). `
      + `Recovery was requested and nothing else was stopped; `
      + `the next browser operation waits for the rebuild and then starts a fresh ${options.exclusive ? 'connection to the configured endpoint' : 'isolated browser'}. `
      + `Read the current page catalog first; previous page handles cannot be reused, and the failed operation was not replayed.`,
      { cause },
    )
    const failBrowser = (failure: BrowserRuntimeFailure, cause: unknown): never => {
      const connection = connections.get(agent)
      if (connection !== undefined) connection.failure = failure
      if (failure.recovery === 'select-page' || failure.kind === 'schema-unavailable') {
        throw new BrowserConnectionError(`${options.name}: [BROWSER_RUNTIME_${failure.kind.toUpperCase().replaceAll('-', '_')}] ${browserFailureAdvice(failure)} (${failure.reason})`, { cause })
      }
      const health = resources.reportFailure(agent, failure.reason, { rebuild: failure.recovery === 'rebuild' })
      if (failure.recovery === 'blocked') {
        throw new BrowserConnectionError(`${options.name}: [BROWSER_RUNTIME_${failure.kind.toUpperCase().replaceAll('-', '_')}] ${browserFailureAdvice(failure)} Only this session's browser is suspended; other tools are unaffected. (${failure.reason})`, { cause })
      }
      if (health === undefined) throw new BrowserConnectionError(`${options.name}: the browser connection for this Session was lost (${failure.reason}).`, { cause })
      if (health.suspended) throw suspended(health)
      throw lost(failure.reason, cause)
    }
    return resources.run(agent, exec.signal, async (_scope, combined) => {
      const original = exec.signal
      exec.signal = combined
      const observer = connections.get(agent)?.observer
      const before = await observer?.read()
      const operation = observer?.beginOperation()
      const classify = async (error: unknown) => {
        const fresh = await observer?.readForOperation(operation, before?.sequence ?? -1)
        return browserRuntimeFailure(error, fresh)
      }
      try {
        if (browserOperation) {
          const health = resources.health(agent)
          const blocked = connections.get(agent)?.failure
          if (blocked?.recovery === 'blocked') failBrowser(blocked, undefined)
          if (health?.suspended === true) {
            const failure = connections.get(agent)?.failure
            if (failure?.recovery === 'blocked') {
              throw new BrowserConnectionError(`${options.name}: [BROWSER_RUNTIME_${failure.kind.toUpperCase().replaceAll('-', '_')}] ${browserFailureAdvice(failure)} Only this session's browser is suspended; other tools are unaffected.`)
            }
            throw suspended(health)
          }
          if (!(connections.get(agent)?.mounted ?? false)) {
            // A rebuild that could not start left no live connection; count it so
            // repeated startup failures also stop at the budget.
            const observed = resources.reportFailure(agent, health?.lastReason ?? 'the browser connection is not mounted')
            if (observed?.suspended === true) throw suspended(observed)
            throw new BrowserConnectionError(
              `${options.name}: the browser connection for this Session is not mounted (${observed?.lastReason ?? 'rebuild failed'}); a fresh connection is starting, retry the browser operation.`,
            )
          }
          if (ctx.tools.get(exec.name, agent) === undefined) {
            throw new BrowserConnectionError(`${options.name}: [BROWSER_RUNTIME_SCHEMA_UNAVAILABLE] This tool currently has no available schema. Use the browser tool catalog in this context; do not guess parameters from historical names. Other tools can continue.`)
          }
        }
        const result = await next()
        // The tool runtime materializes a tool body failure as an isError result,
        // so a closed target is read from the result as well as from a throw.
        if (browserOperation) {
          if (result.isError) {
            const failure = await classify(result.error.message)
            if (failure !== undefined) failBrowser(failure, result.error)
          } else {
            // Only a real browser operation proves the resource works: discovery
            // and connection success deliberately do not reset the budget.
            resources.reportSuccess(agent)
            const connection = connections.get(agent)
            if (connection !== undefined) delete connection.failure
          }
        }
        return result
      } catch (error) {
        if (browserOperation && !(error instanceof BrowserConnectionError)) {
          const failure = await classify(error)
          if (failure !== undefined) failBrowser(failure, error)
        }
        throw error
      } finally {
        exec.signal = original
      }
    })
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const { agent } = context
    const recovering = agent !== undefined && clients.get(agent)?.status === 'ready' && resources.recovering(agent)
    const assembly = await next()
    if (agent !== undefined && clients.get(agent)?.status === 'ready') {
      if (recovering) {
        try {
          await resources.waitForRecovery(agent, context.signal)
        } catch (error) {
          // A browser-only failure must not suppress the remaining tool catalog.
          context.signal?.throwIfAborted()
          return { ...assembly, sections: [...assembly.sections, { name: `browser-runtime:${options.name}`, text: `${options.name}: Browser recovery for this session is incomplete. Its browser tool may have no available schema; other tools may continue.` }] }
        }
        // Assembly collected schemas before its waterfall. Recollect only after
        // this owner settled, rather than sending the remount gap to the model.
        return ctx.systemPrompt.assemble(context)
      }
      const failure = connections.get(agent)?.failure
      if (failure === undefined) return assembly
      return { ...assembly, sections: [...assembly.sections, { name: `browser-runtime:${options.name}`, text: `${options.name}: ${browserFailureAdvice(failure)} A mounted connection does not establish successful page operations. Continue using the current tool schema; Jobs, World, and other tools are unaffected by this session's browser recovery.` }] }
    }
    if (agent === undefined) return assembly
    return { ...assembly, sections: assembly.sections.filter(section => section.name !== `mcp:${options.name}`) }
  })
}
