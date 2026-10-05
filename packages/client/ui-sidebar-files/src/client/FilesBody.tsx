/**
 * The file tree's body: the session's workspace root, listed one level at a time.
 *
 * Everything the tree keeps lives in its store, keyed by tab; everything it asks
 * for goes through its injected face. The component itself only decides what to
 * draw for each absolute path and what a click means: a directory toggles, a
 * file opens through the owner's `tabActions` for a `file:` viewer to claim, and
 * anything else is shown but refuses to open. The header uses the shared
 * PathLabel for the root, followed by reload and workspace directory actions.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  FileTypeIcon, IconFolderCloseRegular, IconFolderOpenRegular, IconRefreshOutlineRegular, Tooltip, classifyFileType,
  IconPauseOutlineRegular, IconPlayOutlineRegular, PathLabel,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath } from './face.ts'
import type { FilesInjected } from './face.ts'
import type {} from './locales.ts'
import type { FilesTabState, createFilesStore } from './store.ts'
import css from './FilesBody.module.css'
import { directoryCrumbs, parentInWorkspace } from './navigation.ts'

/** Workspace directory facts and scoped actions supplied to product Files controls. */
export interface FilesActionOwner {
  sessionId: SessionId
  absolutePath: string
  rootPath: string
  signal: AbortSignal
  openResource: (address: string) => void
}
/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.files.actions'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name. The endpoint's order is a listing fact; this is the
 * reader's.
 * @param entries - the listing as the endpoint returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/**
 * Say why a directory could not be listed, in terms of the directory.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show under the directory.
 */
export function failureLine(t: TranslateNS<'sidebarFiles'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/write-denied': return t('error.writeDenied')
    case 'workspace-file/already-exists': return t('error.alreadyExists')
    case 'workspace-file/invalid-name': return t('error.invalidName')
    case 'workspace-file/session-unavailable': return t('error.sessionUnavailable')
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
    case 'workspace-file/not-directory': return t('error.notDirectory')
    // Carrier and unclassified host failures reach the reader as themselves:
    // this tree knows nothing useful to add to a transport-level message.
    default: return t('error.unavailable', { message: failure.message })
  }
}

/** What every level shares: the tab's tree and the two gestures. */
interface TreeContext {
  readonly state: FilesTabState
  readonly onToggle: (parent: string, path: string) => void
  readonly onOpen: (path: string) => void
  readonly onNavigate: (path: string) => void
  readonly t: TranslateNS<'sidebarFiles'>
}

/** One entry's row, and its children when it is an expanded directory. */
function Entry({ parent, entry, tree }: { parent: string; entry: WorkspaceDirectoryEntry; tree: TreeContext }): ReactNode {
  const path = childPath(parent, entry.name)
  if (entry.type === 'directory') {
    const expanded = tree.state.expanded.includes(path)
    return (
      <li className={css.item} data-files-entry="directory" data-files-path={path}>
        <div className={css.directoryRow} data-files-selected={tree.state.selectedPath === path || undefined}>
        <button type="button" className={css.tool} aria-label={tree.t('expand', { name: entry.name })} aria-expanded={expanded} onClick={() => { tree.onToggle(parent, path) }}>
          {expanded ? <IconFolderOpenRegular className={css.icon} /> : <IconFolderCloseRegular className={css.icon} />}
        </button>
        <button type="button" className={css.row} aria-expanded={expanded} onClick={() => { tree.onNavigate(path) }}><span className={css.name}>{entry.name}</span></button>
        </div>
        {expanded && <ul className={css.level}><Level path={path} tree={tree} /></ul>}
      </li>
    )
  }
  if (entry.type === 'file') {
    return (
      <li className={css.item} data-files-entry="file" data-files-path={path} data-files-selected={tree.state.selectedPath === path || undefined}>
        <button type="button" className={css.row} onClick={() => { tree.onOpen(path) }}>
          <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className={css.fileIcon} />
          <span className={css.name}>{entry.name}</span>
        </button>
      </li>
    )
  }
  return (
    <li className={css.item} data-files-entry="other" data-files-path={path}>
      <span className={clsx(css.row, css.other)} aria-disabled="true" title={tree.t('entry.other')}>
        <span className={css.name}>{entry.name}</span>
      </span>
    </li>
  )
}

