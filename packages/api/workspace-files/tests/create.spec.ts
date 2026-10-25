import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceFiles } from '../src/index.ts'

let directory: string, root: string, outside: string, ctx: Context, endpoint: WorkspaceFiles
let mode: 'workspace-write' | 'read-only', live: boolean
let dispose: () => Promise<void>
const id = SessionId('files-test')
const signal = () => new AbortController().signal
const scope = () => ({ sessionId: id, workspaceRoot: root })
beforeEach(async () => {
 directory = await mkdtemp(join(tmpdir(), 'a08-files-')); root = join(directory, 'work'); outside = join(directory, 'outside')
 await mkdir(root); await mkdir(outside); mode = 'workspace-write'; live = true; ctx = new Context()
 ctx.provide('sessionProjections', { register: () => () => {}, stateOf: () => mode } as never)
 const policy = new SandboxPolicyService(ctx, { mode: 'workspace-write', workspaceRoot: root })
 const session = { id, header: { id, cwd: root } }
 ctx.provide('sessions', { get: () => live ? session : undefined } as never)
 const fiber = await ctx.plugin(SandboxedFileSystem, { cwd: root })
 endpoint = new WorkspaceFiles(ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 100 })
 dispose = async () => { await fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
 expect(policy.resolve({ session: session as never }).mode).toBe('workspace-write')
})
afterEach(async () => { await dispose() })
describe('Session-scoped workspace creation over real task FS', () => {
 it('creates through a contained directory alias using the canonical target', async () => {
  await mkdir(join(root, 'target'))
  await symlink(join(root, 'target'), join(root, 'alias'))
  const folder = await endpoint.createDirectory(scope(), 'alias', 'child', signal())
  expect(folder.absolutePath).toBe(join(root, 'target', 'child'))
  const file = await endpoint.createFile(scope(), 'alias/child', 'notes.txt', signal())
  expect(file.absolutePath).toBe(join(root, 'target', 'child', 'notes.txt'))
  expect(await readFile(file.absolutePath, 'utf8')).toBe('')
 })
 it('creates Chinese/space folder and empty file, then lists the canonical path', async () => {
  const folder = await endpoint.createDirectory(scope(), '.', '中文 文件夹', signal())
  expect(folder.absolutePath).toBe(join(root, '中文 文件夹'))
  const file = await endpoint.createFile(scope(), folder.absolutePath, '草稿 notes.txt', signal())
  expect(await readFile(file.absolutePath, 'utf8')).toBe('')
  const listing = await endpoint.list(scope(), folder.absolutePath + '/.', signal())
  expect(listing.absolutePath).toBe(folder.absolutePath); expect(listing.rootPath).toBe(root)
  expect(listing.entries.map(row => row.name)).toEqual(['草稿 notes.txt'])
 })
 it('refuses repeated creation and preserves existing file bytes', async () => {
  await endpoint.createDirectory(scope(), '.', 'same', signal())
  await expect(endpoint.createDirectory(scope(), '.', 'same', signal())).rejects.toMatchObject({ code: 'workspace-file/already-exists' })
  await writeFile(join(root, 'keep.txt'), 'preserve')
  await expect(endpoint.createFile(scope(), '.', 'keep.txt', signal())).rejects.toMatchObject({ code: 'workspace-file/already-exists' })
  expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('preserve')
  await symlink(join(outside, 'missing'), join(root, 'dangling'))
  await expect(endpoint.createFile(scope(), '.', 'dangling', signal())).rejects.toMatchObject({ code: 'workspace-file/already-exists' })
  expect(await readdir(outside)).toEqual([])
 })
 it('read-only applies to both UI file and folder creation', async () => {
  mode = 'read-only'
  await expect(endpoint.createDirectory(scope(), '.', 'blocked', signal())).rejects.toMatchObject({ code: 'workspace-file/write-denied' })
  await expect(endpoint.createFile(scope(), '.', 'blocked.txt', signal())).rejects.toMatchObject({ code: 'workspace-file/write-denied' })
  expect(await readdir(root)).toEqual([])
 })
 it('refuses outside parent and a symlink to an outside directory', async () => {
  await symlink(outside, join(root, 'escape'))
  await expect(endpoint.createDirectory(scope(), outside, 'bad', signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
  await expect(endpoint.createFile(scope(), '../outside', 'bad.txt', signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
  await expect(endpoint.createDirectory(scope(), join(root, 'escape'), 'bad', signal())).rejects.toBeDefined()
  expect(await readdir(outside)).toEqual([])
 })
 it('requires one non-blank segment and never creates parents implicitly', async () => {
  for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b', 'bad\0name']) {
   await expect(endpoint.createDirectory(scope(), '.', name, signal())).rejects.toMatchObject({ code: 'workspace-file/invalid-name' })
  }
  await expect(endpoint.createDirectory(scope(), 'missing', 'child', signal())).rejects.toMatchObject({ code: 'workspace-file/not-found' })
  expect(await readdir(root)).toEqual([])
 })
 it('an aborted request does not create and a cold Session cannot modify', async () => {
  const abort = new AbortController(); abort.abort()
  await expect(endpoint.createDirectory(scope(), '.', 'cancelled', abort.signal)).rejects.toBeDefined()
  live = false
  await expect(endpoint.createFile(scope(), '.', 'cold.txt', signal())).rejects.toMatchObject({ code: 'workspace-file/session-unavailable' })
  expect(await readdir(root)).toEqual([])
 })
 it('concurrent file creation has one winner without overwriting', async () => {
  const results = await Promise.allSettled([endpoint.createFile(scope(), '.', 'one.txt', signal()), endpoint.createFile(scope(), '.', 'one.txt', signal())])
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
  const failure = results.find(row => row.status === 'rejected') as PromiseRejectedResult
  expect(failure.reason.code).toBe('workspace-file/already-exists')
  expect(await readdir(root)).toEqual(['one.txt'])
 })
})
