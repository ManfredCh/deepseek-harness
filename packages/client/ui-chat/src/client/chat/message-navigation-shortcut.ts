/** Resolve the neighboring authored-message row or the live tail.
 * @param tops - rendered user/steering row tops in view order.
 * @param line - viewport reading line.
 * @param atBottom - whether the view currently follows the live tail.
 * @param direction - previous or next authored message.
 * @returns row index; -1 precedes the loaded window and length means live tail.
 */
export function neighboringMessage(tops: readonly number[], line: number, atBottom: boolean, direction: -1 | 1): number {
  let current = atBottom ? tops.length : -1
  if (!atBottom) for (let index = 0; index < tops.length; index++) { if (tops[index]! <= line + 1) current = index; else break }
  return Math.min(tops.length, current + direction)
}

/** Bind message navigation to the Chat owner's existing scroll actions.
 * @param navigate - user-message navigation action.
 * @param target - keyboard event source.
 * @returns listener disposer.
 */
export function installMessageNavigationShortcut(navigate: (direction: -1 | 1) => void, target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.repeat || event.isComposing || !(event.ctrlKey !== event.metaKey) || !event.altKey || event.shiftKey) return
    const direction = event.code === 'BracketLeft' || event.key === '[' ? -1 : event.code === 'BracketRight' || event.key === ']' ? 1 : undefined
    if (direction === undefined) return
    if (typeof Element !== 'undefined' && event.target instanceof Element && event.target.closest('[role=dialog],.xterm,.monaco-editor')) return
    event.preventDefault(); navigate(direction)
  }
  target.addEventListener('keydown', listener as EventListener)
  return () => { target.removeEventListener('keydown', listener as EventListener) }
}
