/**
 * The tree's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `start` / `refresh` / `toggle`, and
 * this face performs the listing and writes the outcome through the store's own
 * actions — the Slot-standard `inject` shape, so the session id is resolved by
 * the framework and the write set stays the store's.
 *
 * The listing itself is bound here to the Client Remote face: the tree keys
 * every level by absolute path and hands the endpoint that same absolute path;
 * the endpoint answers with the directory's workspace-relative path as well,
 * which the tree has no use for and drops.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten,
 * so no later settlement writes to it.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DirLevel, createFilesStore } from './store.ts'
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryNode } from './directory-node.ts'

/**
 * Observe one directory without recursively watching its descendants.
 * @param sessionId - Session owning the directory tree.
 * @param path - absolute directory path.
 * @param signal - node lifetime.
 * @returns readiness and invalidation notifications.
 */
export type WatchWorkspaceDirectory = (sessionId: SessionId, path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>

/**
 * Bind directory observation to the Remote stream supervisor.
 * @param remote - Client Remote with workspace file streams.
 * @returns a watcher that awaits stream disposal when its node ends.
 */
export function createWatch(remote: ClientRemote): WatchWorkspaceDirectory {
  return async function* (sessionId, path, signal) {
    const aborted = (): boolean => signal.aborted
    if (aborted()) return
    const stream = remote.$stream<WorkspaceFileWatchFrame>({
      name: `directory ${path}`,
      open: lifetime => remote.workspaceFiles.changes(sessionId, path, lifetime),
      ended: () => new Error(`Directory watch ended: ${path}`),
    })
    const abort = (): void => { void stream.dispose() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const item of stream) {
        if (aborted()) return
        if (item.value.kind === 'ready') item.accept()
        yield item.value.kind
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await stream.dispose()
    }
  }
}

/**
 * One directory listing, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * A Remote call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<DirLevel>>

/**
 * The slice of the Client Remote face this package calls: the `workspaceFiles`
 * namespace's `list`, exactly as the Host's generated client declares it.
 */
export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

/**
 * Bind the listing to one Remote face, keeping only what the tree stores.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the listing the tree's face performs.
 */
export function createList(remote: WorkspaceFilesListRemote): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const result = await remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated, ...result.value.absolutePath ? { absolutePath: result.value.absolutePath } : {}, ...result.value.rootPath ? { rootPath: result.value.rootPath } : {} } }
  }
}

/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

/** Create one Host-confined file or directory without replacing existing entries. */
export type CreateWorkspaceEntry = (sessionId: SessionId, parent: string, name: string, kind: 'file' | 'directory', signal: AbortSignal) => Promise<RemoteResult<{ absolutePath: string; path: string; type: 'file' | 'directory' }>>
/**
 * Bind both creation methods to the same Session-aware workspace endpoint.
 * @param remote - generated workspace-file creation namespace.
 * @returns the creation operation for the Files face.
 */
export function createEntries(remote: { workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'createFile' | 'createDirectory'> }): CreateWorkspaceEntry {
  return (sessionId, parent, name, kind, signal) => kind === 'directory'
    ? remote.workspaceFiles.createDirectory(sessionId, parent, name, signal)
    : remote.workspaceFiles.createFile(sessionId, parent, name, signal)
}
/** The tree's injected business face, as the body receives it. */
export interface FilesInjected {
  /** Refresh the open directory tree. @param tabId - owning tab. */
  readonly refresh: (tabId: TabId) => void
  /** Navigate this tab without changing the Session workspace. */
  readonly navigate: (tabId: TabId, path: string, signal: AbortSignal, historyIndex?: number) => void
  /** Create one entry in the shown directory, under Host write policy. */
  readonly createEntry?: (parent: string, name: string, kind: 'file' | 'directory', signal: AbortSignal) => ReturnType<CreateWorkspaceEntry>
  /** Control automatic rereads without closing watches. @param tabId - owning tab. @param enabled - automatic-refresh setting. */
  readonly setAutoRefresh: (tabId: TabId, enabled: boolean) => void
  /**
   * Seed this tab's tree and list its root.
   * @param tabId - the tab being drawn.
   * @param root - absolute path of the workspace root.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, root: string, signal: AbortSignal) => void
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, retaining intent during ancestor restoration.
   * @param tabId - the tab being drawn.
   * @param parentPath - the listed parent directory's exact tree key.
   * @param path - absolute directory path.
   * @param expanded - current expansion preferences, including descendants to restore.
   * @param signal - the tab record's lifetime.
   */
  readonly toggle: (tabId: TabId, parentPath: string, path: string, expanded: readonly string[], signal: AbortSignal) => void
}

