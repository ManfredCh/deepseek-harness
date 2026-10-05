/** Default model references remain live without a settings service. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import DefaultModel from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('reads complete selections from volatile config and clears omitted reasoning effort', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  await live.update({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  expect(consumer.currentSelection()).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
  await consumer.saveSelection({ provider: 'unsaved', model: 'unsaved' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
})

it('persists complete selections through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', reasoningEffort: ReasoningEffortId('high') })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', reasoningEffort: 'high' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  const standalone = new Context()
  onTestFinished(() => standalone.fiber.dispose())
  await standalone.plugin(DefaultModel, { provider: 'test', model: 'original' })
  await standalone.agentDefaultModel.saveSelection({ provider: 'test', model: 'ignored' })
  expect(standalone.agentDefaultModel.currentSelection().model).toBe('original')
})

it('serializes overlapping saves and continues after a rejected write', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const editor = ctx.configEditor
  const edit = editor.edit.bind(editor)
  const calls: string[] = []
  const intercepted = vi.spyOn(editor, 'edit').mockImplementationOnce(async () => {
    calls.push('rejected')
    entered.resolve(undefined)
    await release.promise
    throw new Error('read-only document')
  }).mockImplementation(async (entry, change) => {
    calls.push('saved')
    await edit(entry, change)
  })
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'rejected' })
  const failed = expect(first).rejects.toThrow('read-only document')
  const lastSelection = { provider: 'test', model: 'final' }
  const last = ctx.agentDefaultModel.saveSelection(lastSelection)
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([failed, last])
    intercepted.mockRestore()
  })
  lastSelection.model = 'mutated'
  await entered.promise
  expect(calls).toEqual(['rejected'])
  release.resolve(undefined)
  await failed
  await last
  expect(calls).toEqual(['rejected', 'saved'])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
})

it('keeps an own-provider composition empty until a complete native profile write succeeds', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const entry = [...ctx.loader.entries()].find(item => item.options.id === 'default-model')!
  await ctx.configEditor.edit(entry, () => ({ initiallyUnconfigured: true, manualOnlyPresentation: 'guest' }))
  const consumer = ctx.agentDefaultModel
  const ownerFiber = entry.fiber
  expect(consumer.optionalSelection()).toBeUndefined()
  expect(consumer.allowsEmptySelection).toBe(true)
  expect(consumer.manualOnlyPresentation).toBe('guest')
  await expect(ctx.settings.update('default-model', { provider: 'fixture' })).rejects.toThrow('MODEL_SELECTION_INCOMPLETE')
  expect(consumer.optionalSelection()).toBeUndefined()
  const refused = vi.spyOn(ctx.configEditor, 'edit').mockRejectedValueOnce(new Error('profile write refused'))
  await expect(consumer.saveSelection({ provider: 'fixture', model: 'rejected' })).rejects.toThrow('profile write refused')
  refused.mockRestore()
  expect(consumer.optionalSelection()).toBeUndefined()
  await consumer.saveSelection({ provider: 'fixture', model: 'own-chat' })
  expect(Object.is(entry.fiber, ownerFiber)).toBe(true)
  expect(consumer.currentSelection()).toEqual({ provider: 'fixture', model: 'own-chat' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'fixture', model: 'own-chat' })
})

it('refuses model acquisition by a manual-only composition through direct save and Loader edits', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { manualOnly: true, manualOnlyPresentation: 'guest' })
  const consumer = ctx.agentDefaultModel
  expect(consumer.optionalSelection()).toBeUndefined()
  await expect(consumer.saveSelection({ provider: 'fixture', model: 'model' })).rejects.toThrow('MODEL_NOT_CONFIGURED')
  await expect(live.update({ provider: 'fixture', model: 'model' })).rejects.toThrow('manual-only composition')
  expect(consumer.optionalSelection()).toBeUndefined()
  expect(() => consumer.currentSelection()).toThrow('MODEL_NOT_CONFIGURED')
})
