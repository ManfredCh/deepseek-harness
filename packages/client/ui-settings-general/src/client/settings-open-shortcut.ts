/** Compatibility helper: the Settings shell keeps its own single open state. */
export function installSettingsOpenShortcut(open: () => void, target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey) return
    if (!(event.ctrlKey !== event.metaKey) || (event.code !== 'Comma' && event.key !== ',')) return
    event.preventDefault()
    open()
  }
  target.addEventListener('keydown', listener as EventListener)
  return () => { target.removeEventListener('keydown', listener as EventListener) }
}
