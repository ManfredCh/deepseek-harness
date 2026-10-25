// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { TurnUsagePanel } from '../src/client/chat/TurnUsagePanel.tsx'
import type { TurnTokenUsage } from '../src/client/contract/chat-nodes.ts'
import { en, zh } from '../src/client/locale.ts'
import { ModelDirectory } from '../../ui-model-selection/src/client/directory.ts'
import { ModelCatalogDirectory } from '../../ui-model-selection/src/client/catalog.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'

const t = makeTranslate(en, commonEn)

afterEach(cleanup)

describe('TurnUsagePanel', () => {
  it('shows an icon-and-total pill and opens the usage dialog on click', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 5_060,
      cacheReadTokens: 4_940,
      cacheWriteTokens: 0,
      outputTokens: 5_800,
      reasoningTokens: 42,
      totalTokens: 15_800,
      routes: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    }
    const view = render(<TurnUsagePanel usage={usage} t={t} />)

    const trigger = view.getByRole('button')
    expect(trigger.textContent).toBe('Usage 15.8K tok')
    expect(trigger.querySelector('svg')).not.toBeNull()
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Turn usage')
    // Portaled out of the trigger's row, with a heading row carrying the total.
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.firstChild?.textContent).toBe('Turn usage15,800 tok')
    const details = dialog.querySelector('[data-turn-usage-details]') as HTMLElement
    expect(details).toBeTruthy()
    expect(details.textContent).toContain('Provider / modelModel')
    expect(details.textContent).toContain('Cache hit49.4%')
    expect(details.textContent).toContain('Uncached input5,060 tok')
    expect(details.textContent).toContain('Cached input4,940 tok')
    expect(details.textContent).toContain('Cache write0 tok')
    expect(details.textContent).toContain('Output5,800 tok (42 tok reasoning)')
    expect(details.textContent).not.toContain('Total')
  })

  it('omits unavailable optional facts instead of inventing values', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    }
    const view = render(<TurnUsagePanel usage={usage} t={t} />)

    const trigger = view.getByRole('button')
    expect(trigger.textContent).toBe('Usage 150 tok')
    fireEvent.click(trigger)
    expect(view.queryByText('Provider / model')).toBeNull()
    expect(view.queryByText('Cache hit')).toBeNull()
    expect(view.queryByText('Cached input')).toBeNull()
    expect(view.queryByText('Cache write')).toBeNull()
    expect(view.queryByText(/reasoning/)).toBeNull()
  })

  it('keeps a partial cache hit below 100 in the dialog and closes on Escape or outside pointerdown', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 1,
      cacheReadTokens: 999,
      outputTokens: 100,
      totalTokens: 1_100,
    }
    const view = render(<TurnUsagePanel usage={usage} t={t} />)
    const trigger = view.getByRole('button')
    // The pill carries the compact total; cache-hit rate and exact token
    // counts stay in the dialog.
    expect(trigger.textContent).toBe('Usage 1.1K tok')

    fireEvent.click(trigger)
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toContain('Cache hit99.9%')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    // A pointerdown inside the panel keeps it open; one outside closes it.
    fireEvent.pointerDown(view.getByRole('dialog'))
    expect(view.queryByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('closes on an outside click without pointerdown, as keyboard activation elsewhere fires', () => {
    const view = render(<TurnUsagePanel usage={{ uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }} t={t} />)
    fireEvent.click(view.getByRole('button'))
    fireEvent.click(view.getByRole('dialog'))
    expect(view.queryByRole('dialog')).toBeTruthy()
    fireEvent.click(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
  })
})


it('two real directory instances show their own public usage names; missing catalog/locales preserve route and exact numbers', () => {
  const make = (id: string, name: string) => {
    const catalog = new ModelCatalogDirectory({ remote: { session: {} } } as never)
    catalog.store.set({ status: 'ready', error: null, value: { default: null, groups: [{ id: 'internal-provider', name: 'Public provider', models: [{ id, name }] }], routableProviders: ['internal-provider'], failures: [] } })
    return new ModelDirectory({} as never, SessionId('session-'+id), () => true, catalog, createSnapshotStore(undefined), () => true)
  }
  const first = make('peiri', 'Peiri'), second = make('other-private-model', 'Public second model')
  const usage: TurnTokenUsage = { uncachedInputTokens: 123, outputTokens: 45, totalTokens: 168, routes: [{ provider: 'internal-provider', model: 'peiri' }] }
  const original = JSON.stringify(usage)
  const view = render(<TurnUsagePanel usage={usage} t={t} modelDirectory={first} />)
  fireEvent.click(view.getByRole('button'));expect(view.getByRole('dialog').textContent).toContain('Peiri');expect(view.getByRole('dialog').textContent).toContain('123 tok')
  const otherUsage = { ...usage, routes: [{ provider: 'internal-provider', model: 'other-private-model' }] }
  view.rerender(<TurnUsagePanel usage={otherUsage} t={t} modelDirectory={second} />)
  expect(view.getByRole('dialog').textContent).toContain('Public second model');expect(view.getByRole('dialog').textContent).not.toContain('Peiri')
  act(() => { second.store.update(snapshot => { snapshot.groups = [] }) })
  expect(view.getByRole('dialog').textContent).not.toContain('other-private-model');expect(view.getByRole('dialog').textContent).toContain('Model')
  view.rerender(<TurnUsagePanel usage={otherUsage} t={makeTranslate(zh)} modelDirectory={second} />)
  expect(view.getByRole('dialog').textContent).toContain('模型');expect(JSON.stringify(usage)).toBe(original)
  first.dispose();second.dispose()
})
