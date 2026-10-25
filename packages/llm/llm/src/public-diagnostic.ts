/** 从中央协议错误中保留公开事实；不携带供应商message、URL、认证或账本。 */
import type { LlmContinuationSummary, LlmFailure, LlmFailureDiagnostic } from './types.ts'

/** @param value - wire或持久化诊断值。 @returns 白名单诊断或无效。 */
export function parseLlmFailureDiagnostic(value: unknown): LlmFailureDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const d = value as Record<string, unknown>
  if (d.version !== 1 || typeof d.domain !== 'string' || !['account', 'model', 'search', 'generation', 'resource'].includes(d.domain)
    || typeof d.code !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(d.code)
    || typeof d.stage !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(d.stage)
    || typeof d.retryable !== 'boolean' || typeof d.effect !== 'string' || !['none', 'released', 'reserved', 'charged', 'unknown'].includes(d.effect)) return undefined
  const fieldPath = d.fieldPath === null ? null : typeof d.fieldPath === 'string' && d.fieldPath.length <= 128
    && /^[A-Za-z_][A-Za-z0-9_.\[\]]*$/.test(d.fieldPath) ? d.fieldPath : undefined
  const requestId = d.requestId === null ? null : typeof d.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(d.requestId)
    && !/^sk-/i.test(d.requestId) ? d.requestId : undefined
  if (fieldPath === undefined || requestId === undefined) return undefined
  const continuation = d.continuation === undefined ? undefined : parseLlmContinuation(d.continuation)
  if (d.continuation !== undefined && (!continuation || d.domain !== 'model'
    || requestId !== continuation.requestId || !['upstream_stream', 'upstream_headers', 'upstream_response'].includes(d.stage) || !['TIMEOUT', 'TRANSPORT'].includes(d.code)
    || d.retryable !== false || d.effect !== 'reserved')) return undefined
  return Object.freeze({ version: 1, domain: d.domain as LlmFailureDiagnostic['domain'], code: d.code, stage: d.stage,
    fieldPath, retryable: d.retryable, effect: d.effect as LlmFailureDiagnostic['effect'], requestId,
    ...continuation === undefined ? {} : { continuation } })
}

/** pi-ai保留parsed API错误为JSON文字；只解有限对象，不从普通文案猜账务。 */
export function diagnosticFromProviderError(message: string): { diagnostic?: LlmFailureDiagnostic; invalid: boolean } {
  if (message.length > 65536) return { invalid: message.includes('"diagnostic"') }
  const start = message.indexOf('{'), end = message.lastIndexOf('}')
  if (start < 0 || end < start) return { invalid: false }
  try {
    const parsed: unknown = JSON.parse(message.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { invalid: false }
    const root = parsed as Record<string, unknown>
    const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root
    if (error.diagnostic === undefined) return { invalid: false }
    const diagnostic = parseLlmFailureDiagnostic(error.diagnostic)
    return { ...diagnostic ? { diagnostic } : {}, invalid: diagnostic === undefined }
  } catch (_invalidProviderJson) { return { invalid: message.includes('"diagnostic"') } }
}

/** 严格验证单次同请求摘要；额外字段也不进入公开事件。 */
export function parseLlmContinuation(value: unknown): LlmContinuationSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const c = value as Record<string, unknown>
  if (Object.keys(c).length !== 4 || !['version', 'requestId', 'attempt', 'bodySha256'].every(key => Object.hasOwn(c, key))
    || c.version !== 1 || c.attempt !== 1 || typeof c.requestId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(c.requestId) || /^sk-/i.test(c.requestId)
    || typeof c.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.bodySha256)) return undefined
  return Object.freeze({ version: 1, requestId: c.requestId, attempt: 1, bodySha256: c.bodySha256 })
}

/** 原调用系列的进程内路由身份，不携带凭证或请求正文。 */
export interface LlmContinuationBinding {
  readonly adapter: object
  readonly model: string
  readonly diagnostic: LlmFailureDiagnostic
}

