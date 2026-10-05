/** The pinned upstream stdio server with this Session's root observation/release owner. @module */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { observeBrowserRoot, releaseBrowserRoots, type ObservedBrowser, type ObservedContext } from './owner-state.ts'

const owner = process.env.DSH_BROWSER_RUNTIME_OWNER
const statePath = process.env.DSH_BROWSER_RUNTIME_STATE
if (!owner || !statePath) throw new Error('browser runtime owner metadata is required')
const base = new URL('../', import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
const pinned = new Map([
  ['McpContext.js', '39e41d2e578aa983fa7a3ded08ac9438af7dd8423a29829f746c0fe9e9cb70b3'],
  ['ToolHandler.js', '49dd8d88257394e778573e3449af6e03fdc2fab73cc8370af26205aeecd8ab7d'],
  ['index.js', '793dd988623744d46395e586500b5405fd17694cc4bef98d6593bee01563374a'],
  ['third_party/index.js', 'fc6ae43cb8f6007eba4b0f269290ec8fea6db7670686d17967b4812d90d2cc10'],
])
for (const [file, digest] of pinned) {
  if (createHash('sha256').update(readFileSync(new URL(file, base))).digest('hex') !== digest) throw new Error('pinned Chrome 1.9.0 owner SPI hash mismatch: ' + file)
}
const moduleAt = (name: string): Promise<any> => import(new URL(name, base).href)
const [{ McpServer, logDisclaimers }, { McpContext }, { ToolHandler }, { StdioServerTransport, McpServer: NativeSdkServer, puppeteer }, { parseArguments }, { VERSION }] = await Promise.all([
  moduleAt('index.js'), moduleAt('McpContext.js'), moduleAt('ToolHandler.js'), moduleAt('third_party/index.js'), moduleAt('config/mcp-options.js'), moduleAt('version.js'),
])
if (typeof McpContext.from !== 'function' || typeof ToolHandler.prototype.handle !== 'function' || typeof NativeSdkServer.prototype.registerTool !== 'function') throw new Error('pinned Chrome owner interface is unavailable')
const args = parseArguments(VERSION)
const external = Boolean(args.browserUrl || args.wsEndpoint || args.autoConnect)
if (!external && args.isolated !== true) throw new Error('browser runtime requires an isolated launch owner')
let context: ObservedContext | undefined, browser: ObservedBrowser | undefined, sequence = 0, attempted = false
const nativeLaunch = puppeteer.launch, nativeConnect = puppeteer.connect
puppeteer.launch = function (...args: unknown[]) { attempted = true; return nativeLaunch.apply(this, args) }
puppeteer.connect = function (...args: unknown[]) { attempted = true; return nativeConnect.apply(this, args) }
const browsers = new Set<ObservedBrowser>()
const operation = new AsyncLocalStorage<string>()
const write = (pageId?: number, released?: boolean, marker?: string) => {
  const facts = observeBrowserRoot(context, browser, pageId)
  const row = { owner, sequence: sequence++, ownership: external ? 'external' : 'session', ...facts, neverStarted: !attempted,
    ...marker ? { operation: marker } : {},
    ...released === undefined ? {} : { released } }
  writeFileSync(statePath + '.next', JSON.stringify(row), { mode: 0o600 }); renameSync(statePath + '.next', statePath)
}
// Capture the actual browser before context initialization can itself fail.
const from = McpContext.from
McpContext.from = async function (actual: ObservedBrowser, ...rest: unknown[]) {
  browser = actual; browsers.add(actual)
  const result = await from.call(this, actual, ...rest); context = result; return result
}
const handle = ToolHandler.prototype.handle
ToolHandler.prototype.handle = async function (params: { pageId?: number }) {
  const marker = operation.getStore()
  const error = (text: string) => ({ content: [{ type: 'text', text }], isError: true })
  try {
    // Let the pinned handler return its existing disabled/argument error unchanged.
    if (this.disabledReason || this.unknownArgumentNames(params).length) return await handle.call(this, params)
    // Preserve Session/tools startup, but never scan other processes for DISPLAY.
    if (!external && process.platform === 'linux' && !args.headless && !process.env.DISPLAY) return error('Missing X server: this pinned Chrome MCP headed launch requires configured DISPLAY')
    // The native lazy launcher must not silently replace a disconnected or unknown root.
    if (browser?.connected === false) return error('Browser has been closed; await this Session owner release before replacement')
    if (attempted && !browser) return error('BROWSER_ROOT_UNVERIFIED: previous launch/connect did not expose a verifiable browser root; no replacement was started')
    return await handle.call(this, params)
  }
  finally { try { write(typeof params.pageId === 'number' ? params.pageId : undefined, undefined, marker) } catch { /* Diagnosis must never alter a completed operation's result. */ } }
}
const register = NativeSdkServer.prototype.registerTool
NativeSdkServer.prototype.registerTool = function (name: string, config: unknown, callback: (...args: any[]) => unknown) {
  return register.call(this, name, config, (params: unknown, extra: { _meta?: Record<string, unknown> }) => {
    const meta = extra?._meta
    const marker = meta?.['lyapunov/browser-owner'] === owner && typeof meta?.['lyapunov/browser-operation'] === 'string' ? meta['lyapunov/browser-operation'] : ''
    return operation.run(marker, () => callback(params, extra))
  })
}
write()
const server = await McpServer.from(args)
await server.connect(new StdioServerTransport())
logDisclaimers(args)
let shutdown: Promise<void> | undefined
const stop = () => {
  shutdown ??= (async () => {
    const released = (!attempted || browsers.size > 0) && await releaseBrowserRoots([...browsers], external)
    write(undefined, released)
    await server.close()
    process.exit(released ? 0 : 1)
  })().catch(() => { try { write(undefined, false) } finally { process.exit(1) } })
}
process.stdin.on('end', stop); process.stdin.on('close', stop)
process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', stop)
