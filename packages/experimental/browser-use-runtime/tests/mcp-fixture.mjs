/** Private stdio browser fixture; each process owns independent state. */
import { appendFileSync, existsSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [root, mode] = process.argv.slice(2)
const record = (event, values = {}) => appendFileSync(join(root, 'events.ndjson'), JSON.stringify({ event, pid: process.pid, ...values }) + '\n')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
let counter = 0
let sequence = 0
let operation
const rootState = (rootConnected = true, released = false, neverStarted = false) => {
  if (!process.env.DSH_BROWSER_RUNTIME_STATE) return
  writeFileSync(process.env.DSH_BROWSER_RUNTIME_STATE, JSON.stringify({ owner: process.env.DSH_BROWSER_RUNTIME_OWNER, sequence: sequence++, operation, ownership: 'session', rootConnected, targetAlive: rootConnected, processExited: !rootConnected, released, neverStarted }))
}
record('start')
process.once('exit', () => { rootState(false, true); record('exit') })
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  switch (request.method) {
    case 'server/discover':
      record('probe')
      rootState(null, true, true)
      if (mode === 'fail') process.exit(1)
      if (mode === 'hold') return
      {
        const respond = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy browser fixture' } }) + '\n')
        if (mode === 'gate' && !existsSync(join(root, 'release'))) {
          const watcher = watch(root, () => {
            if (!existsSync(join(root, 'release'))) return
            watcher.close()
            respond()
          })
          if (existsSync(join(root, 'release'))) { watcher.close(); respond() }
        } else respond()
      }
      break
    case 'initialize':
      record('initialize')
      if (mode === 'fail') process.exit(1)
      if (mode === 'hold') return
      reply(request.id, {
        protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'browser-fixture', version: '1' }, instructions: 'BROWSER_FIXTURE_INSTRUCTION: use this Session browser.',
      })
      break
    case 'tools/list':
      reply(request.id, { tools: [
        { name: 'visit', description: 'Visit the fixture page.', inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } },
        { name: 'disconnect', description: 'Disconnect the fixture.', inputSchema: { type: 'object', properties: {} } },
      ] })
      break
    case 'tools/call':
      operation = request.params._meta?.['lyapunov/browser-operation']
      record('call', { name: request.params.name })
      rootState()
      if (request.params.name === 'disconnect') process.exit(0)
      if (request.params.name === 'visit' && mode === 'hold-call') return
      if (request.params.name === 'visit' && mode === 'target-closed' && !existsSync(join(root, 'recovered'))) {
        // The first browser target is already gone: report the provider's own
        // error once, then recover for every later process in this test.
        writeFileSync(join(root, 'recovered'), '')
        rootState(false)
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
          content: [{ type: 'text', text: 'Protocol error (Target.setDiscoverTargets): Target closed' }], isError: true,
        } }) + '\n')
        break
      }
      if (request.params.name === 'visit' && mode === 'target-closed-until-healthy' && !existsSync(join(root, 'healthy'))) {
        // Every fresh process reaches an already-closed target until the test
        // writes `healthy`: a crash loop that no replacement connection escapes.
        rootState(false)
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
          content: [{ type: 'text', text: 'Protocol error (Target.setDiscoverTargets): Target closed' }], isError: true,
        } }) + '\n')
        break
      }
      counter += 1
      reply(request.id, { content: [{ type: 'text', text: `Visit ${counter}: ${request.params.arguments.label}` }], structuredContent: { counter, pid: process.pid } })
      break
    case 'resources/list':
      record('resource', { name: request.method })
      reply(request.id, { resources: [{ uri: 'browser-fixture://state', name: 'Browser state' }] })
      break
    case 'resources/templates/list':
      record('resource', { name: request.method })
      reply(request.id, { resourceTemplates: [] })
      break
    case 'resources/read':
      record('resource', { name: request.method })
      reply(request.id, { contents: [{ uri: request.params.uri, text: JSON.stringify({ counter, pid: process.pid }) }] })
      break
    default:
      throw new Error(`Unexpected method ${request.method}`)
  }
})
