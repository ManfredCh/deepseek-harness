/** Read only facts from this MCP generation's private browser owner. @module */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface BrowserRootObservation {
  owner: string
  sequence: number
  operation?: string
  ownership: 'session' | 'external'
  rootConnected: boolean | null
  targetAlive: boolean | null
  processExited: boolean | null
  exitCode?: number | null
  signalCode?: string | null
  released?: boolean
  neverStarted?: boolean
}

/** A missing, malformed or previous-generation record establishes no closure ownership. */
export function parseBrowserRootObservation(value: unknown, owner: string): BrowserRootObservation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as BrowserRootObservation
  const fact = (value: unknown) => value === null || typeof value === 'boolean'
  if (row.owner !== owner || !Number.isSafeInteger(row.sequence) || row.sequence < 0
    || !['session', 'external'].includes(row.ownership) || !fact(row.rootConnected)
    || !fact(row.targetAlive) || !fact(row.processExited)
    || (row.operation !== undefined && typeof row.operation !== 'string')
    || (row.exitCode !== undefined && row.exitCode !== null && !Number.isInteger(row.exitCode))
    || (row.signalCode !== undefined && row.signalCode !== null && typeof row.signalCode !== 'string')
    || (row.released !== undefined && typeof row.released !== 'boolean')) return undefined
  if (row.neverStarted !== undefined && typeof row.neverStarted !== 'boolean') return undefined
  return row
}

export class BrowserRootObserver {
  private owner = ''
  private sequence = -1
  private operation = ''
  readonly path: string
  private constructor(private readonly directory: string) { this.path = join(directory, 'owner.json') }
  static async create(): Promise<BrowserRootObserver> {
    return new BrowserRootObserver(await mkdtemp(join(tmpdir(), 'dsh-browser-owner-')))
  }
  async begin(): Promise<Record<string, string>> {
    this.owner = randomUUID(); this.sequence = -1
    await rm(this.path, { force: true })
    return { DSH_BROWSER_RUNTIME_OWNER: this.owner, DSH_BROWSER_RUNTIME_STATE: this.path }
  }
  async read(): Promise<BrowserRootObservation | undefined> {
    try {
      const row = parseBrowserRootObservation(JSON.parse(await readFile(this.path, 'utf8')), this.owner)
      if (row === undefined || row.sequence < this.sequence) return undefined
      this.sequence = row.sequence
      return row
    } catch { return undefined }
  }
  beginOperation(): string { return this.operation = randomUUID() }
  metadata(): Record<string, string> { return { 'lyapunov/browser-owner': this.owner, 'lyapunov/browser-operation': this.operation } }
  async readForOperation(operation: string | undefined, afterSequence: number): Promise<BrowserRootObservation | undefined> {
    const row = await this.read()
    return operation && row?.operation === operation && row.sequence > afterSequence ? row : undefined
  }
  async verifyRelease(): Promise<void> {
    const row = await this.read()
    if (row?.released !== true || (row.rootConnected !== false && !(row.neverStarted === true && row.rootConnected === null)) || (row.ownership === 'session' && row.processExited !== true && row.neverStarted !== true)) {
      throw new Error('BROWSER_RELEASE_UNVERIFIED: this generation did not confirm its browser root/process release')
    }
  }
  async dispose(): Promise<void> { await rm(this.directory, { recursive: true, force: true }) }
}