interface LiveContinuation {
  readonly provider: string
  readonly summary: LlmContinuationSummary
  readonly claim: () => boolean
  readonly expiresAt: number
  readonly binding?: LlmContinuationBinding
  armed: boolean
  cleanup: () => void
}
// 原 live finish 经 AssistantStreamAccumulator JSON 快照复制，不能用 failure 身份认领。
// 原 callerSignal 在 adapter、AgentLoop 和 Retry 中不复制；仅这个内存边界拥有能力。
const liveContinuations = new WeakMap<AbortSignal, Map<string, LiveContinuation>>()
const continuationKey = (provider: string, summary: LlmContinuationSummary): string => JSON.stringify([provider, summary.requestId, summary.attempt, summary.bodySha256])

/** 原 transport 注册一次内存能力；不会把回调或凭证混入公开 failure。 */
export function registerLlmContinuation(
  signal: AbortSignal,
  provider: string,
  summary: LlmContinuationSummary,
  claim: () => boolean,
  binding?: LlmContinuationBinding,
): () => void {
  const key = continuationKey(provider, summary)
  const entries = liveContinuations.get(signal) ?? new Map<string, LiveContinuation>()
  entries.get(key)?.cleanup()
  const value: LiveContinuation = { provider, summary, claim, expiresAt: Date.now() + 60_000, ...binding === undefined ? {} : { binding }, armed: false, cleanup: () => {} }
  entries.set(key, value)
  liveContinuations.set(signal, entries)
  const clear = () => {
    if (entries.get(key) === value) entries.delete(key)
    if (entries.size === 0 && liveContinuations.get(signal) === entries) liveContinuations.delete(signal)
    signal.removeEventListener('abort', clear)
    clearTimeout(timer)
  }
  value.cleanup = clear
  // 过期仅取消尚未认领的许可；已armed原series必须保留绑定护栏，不能恢复成fresh收费。
  const timer = setTimeout(() => { if (!value.armed) clear() }, 60_000)
  timer.unref?.()
  if (signal.aborted) clear()
  else signal.addEventListener('abort', clear, { once: true })
  return clear
}

/** 原 Retry 只允许匹配本次 live transport 的公开摘要认领一次。 */
export function claimLlmContinuation(failure: LlmFailure, provider: string, signal: AbortSignal): boolean {
  const diagnostic = parseLlmFailureDiagnostic(failure.diagnostic)
  const summary = diagnostic?.continuation
  if (!summary) return false
  const entries = liveContinuations.get(signal)
  const value = entries?.get(continuationKey(provider, summary))
  if (value === undefined || value.armed) return false
  if (signal.aborted || Date.now() >= value.expiresAt) { value.cleanup(); return false }
  if (!value.claim()) { value.cleanup(); return false }
  // JSON 诊断只能认领一次，但同一原调用系列在消费前仍须保留路由护栏。
  value.armed = true
  return true
}

/** 原 Runtime 在重新选 adapter 前核对已认领系列；无 armed 能力的调用不受影响。 */
export function llmContinuationBindingFailure(
  signal: AbortSignal | undefined,
  provider: string,
  model: string,
  adapter: object | undefined,
): LlmFailureDiagnostic | undefined {
  if (signal === undefined || signal.aborted) return undefined
  const entries = liveContinuations.get(signal)
  if (entries === undefined) return undefined
  for (const entry of entries.values()) if (!entry.armed && Date.now() >= entry.expiresAt) entry.cleanup()
  const armed = [...entries.values()].filter(value => value.armed && value.binding !== undefined)
  if (armed.length === 0) return undefined
  const value = armed[0]!
  if (armed.length === 1 && Date.now() < value.expiresAt && value.provider === provider && value.binding!.model === model && value.binding!.adapter === adapter) return undefined
  const { continuation: _usedContinuation, ...facts } = value.binding!.diagnostic
  return facts
}