/** One directory's rows: its state while listing, its entries once listed. */
function Level({ path, tree }: { path: string; tree: TreeContext }): ReactNode {
  const { state, t } = tree
  const level = state.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return <li className={css.note} data-files-row="loading">{t('loading')}</li>
  }
  if (level.kind === 'failed') {
    return (
      <li className={css.note} data-files-row="failed" data-files-code={level.failure.code}>
        {failureLine(t, level.failure)}
      </li>
    )
  }
  const entries = orderEntries(level.level.entries).filter(entry => state.showHidden || !entry.name.startsWith('.'))
  return (
    <>
      {level.failure !== undefined && <li className={css.note} data-files-row="failed">{failureLine(t, level.failure)}</li>}
      {entries.length === 0 && <li className={css.note} data-files-row="empty">{t('empty')}</li>}
      {entries.map(entry => <Entry key={entry.name} parent={path} entry={entry} tree={tree} />)}
      {level.level.truncated && <li className={css.note} data-files-row="truncated">{t('truncated')}</li>}
    </>
  )
}

/** The file tree's body: the workspace root and whatever the reader has opened under it. */
export function FilesBody({
  useTabInfo, sessionId, useSessions, useStore, actions,
  start, load, refresh, setAutoRefresh, toggle, navigate, createEntry, t, renderSlot,
}: FilesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  useEffect(() => tab.actions.bindCommands({ refresh: () => { refresh(tab.id) } }), [tab.actions, tab.id, refresh])
  const { signal, actions: tabActions } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byTab[tab.id])
  const currentPath = state?.currentPath ?? state?.root ?? cwd ?? ''
  const [pathDraft, setPathDraft] = useState(currentPath)
  const [createKind, setCreateKind] = useState<'file' | 'directory'>()
  const [nameDraft, setNameDraft] = useState('')
  const [operationError, setOperationError] = useState('')
  const [creating, setCreating] = useState(false)
  const mutation = useRef<{ controller: AbortController; scope: string }>()
  const scopeKey = `${sessionId}:${tab.id}:${currentPath}`
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  useEffect(() => {
    setPathDraft(currentPath); setCreateKind(undefined); setOperationError(''); setCreating(false)
    return () => { if (mutation.current?.scope === scopeKey) { mutation.current.controller.abort(); mutation.current = undefined } }
  }, [scopeKey, currentPath])
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  // Come back where the reader was: loaded levels outlive the body in the
  // store, so a remounted tree lays out at its full height before this runs
  // and the stored offset re-lands exactly. A fresh tree stores 0.
  const seeded = state !== undefined
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (seeded && body !== null) {
      body.scrollTop = state.scrollTop
      scrollTopRef.current = body.scrollTop
    }
  }, [seeded])
  // Scrolling only moves the ref; the store hears about it once, on unmount,
  // so a scroll neither re-renders the tree nor writes after the owner's
  // abort has forgotten the bucket.
  useEffect(() => () => {
    if (seeded && !signal.aborted) actions.scrolled(tab.id, scrollTopRef.current)
  }, [seeded, signal, tab.id, actions])
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, cwd, signal)
  }, [state, cwd, tab.id, signal, start])

  if (cwd === undefined) {
    return (
      <div className={css.status} data-files-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  if (state === undefined) return null
  const tree: TreeContext = {
    state,
    onToggle: (parent, path) => { toggle(tab.id, parent, path, state.expanded, signal) },
    onNavigate: path => { navigate(tab.id, path, signal) },
    // Every row is under the tree's root, so its address is session-relative.
    onOpen: (path) => { actions.selected(tab.id, path); tabActions.openResource(fileAddressFor(sessionId, state.root, path)) },
    t,
  }
  const reload = (): void => {
    refresh(tab.id)
  }
  const crumbs = directoryCrumbs(state.root, currentPath)
  const parent = parentInWorkspace(state.root, currentPath)
  const create = async (): Promise<void> => {
    if (!createEntry || !createKind || creating || !nameDraft.trim() || signal.aborted || currentScope.current !== scopeKey) return
    const owner = currentScope.current, kind = createKind, capturedPath = currentPath
    const controller = new AbortController(); mutation.current = { controller, scope: owner }
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true })
    setCreating(true); setOperationError('')
    try {
      const result = await createEntry(capturedPath, nameDraft, kind, controller.signal)
      if (controller.signal.aborted || currentScope.current !== owner || mutation.current?.controller !== controller) return
      if (!result.ok) { setOperationError(failureLine(t, result.error)); return }
      setCreateKind(undefined); setNameDraft(''); if (nameDraft.startsWith('.')) actions.hidden(tab.id, true)
      load(tab.id, capturedPath, signal); actions.selected(tab.id, result.value.absolutePath)
      if (kind === 'file') tabActions.openResource(fileAddressFor(sessionId, state.root, result.value.absolutePath))
    } catch (error) {
      if (!controller.signal.aborted && currentScope.current === owner) setOperationError(String(error instanceof Error ? error.message : error))
    } finally {
      signal.removeEventListener('abort', abort)
      if (mutation.current?.controller === controller) { mutation.current = undefined; setCreating(false) }
    }
  }
  return (
    <div className={css.root} data-files-state="tree" data-files-root={state.root}>
      <div className={css.header}>
        <button type="button" className={css.tool} aria-label={t('back')} disabled={state.historyIndex === 0 || !!state.pendingPath} onClick={() => navigate(tab.id, state.history[state.historyIndex - 1]!, signal, state.historyIndex - 1)}>←</button>
        <button type="button" className={css.tool} aria-label={t('forward')} disabled={state.historyIndex >= state.history.length - 1 || !!state.pendingPath} onClick={() => navigate(tab.id, state.history[state.historyIndex + 1]!, signal, state.historyIndex + 1)}>→</button>
        <button type="button" className={css.tool} aria-label={t('up')} disabled={!parent || !!state.pendingPath} onClick={() => { if (parent) navigate(tab.id, parent, signal) }}>↑</button>
        <PathLabel path={currentPath} className={css.path} data-files-path />
        <button type="button" className={css.tool} aria-label={t('copyPath')} onClick={() => { void Promise.resolve().then(() => { if (!navigator.clipboard) throw new Error(t('copyUnavailable')); return navigator.clipboard.writeText(currentPath) }).catch(error => setOperationError(String(error))) }}>⧉</button>
        <span hidden>
          <button type="button" className={css.tool} aria-label={t('autoRefresh')}
            aria-pressed={state.autoRefresh} data-files-auto-refresh
            title={t(state.autoRefresh ? 'autoRefresh.disable' : 'autoRefresh.enable')}
            onClick={() => { setAutoRefresh(tab.id, !state.autoRefresh) }}>
            {state.autoRefresh ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
          </button>
        </span>
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('reload')}
            aria-keyshortcuts={tab.refreshShortcut?.aria}
            data-files-reload
            onClick={reload}
          >
            <IconRefreshOutlineRegular />
          </button>
        </Tooltip>
        {renderSlot('sidebar.right.tab.files.actions', {
          sessionId, absolutePath: currentPath, rootPath: state.root, signal, openResource: address => tabActions.openResource(address),
        })}
      </div>
      <nav className={css.crumbs} aria-label={t('breadcrumbs')}>{crumbs.map(crumb => <button key={crumb.path} type="button" onClick={() => navigate(tab.id, crumb.path, signal)} title={crumb.path}>{crumb.name}</button>)}</nav>
      <form className={css.pathForm} onSubmit={event => { event.preventDefault(); navigate(tab.id, pathDraft, signal) }}><input aria-label={t('path')} value={pathDraft} onChange={event => setPathDraft(event.target.value)}/><button type="submit">{t('open')}</button></form>
      <div className={css.toolbar}>
        <button type="button" disabled={!createEntry || creating || !!state.pendingPath || state.levels[currentPath]?.kind !== 'ready'} onClick={() => { setCreateKind('file'); setNameDraft(''); setOperationError('') }}>{t('newFile')}</button>
        <button type="button" disabled={!createEntry || creating || !!state.pendingPath || state.levels[currentPath]?.kind !== 'ready'} onClick={() => { setCreateKind('directory'); setNameDraft(''); setOperationError('') }}>{t('newFolder')}</button>
        <button type="button" aria-pressed={state.showHidden} onClick={() => actions.hidden(tab.id, !state.showHidden)}>{t('showHidden')}</button>
      </div>
      {createKind && <form role="dialog" aria-label={t(createKind === 'file' ? 'newFile' : 'newFolder')} className={css.createForm} onSubmit={event => { event.preventDefault(); void create() }}>
        <span>{t('createIn')} <code>{currentPath}</code></span>
        <input autoFocus aria-label={t('entryName')} disabled={creating} value={nameDraft} onChange={event => setNameDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && !creating) { event.preventDefault(); setCreateKind(undefined) } }}/>
        <button type="submit" disabled={creating || !nameDraft.trim()}>{t('create')}</button><button type="button" disabled={creating} onClick={() => setCreateKind(undefined)}>{t('cancel')}</button>
      </form>}
      {state.pendingPath && <p role="status">{t('loading')}</p>}
      {state.navigationError && <p role="alert">{failureLine(t, state.navigationError)}</p>}
      {operationError && <p role="alert">{operationError}</p>}
      <div
        ref={bodyRef}
        className={css.body}
        data-files-body
        onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop }}
      >
        <ul className={css.level}><Level path={currentPath} tree={tree} /></ul>
      </div>
    </div>
  )
}
