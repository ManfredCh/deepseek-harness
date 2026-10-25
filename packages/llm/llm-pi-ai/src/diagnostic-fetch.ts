/** 每次原生adapter调用独占的公开wire观察；原HTTP/SSE字节与取消链原样交给pi-ai。 */
import { parseLlmFailureDiagnostic } from '@deepseek-ai/dsh-llm'
import type { LlmFailureDiagnostic } from '@deepseek-ai/dsh-llm'

export interface WireFailureDiagnostic { diagnostic?: LlmFailureDiagnostic; invalid: boolean; requestId?: string }

/** @returns 仅此stream使用的fetch和白名单读取，不替换global fetch或保存原body。 */
export function diagnosticFetch() {
  const value: WireFailureDiagnostic = { invalid: false }
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
    const response = await fetch(input, init)
    const id = response.headers.get('x-lyapunov-request-id')
    if (id && /^[A-Za-z0-9._:-]{1,128}$/.test(id) && !/^sk-/i.test(id)) value.requestId = id
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
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) { inspect(new Uint8Array(), true); reader.releaseLock(); controller.close(); return }
          inspect(next.value); controller.enqueue(next.value)
        } catch (error) { try { reader.releaseLock() } catch (_pendingRead) { /* 真reader仍决定锁可否释放。 */ }; controller.error(error) }
      },
      async cancel(reason) { try { await reader.cancel(reason) } finally { try { reader.releaseLock() } catch (_pendingRead) { /* 不伪造已释放。 */ } } },
    })
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    Object.defineProperties(wrapped, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } })
    return wrapped
  }
  return { fetch: fetcher, current: () => ({ ...value }) }
}
