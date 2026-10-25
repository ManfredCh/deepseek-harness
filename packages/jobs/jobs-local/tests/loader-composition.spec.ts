import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('jobs-local through a real Loader composition', () => {
  it('applies the provider-owned admission config from a Cordis row', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jobs-local-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-jobs-local'",
      '  config:',
      '    maxConcurrentJobsPerOwner: 1',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-jobs-local') return LocalJobRegistry
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.jobs).toBeInstanceOf(LocalJobRegistry)
    const detachController = context.jobs.attachController('loader-test')
    const claims: boolean[] = []
    context.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled') claims.push(event.claimReport())
    })
    context.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled') claims.push(event.claimReport())
    })
    let settle!: (outcome: { status: 'killed' }) => void
    const id = context.jobs.start({
      kind: 'bash',
      label: 'hold loader slot',
      run: (job) => {
        job.append('loader output')
        return {
          cancel: () => { settle({ status: 'killed' }) },
          done: new Promise((resolve) => { settle = resolve }),
        }
      },
    })
    const identity = context.jobs.get(id)
    expect(identity.registryId).toEqual(expect.any(String))
    expect(context.jobs.readAt(id, 0).chunks.map(chunk => chunk.text).join('')).toBe('loader output')
    expect(() => context!.jobs.start({
      kind: 'bash',
      label: 'blocked loader job',
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
    })).toThrow('(limit: 1)')
    detachController()
    expect(context.jobs.get(id)).toEqual(identity)
    settle({ status: 'killed' })
    await context.jobs.wait(id, 1_000)
    expect(claims).toEqual([false, false])
    expect(context.jobs.read(id).chunks.map(chunk => chunk.text).join('')).toBe('loader output')
  })
})
