import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const install = await realpath(process.argv[2]), output = process.argv[3]
const requireOld = createRequire(join(install, 'package.json'))
const codecPath = await realpath(requireOld.resolve('@deepseek-ai/dsh-session-format-catalog'))
assert(codecPath.startsWith(install + '/'), '必须使用独立旧发行读器')
const { sessionFormatCatalog } = await import(pathToFileURL(codecPath).href)
async function restore(name) {
  const [header, ...rows] = (await readFile(join(output, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return sessionFormatCatalog.decodeArtifact(header, rows)
}
const info = await restore('informational.jsonl')
assert(info.events.some(event => event.type === 'fixture/worktree-checkpoint' && event.ignorable === true))
let refused
try { await restore('undo.jsonl') } catch (error) { refused = String(error) }
assert.match(refused ?? '', /unknown event type.*session\/history-checkout/)
await writeFile(join(output, 'old-reader.json'), JSON.stringify({ status: 'PASS_OLD_READER_BOUNDARY', codecPath, informationalRetained: true, checkoutRequiredRejected: true, error: refused, modelRequests: 0 }, null, 2) + '\n')
console.log(JSON.stringify({ status: 'PASS_OLD_READER_BOUNDARY', output }))
