/** Install the input owner's focus shortcut without finding an external DOM node.
 * @param focus - action over the input owner's editor reference.
 * @param target - keyboard event source.
 * @returns listener disposer.
 */
export function installInputFocusShortcut(focus: () => void, target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.repeat || event.isComposing || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (event.code !== 'KeyL' && event.key.toLowerCase() !== 'l') return
    if (typeof Element !== 'undefined' && event.target instanceof Element && event.target.closest('[role=dialog],.xterm,.monaco-editor')) return
    event.preventDefault(); focus()
  }
  target.addEventListener('keydown', listener as EventListener)
  return () => { target.removeEventListener('keydown', listener as EventListener) }
}