/**
 * Bind the tree's face to one directory listing.
 * @param list - the bound `workspaceFiles.list` call.
 * @param watch - target-scoped directory observation.
 * @param create - optional Host-confined file and directory creation.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function filesFace(
  list: ListWorkspaceDirectory,
  watch: WatchWorkspaceDirectory,
  create?: CreateWorkspaceEntry,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => FilesInjected {
  return (
    sessionId: SessionId,
    actions: BoundActions<ReturnType<typeof createFilesStore>>,
  ): FilesInjected => {
    /** Per tab, per absolute path: the listing generation a settlement must match; the latest request wins. */
    const generations = new Map<TabId, Map<string, number>>()
    const roots = new Map<TabId, DirectoryNode>()
    const navigationGenerations = new Map<TabId, number>()
    const navigationTargets = new Map<TabId, { path: string; promise: Promise<DirLevel | undefined> }>()
    const expansions = new Map<TabId, readonly string[]>()
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    const load = async (tabId: TabId, path: string, signal: AbortSignal): Promise<DirLevel | undefined> => {
      if (signal.aborted) return
      const pending = navigationTargets.get(tabId)
      if (pending?.path === path) return pending.promise
      const generation = nextGeneration(tabId, path)
      actions.loading(tabId, path)
      return list(sessionId, path, signal).then((result) => {
        // A newer listing of this level was asked for since, or the record is
        // gone and its bookkeeping with it: nothing left for this one to write.
        if (signal.aborted || generations.get(tabId)?.get(path) !== generation) return
        if (result.ok) actions.loaded(tabId, path, result.value)
        else actions.failed(tabId, path, result.error)
        return result.ok ? result.value : undefined
      })
    }
    const mountRoot = (tabId: TabId, path: string, signal: AbortSignal): void => {
      void roots.get(tabId)?.close()
      roots.set(tabId, new DirectoryNode(path,
        (directory, lifetime) => load(tabId, directory, lifetime),
        (directory, lifetime) => watch(sessionId, directory, lifetime),
        (directory, error) => {
          if (!signal.aborted) actions.failed(tabId, directory, new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}))
        }, signal, expansions.get(tabId),
      ).open())
    }
    function navigate(tabId: TabId, path: string, signal: AbortSignal, historyIndex?: number): void {
      if (signal.aborted) return
      const sequence = (navigationGenerations.get(tabId) ?? 0) + 1
      navigationGenerations.set(tabId, sequence)
      const generation = nextGeneration(tabId, path)
      actions.navigating(tabId, path)
      actions.loading(tabId, path)
      const promise = list(sessionId, path, signal).then(result => {
        if (signal.aborted || navigationGenerations.get(tabId) !== sequence || generations.get(tabId)?.get(path) !== generation) return undefined
        navigationTargets.delete(tabId)
        if (!result.ok) {
          actions.failed(tabId, path, result.error)
          actions.navigationFailed(tabId, result.error)
          return undefined
        }
        const absolute = result.value.absolutePath ?? path
        actions.loaded(tabId, absolute, result.value)
        actions.navigated(tabId, absolute, historyIndex)
        mountRoot(tabId, absolute, signal)
        return result.value
      }, (error: unknown) => {
        if (!signal.aborted && navigationGenerations.get(tabId) === sequence) {
          navigationTargets.delete(tabId)
          const failure = new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {})
          actions.failed(tabId, path, failure)
          actions.navigationFailed(tabId, failure)
        }
        return undefined
      })
      navigationTargets.set(tabId, { path, promise })
    }
    return {
      ...create === undefined ? {} : { createEntry: (parent: string, name: string, kind: 'file' | 'directory', signal: AbortSignal) => create(sessionId, parent, name, kind, signal) },
      navigate,
      refresh: (tabId) => { void roots.get(tabId)?.refreshTree() },
      setAutoRefresh: (tabId, enabled) => {
        actions.autoRefresh(tabId, enabled)
        roots.get(tabId)?.setAutomatic(enabled)
      },
      start(tabId, root, signal) {
        if (signal.aborted) return
        actions.start(tabId, root)
        signal.addEventListener('abort', () => {
          void roots.get(tabId)?.close()
          roots.delete(tabId)
          generations.delete(tabId)
          navigationGenerations.delete(tabId)
          navigationTargets.delete(tabId)
          expansions.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
        mountRoot(tabId, root, signal)
      },
      load: (tabId, path, signal) => { void load(tabId, path, signal) },
      toggle(tabId, parentPath, path, expanded, signal) {
        if (signal.aborted) return
        const root = roots.get(tabId)
        if (root === undefined) return
        const parent = root.find(parentPath)
        if (parent === undefined && !expanded.includes(parentPath)) return
        const collapsing = expanded.includes(path)
        const next = collapsing ? expanded.filter(value => value !== path) : [...expanded, path]
        expansions.set(tabId, next)
        root.setExpanded(next)
        if (collapsing) void parent?.collapse(path)
        else parent?.expand(path, next)
        actions.toggled(tabId, path)
      },
    }
  }
}
