/** 从中央协议错误中保留公开事实；不携带供应商message、URL、认证或账本。 */
import type { LlmFailureDiagnostic } from './types.ts'

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
  return Object.freeze({ version: 1, domain: d.domain as LlmFailureDiagnostic['domain'], code: d.code, stage: d.stage,
    fieldPath, retryable: d.retryable, effect: d.effect as LlmFailureDiagnostic['effect'], requestId })
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
