/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { createHash } from 'node:crypto'
import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  registerLlmContinuation,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmFailureDiagnostic,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { requestImageTarget, toPiContext } from './context.ts'
import { conversationUpdates, createModels, getSupportedThinkingLevels } from './models.ts'
import { toStreamChunks } from './stream.ts'
import { diagnosticFetch } from './diagnostic-fetch.ts'
import type { WireContinuation } from './diagnostic-fetch.ts'
import { sameManagedEndpoint } from './managed-discovery.ts'

interface PendingContinuation {
  readonly snapshot: PiAiSnapshot
  readonly provider: string
  readonly model: string
  readonly requestInputSha256: string
  readonly wire: WireContinuation
  readonly diagnostic: LlmFailureDiagnostic
  readonly expiresAt: number
  armed: boolean
  cleanup: () => void
}

/** 续接用完后只保留原副作用事实，不能恢复出第三次认领能力。 */
function withoutContinuation(diagnostic: LlmFailureDiagnostic): LlmFailureDiagnostic {
  const { continuation: _usedContinuation, ...facts } = diagnostic
  return facts
}

/**
 * Initially active declaration added to an Anthropic request whose projected
 * tools are all deferred, because Anthropic rejects a tool list without one.
 */
const ANTHROPIC_TOOL_UPDATE_PLACEHOLDER: ToolSchema = {
  name: 'DeferredToolPlaceholder',
  description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.',
  parameters: { type: 'object', properties: {} },
}

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Check the exact frozen endpoint before any credential or network access. */
  assertModel?: (provider: string, baseURL: string) => void
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call, and by `listModels`, which offers no
   * models while it throws `MISSING_CREDENTIAL`. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined
  // 原 callerSignal 是单个 AgentLoop 请求系列的内存边界；无需新 Session/Graph 状态。
  private readonly continuations = new WeakMap<AbortSignal, Map<string, PendingContinuation>>()

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) {
    const snapshot = this.current()
    this.modelOf(snapshot, provider, model)
    const profile = this.profileOf(snapshot, provider)
    return requestImageTarget(image, { maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes })
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(async () => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      try { await this.config.resolveApiKey(provider, profile) }
      catch (error) {
        // A route whose named key does not resolve cannot serve a request, so it offers no models until the key is stored.
        if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
        throw error
      }
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
      ...conversationUpdates(resolvedModel),
    }
  }

  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    const armed = [...(signal === undefined ? undefined : this.continuations.get(signal))?.values() ?? []].filter(value => value.armed)
    if (armed.length > 0 && (armed.length !== 1 || armed[0]!.provider !== provider || armed[0]!.model !== model || armed[0]!.snapshot !== snapshot || Date.now() >= armed[0]!.expiresAt)) {
      throw new LlmError('Central continuation binding changed; reconcile the original request before resubmitting.',
        'CENTRAL_CONTINUATION_BINDING_INVALID', { diagnostic: withoutContinuation(armed[0]!.diagnostic) })
    }
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
  ): AsyncIterable<StreamChunk> {
    const continuationEntries = options.signal === undefined ? undefined : this.continuations.get(options.signal)
    const armed = [...continuationEntries?.values() ?? []].filter(value => value.armed)
    // 已认领能力属于原请求，不能先按新输入过滤掉它，再把续接悄悄变成新收费请求。
    // 没有 armed 能力时，同一取消信号下的不同独立输入仍按原路径执行。
    const requestInputSha256 = createHash('sha256').update(JSON.stringify({
      provider: options.provider, model: options.model, messages: options.messages, tools: options.tools,
      temperature: options.temperature, maxTokens: options.maxTokens, reasoningEffort: options.reasoningEffort,
      sessionId: options.sessionId, stop: options.stop,
    })).digest('hex')
    if (armed.length > 0 && (armed.length !== 1 || armed[0]!.provider !== options.provider
      || armed[0]!.model !== options.model || armed[0]!.requestInputSha256 !== requestInputSha256 || armed[0]!.snapshot !== snapshot || Date.now() >= armed[0]!.expiresAt)) {
      throw new LlmError('Central continuation input or binding changed; reconcile the original request before resubmitting.',
        'CENTRAL_CONTINUATION_BINDING_INVALID', { diagnostic: withoutContinuation(armed[0]!.diagnostic) })
    }
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // 原配置快照、模型与凭据依然在任何网络访问之前绑定。
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const updates = conversationUpdates(model)
    // pi-ai collapses Anthropic tool updates without an initially active declaration.
    const tools = options.tools ?? []
    const needsPlaceholder = model.api === 'anthropic-messages' && updates.toolUpdate === 'in-history'
      && tools.every(tool => tool.deferLoading === true)
      && options.messages.some(message => message.role === 'developer'
        && message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal'))
    const request = needsPlaceholder
      ? { ...options, tools: [ANTHROPIC_TOOL_UPDATE_PLACEHOLDER, ...tools] }
      : options
    this.config.assertModel?.(options.provider, model.baseUrl)
    const reasoning = resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)
    const pending = [...continuationEntries?.values() ?? []].filter(value => value.provider === options.provider && value.model === options.model && value.requestInputSha256 === requestInputSha256)
    let resume: PendingContinuation | undefined
    let resumeBindingRejected = false
    const selectResume = pending.length === 0 ? undefined : (url: string, method: string, headers: Headers, generatedBodySha256: string): WireContinuation => {
      const armed = pending.filter(value => value.armed)
      const value = armed.length === 1 ? armed[0] : undefined
      if (!value || options.signal?.aborted || value.snapshot !== snapshot || Date.now() >= value.expiresAt
        || value.wire.url !== url || value.wire.method !== method || value.wire.bodySha256 !== generatedBodySha256
        || value.wire.headers.get('authorization') !== headers.get('authorization')) {
        resumeBindingRejected = true
        throw new LlmError('Central continuation binding expired or changed; the original request remains unresolved.',
          'CENTRAL_CONTINUATION_BINDING_INVALID', { diagnostic: withoutContinuation(pending[0]!.diagnostic) })
      }
      resume = value
      value.cleanup()
      return value.wire
    }
    let apiKey: string | undefined
    try { apiKey = await this.config.resolveApiKey(options.provider, profile) } catch (error) {
      if (armed.length > 0) throw new LlmError('Central continuation credentials could not be verified; reconcile the original request before resubmitting.',
        'CENTRAL_CONTINUATION_BINDING_INVALID', { cause: error, diagnostic: withoutContinuation(armed[0]!.diagnostic) })
      throw error
    }

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(request, undefined, onReplayDegrade)
        : await toPiContext({ ...request, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade)
      const diagnostic = diagnosticFetch({
        continuation: model.api === 'openai-completions' && sameManagedEndpoint(profile.managedBaseURL, model.baseUrl),
        ...selectResume === undefined ? {} : { resume: selectResume },
      })
      const events = snapshot.models.streamSimple(model, context, {
        fetch: diagnostic.fetch,
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id, diagnostic.current)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          if (result.done) {
            exhausted = true
            return
          }
          const chunk = result.value
          if (!resume && chunk.type === 'finish' && chunk.reason.kind === 'error' && options.signal) {
            const wire = diagnostic.continuation()
            const summary = chunk.reason.failure.diagnostic?.continuation
            if (wire && summary && !options.signal.aborted) {
              const signal = options.signal
              const continuationKey = JSON.stringify([options.provider, options.model, summary.requestId, summary.bodySha256])
              const value: PendingContinuation = {
                snapshot, provider: options.provider, model: options.model, requestInputSha256, wire,
                diagnostic: chunk.reason.failure.diagnostic!, expiresAt: Date.now() + 60_000,
                armed: false, cleanup: () => {},
              }
              const cancel = () => {
                cleanup()
                // 用户停止只撤销中央现有 lease；沿原 Auth/完整 POST，不发新生成或预留。
                const headers = new Headers(wire.headers)
                headers.set('x-lyapunov-resume-control', 'cancel')
                headers.set('x-lyapunov-resume-request', wire.requestId)
                headers.set('x-lyapunov-resume-attempt', '1')
                headers.set('x-lyapunov-resume-token', wire.token)
                headers.set('x-lyapunov-body-sha256', wire.bodySha256)
                void fetch(wire.url, { method: wire.method, body: wire.body, headers, signal: AbortSignal.timeout(5_000) })
                  .then(response => response.body?.cancel()).catch(() => {})
              }
              const clearRegistration = registerLlmContinuation(signal, options.provider, summary, () => {
                if (signal.aborted || this.continuations.get(signal)?.get(continuationKey) !== value || value.armed
                  || snapshot.profiles !== this.config.profiles() || Date.now() >= value.expiresAt) return false
                value.armed = true
                return true
              }, { adapter: this, model: options.model, diagnostic: chunk.reason.failure.diagnostic! })
              const cleanup = () => {
                const entries = this.continuations.get(signal)
                if (entries?.get(continuationKey) === value) entries.delete(continuationKey)
                if (entries?.size === 0) this.continuations.delete(signal)
                clearRegistration()
                signal.removeEventListener('abort', cancel)
                clearTimeout(timer)
              }
              // 已认领后保留同series绑定，即使许可到期也只能拒绝，不得fallback为fresh请求。
              const timer = setTimeout(() => { if (!value.armed) cleanup() }, 60_000)
              timer.unref?.()
              value.cleanup = cleanup
              const entries = this.continuations.get(signal) ?? new Map<string, PendingContinuation>()
              entries.get(continuationKey)?.cleanup()
              entries.set(continuationKey, value)
              this.continuations.set(signal, entries)
              signal.addEventListener('abort', cancel, { once: true })
            }
          }
          // 缺少新的诊断时，已认领请求的后续失败仍保留原 reserved/unknown 门。
          // 不允许 generic timeout 再建立第三个付费请求。
          if ((resume || pending.length > 0) && chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
            && chunk.reason.failure.diagnostic === undefined) {
            yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure,
              code: resumeBindingRejected ? 'CENTRAL_CONTINUATION_BINDING_INVALID' : chunk.reason.failure.code,
              diagnostic: withoutContinuation((resume ?? pending[0])!.diagnostic) } } }
          } else yield chunk
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          // A demand the deadline abandoned can stay pending forever, and this
          // generator queues its return behind it; the abort above owns SDK termination.
          /* v8 ignore next -- the detached drain only rejects while unwinding an abandoned stream. */
          void iterator.return(undefined).catch(() => {})
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error, ...resume ? { diagnostic: withoutContinuation(resume.diagnostic) } : {} })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      if (resume?.diagnostic || pending.length > 0) throw new LlmError('Central continuation failed; reconcile the original request before resubmitting.', 'CENTRAL_CONTINUATION_FAILED', { cause: error, diagnostic: withoutContinuation((resume ?? pending[0])!.diagnostic) })
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
