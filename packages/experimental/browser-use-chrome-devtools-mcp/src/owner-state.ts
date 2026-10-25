/** Structural Chrome owner facts; no URLs, page contents, headers or credentials. @module */
export interface OwnedBrowserProcess {
  exitCode: number | null
  signalCode: string | null
  once(event: 'exit', listener: () => void): unknown
  off(event: 'exit', listener: () => void): unknown
}
export interface ObservedBrowser {
  connected: boolean
  process(): OwnedBrowserProcess | null
  close(): Promise<void>
  disconnect(): Promise<void>
}
export interface ObservedContext {
  browser: ObservedBrowser
  getSelectedMcpPage(): { pptrPage: { isClosed(): boolean } }
  getPageById(id: number): { pptrPage: { isClosed(): boolean } }
}
export function observeBrowserRoot(context: ObservedContext | undefined, browser: ObservedBrowser | undefined, pageId?: number) {
  let targetAlive: boolean | null = null
  if (context) {
    try { const closed = (pageId === undefined ? context.getSelectedMcpPage() : context.getPageById(pageId)).pptrPage.isClosed(); targetAlive = typeof closed === 'boolean' ? !closed : null }
    catch { targetAlive = null }
  }
  let rootConnected: boolean | null = null, processExited: boolean | null = null, exitCode: number | null = null, signalCode: string | null = null
  try { if (typeof browser?.connected === 'boolean') rootConnected = browser.connected } catch { /* unknown */ }
  try {
    const process = browser?.process()
    if (process) {
      const code = process.exitCode, signal = process.signalCode
      if (code === null || typeof code === 'number') exitCode = code
      if (signal === null || typeof signal === 'string') signalCode = signal
      if ((code === null || typeof code === 'number') && (signal === null || typeof signal === 'string')) processExited = code !== null || signal !== null
    }
  } catch { /* unknown */ }
  return { rootConnected, targetAlive, processExited, exitCode, signalCode }
}
/** Only the captured launch owner may close a process; external roots only disconnect. */
export async function releaseBrowserRoots(browsers: readonly ObservedBrowser[], external: boolean, timeoutMs = 3500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanups: (() => void)[] = []
  const release = async () => {
    for (const browser of browsers) {
      if (external) { await browser.disconnect(); if (browser.connected) return false; continue }
      const process = browser.process()
      if (!process) return false
      if (process.exitCode !== null || process.signalCode !== null) {
        if (browser.connected) await browser.disconnect()
        if (browser.connected) return false
        continue
      }
      let done!: () => void
      const exited = new Promise<void>(resolve => { done = resolve })
      process.once('exit', done)
      cleanups.push(() => process.off('exit', done))
      try {
        await browser.close()
        if (process.exitCode === null && process.signalCode === null) await exited
        if (process.exitCode === null && process.signalCode === null) return false
        if (browser.connected) await browser.disconnect()
        if (browser.connected) return false
      } finally { process.off('exit', done) }
    }
    return true
  }
  try { return await Promise.race([release(), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })]) }
  catch { return false } finally { clearTimeout(timer); for (const cleanup of cleanups) cleanup() }
}
