import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'

const SESSION = 'blocked-session' as SessionId

describe('ComposerBlockRegistry', () => {
  it('republishes only when the copy changes', () => {
    const registry = new ComposerBlockRegistry()
    const listener = vi.fn()
    const store = registry.storeFor(SESSION)
    store.subscribe(listener)

    registry.set(SESSION, { reason: 'select a model first' })
    expect(store.getSnapshot()).toEqual({ reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    // Identical copy: no publication at all.
    registry.set(SESSION, { reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    registry.set(SESSION, undefined)
    expect(store.getSnapshot()).toBeUndefined()

    registry.forget(SESSION)
    expect(registry.storeFor(SESSION).getSnapshot()).toBeUndefined()
  })

  it('相同文案的权限放行标记变化必须发布，重复相同标记保持稳定', () => {
    const registry = new ComposerBlockRegistry(), listener = vi.fn(), store = registry.storeFor(SESSION)
    store.subscribe(listener)
    registry.set(SESSION, { reason: 'no model' })
    registry.set(SESSION, { reason: 'no model', allowPermissionChanges: true })
    expect(store.getSnapshot()).toEqual({ reason: 'no model', allowPermissionChanges: true })
    expect(listener).toHaveBeenCalledTimes(2)
    registry.set(SESSION, { reason: 'no model', allowPermissionChanges: true })
    expect(listener).toHaveBeenCalledTimes(2)
    registry.set(SESSION, { reason: 'no model', allowPermissionChanges: false })
    expect(listener).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot()?.allowPermissionChanges).toBe(false)
  })
  it('相同文案的model-only分类变化必须发布，未知分类恢复锁且重复分类稳定', () => {
    const registry = new ComposerBlockRegistry(), listener = vi.fn(), store = registry.storeFor(SESSION)
    store.subscribe(listener)
    registry.set(SESSION, { reason: 'same copy', allowPermissionChanges: true })
    registry.set(SESSION, { reason: 'same copy', kind: 'model-unavailable', allowPermissionChanges: true })
    expect(store.getSnapshot()?.kind).toBe('model-unavailable')
    expect(listener).toHaveBeenCalledTimes(2)
    registry.set(SESSION, { reason: 'same copy', kind: 'model-unavailable', allowPermissionChanges: true })
    expect(listener).toHaveBeenCalledTimes(2)
    registry.set(SESSION, { reason: 'same copy', allowPermissionChanges: true })
    expect(store.getSnapshot()?.kind).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(3)
  })

})
