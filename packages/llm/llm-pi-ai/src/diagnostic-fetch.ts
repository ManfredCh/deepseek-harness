/** 每次原生adapter调用独占的公开wire观察；原HTTP/SSE字节与取消链原样交给pi-ai。 */
import { createHash } from 'node:crypto'
import { parseLlmFailureDiagnostic } from '@deepseek-ai/dsh-llm'
import type { LlmFailureDiagnostic } from '@deepseek-ai/dsh-llm'

export interface WireFailureDiagnostic { diagnostic?: LlmFailureDiagnostic; invalid: boolean; requestId?: string }

/** 仅原 adapter 实例保存的 transport 数据；严禁写入公开诊断或持久化事件。 */
export interface WireContinuation {
  readonly url: string
  readonly method: string
  readonly body: string
  readonly bodySha256: string
  readonly headers: Headers
  readonly requestId: string
  readonly token: string
}

interface DiagnosticFetchOptions {
  /** 仅可信 product composition 的原 chat-completions POST 申请协议协商。 */
  readonly continuation?: boolean
  /** 原 Retry 已认领的本次内存续接，不允许第三次请求。 */
  readonly resume?: (url: string, method: string, headers: Headers, bodySha256: string) => WireContinuation
}

/** @returns 仅此stream使用的fetch和白名单读取；续接所需原POST仅留内存，不替换global fetch或写盘。 */
export function diagnosticFetch(options: DiagnosticFetchOptions = {}) {
  const value: WireFailureDiagnostic = { invalid: false }
  let continuation: WireContinuation | undefined
  let fetched = false
  const observe = (text: string) => {
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const root = parsed as Record<string, unknown>
      const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root
      if (error.diagnostic === undefined) return
      const diagnostic = parseLlmFailureDiagnostic(error.diagnostic)
      if (diagnostic) value.diagnostic = diagnostic
      else value.invalid = true
    } catch (_nonJsonSseData) { /* 普通模型流不是错误诊断，不从文本猜副作用。 */ }
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const body = init?.body
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const resume = options.resume === undefined ? undefined : typeof body === 'string'
      ? options.resume(url, method, headers, createHash('sha256').update(body).digest('hex')) : undefined
    if (options.resume && !resume) throw new Error('CENTRAL_CONTINUATION_BINDING_INVALID')
    let requestInit = init
    if (resume) {
      if (fetched || method !== resume.method || url !== resume.url || headers.get('authorization') !== resume.headers.get('authorization')) {
        throw new Error('CENTRAL_CONTINUATION_BINDING_INVALID')
      }
      fetched = true
      const resumeHeaders = new Headers(resume.headers)
      resumeHeaders.set('x-lyapunov-continuation', '1')
      resumeHeaders.set('x-lyapunov-resume-request', resume.requestId)
      resumeHeaders.set('x-lyapunov-resume-attempt', '1')
      resumeHeaders.set('x-lyapunov-resume-token', resume.token)
      resumeHeaders.set('x-lyapunov-body-sha256', resume.bodySha256)
      requestInit = { ...init, method: resume.method, body: resume.body, headers: resumeHeaders }
    } else if (options.continuation && method === 'POST' && typeof body === 'string' && /\/chat\/completions$/.test(new URL(url).pathname)) {
      // 完整 pi-ai 序列化 POST 原字节只保存在此 stream 的闭包，续接时绝不重新拼历史。
      headers.set('x-lyapunov-continuation', '1')
      requestInit = { ...init, headers }
    }
    const response = await fetch(input, requestInit)
    const id = response.headers.get('x-lyapunov-request-id')
    if (id && /^[A-Za-z0-9._:-]{1,128}$/.test(id) && !/^sk-/i.test(id)) value.requestId = id
    const token = response.headers.get('x-lyapunov-resume-token')
    if (!resume && options.continuation && response.ok && !response.redirected && response.headers.get('x-lyapunov-continuation') === '1'
      && requestInit?.method === 'POST' && typeof body === 'string' && value.requestId && token && /^[a-f0-9]{64}$/.test(token)
      && /\/chat\/completions$/.test(new URL(url).pathname)) {
      continuation = { url, method, body, bodySha256: createHash('sha256').update(body).digest('hex'),
        headers: new Headers(requestInit.headers), requestId: value.requestId, token }
    }
    if (!response.body) return response
    const sse = response.headers.get('content-type')?.includes('text/event-stream') === true
    if (!sse && response.ok) return response
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', skipping = false
    const inspect = (bytes: Uint8Array, final = false) => {
      const text = decoder.decode(bytes, { stream: !final })
      // 只保留一个最多64KiB事件；正常内容不落盘，越界丢观察且不影响原流。
      if (!sse) { if (new TextEncoder().encode(buffer).byteLength + new TextEncoder().encode(text).byteLength <= 65536) buffer += text; else skipping = true; if (final && !skipping) observe(buffer); return }
      buffer += text
      let boundary: number
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const match = buffer.slice(boundary).match(/^\r?\n\r?\n/)!
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + match[0].length)
        if (!skipping && new TextEncoder().encode(block).byteLength <= 65536) observe(block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
        skipping = false
      }
      if (new TextEncoder().encode(buffer).byteLength > 65536) { buffer = ''; skipping = true }
    }
    const observedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) { inspect(new Uint8Array(), true); reader.releaseLock(); controller.close(); return }
          inspect(next.value); controller.enqueue(next.value)
        } catch (error) { try { reader.releaseLock() } catch (_pendingRead) { /* 真reader仍决定锁可否释放。 */ }; controller.error(error) }
      },
      async cancel(reason) { try { await reader.cancel(reason) } finally { try { reader.releaseLock() } catch (_pendingRead) { /* 不伪造已释放。 */ } } },
    })
    const wrapped = new Response(observedBody, { status: response.status, statusText: response.statusText, headers: response.headers })
    Object.defineProperties(wrapped, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } })
    return wrapped
  }
  return { fetch: fetcher, current: () => ({ ...value }),
    continuation: () => {
      const summary = value.diagnostic?.continuation
      return !value.invalid && summary && continuation && summary.requestId === continuation.requestId
        && summary.bodySha256 === continuation.bodySha256 ? continuation : undefined
    },
  }
}
