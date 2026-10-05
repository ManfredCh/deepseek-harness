/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route, empty only in an explicitly opted-in composition. */
  provider: Volatile<string | undefined>
  /** Provider-owned model id; both route and id are set together. */
  model: Volatile<string | undefined>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
  /** Manual commands remain available; no selection can enable model requests. */
  manualOnly?: true
  /** Begin empty and enable requests only after an explicit complete selection. */
  initiallyUnconfigured?: true
  /** Presentation only; never changes permissions or provider policy. */
  manualOnlyPresentation?: 'guest'
}

/** Validate the complete composition before publishing or updating its selection. */
function validateSelectionConfig(config: Config): void {
  const provider = config.provider.get()
  const model = config.model.get()
  if (Boolean(provider) !== Boolean(model)) throw new Error('MODEL_SELECTION_INCOMPLETE')
  if (config.manualOnly === true) {
    if (provider || model || config.initiallyUnconfigured === true) throw new Error('MODEL_NOT_CONFIGURED: manual-only composition cannot acquire a selection')
  } else if (!provider && config.initiallyUnconfigured !== true) {
    throw new Error('MODEL_NOT_CONFIGURED: a normal composition requires provider and model')
  }
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * Each operation reads the owning Config references.
 */
export class AgentDefaultModelConfig extends Service {
  private saves: Promise<void> = Promise.resolve()

  static Config = z.object({
    provider: z.string().volatile(),
    model: z.string().volatile(),
    reasoningEffort: z.string().volatile(),
    manualOnly: z.const(true),
    initiallyUnconfigured: z.const(true),
    manualOnlyPresentation: z.const('guest'),
  })

  /** Empty selections may be enabled only by the explicitly opted-in composition. */
  readonly allowsEmptySelection: boolean
  /** Guest copy hint owned by the launching composition. */
  readonly manualOnlyPresentation: 'guest' | undefined

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')
    validateSelectionConfig(config)
    this.allowsEmptySelection = config.initiallyUnconfigured === true
    this.manualOnlyPresentation = config.manualOnlyPresentation
    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
    ownerContext.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
      const raw = next()
      if (this !== ownerContext.fiber) return raw
      const candidate = AgentDefaultModelConfig.Config(raw)
      validateSelectionConfig(candidate)
      return raw
    })
    if (config.manualOnly === true || this.allowsEmptySelection) {
      ownerContext.on('agent/pre-step', async (_payload, next) => {
        const decision = await next()
        return this.optionalSelection() === undefined ? { kind: 'reject' } : decision
      })
    }
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    const selected = this.optionalSelection()
    if (selected === undefined) throw new Error('MODEL_NOT_CONFIGURED: this composition has no model selection')
    return selected
  }

  /**
   * Read the live selection without inventing a provider for a manual Session.
   * @returns the complete selection, or undefined for an explicitly empty composition.
   */
  optionalSelection(): ModelSelection | undefined {
    if (this.config.manualOnly === true) return undefined
    const provider = this.config.provider.get()
    const model = this.config.model.get()
    if (!provider || !model) {
      if (Boolean(provider) !== Boolean(model)) throw new Error('MODEL_SELECTION_INCOMPLETE')
      return undefined
    }
    const reasoningEffort = this.config.reasoningEffort.get()
    return selection({ provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } })
  }

  /**
   * Save the complete default model selection. A deployment without a configuration
   * editor keeps its composition entry. Saves commit in submission order; a failed
   * save rejects its caller without blocking later saves.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    if (this.config.manualOnly === true) throw new Error('MODEL_NOT_CONFIGURED: model selection is disabled by this composition')
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const config = {
      ...this.allowsEmptySelection ? {
        initiallyUnconfigured: true,
        ...this.manualOnlyPresentation === undefined ? {} : { manualOnlyPresentation: this.manualOnlyPresentation },
      } : {},
      provider: next.provider, model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
    }
    const saved = this.saves.then(() => editor.edit(entry, () => config))
    this.saves = saved.catch(() => {})
    await saved
  }
}

export default AgentDefaultModelConfig
