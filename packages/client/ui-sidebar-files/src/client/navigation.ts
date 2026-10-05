/**
 * Build breadcrumbs for a directory displayed under its Workspace root.
 * @param root - Host Workspace root.
 * @param path - displayed directory, validated by the Host.
 * @returns root and descendant crumbs, or an empty list outside the root.
 */
export function directoryCrumbs(root: string, path: string): Array<{ path: string; name: string }> {
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')
  const normalize = (value: string) => (windows ? value.replace(/\\/g, '/') : value).replace(/\/$/, '') || '/'
  const base = normalize(root), current = normalize(path)
  const insensitive = windows
  const same = (a: string, b: string) => insensitive ? a.toLowerCase() === b.toLowerCase() : a === b
  const prefix = base === '/' ? '/' : base + '/'
  if (!same(current, base) && !same(current.slice(0, prefix.length), prefix)) return []
  const result = [{ path: root, name: base.split('/').at(-1) || base }]
  if (same(current, base)) return result
  let at = base === '/' ? '' : base
  for (const name of current.slice(prefix.length).split('/').filter(Boolean)) { at += '/' + name; result.push({ path: at, name }) }
  return result
}
/**
 * Resolve the breadcrumb immediately above the displayed directory.
 * @param root - Host Workspace root.
 * @param path - displayed directory.
 * @returns its in-Workspace parent, or undefined at the root.
 */
export function parentInWorkspace(root: string, path: string): string | undefined {
  return directoryCrumbs(root, path).at(-2)?.path
}
