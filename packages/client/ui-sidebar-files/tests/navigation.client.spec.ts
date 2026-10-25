import { describe, expect, it, onTestFinished } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createFilesStore } from '../src/client/store.ts'
import { filesFace } from '../src/client/face.ts'
import { directoryCrumbs, parentInWorkspace } from '../src/client/navigation.ts'
import { scriptedList } from './scripted-list.client.ts'
const tab = 'tab-files' as TabId, root = '/工作区 空格'
const level = (path: string) => ({ entries: [], truncated: false, absolutePath: path, rootPath: root })
async function mount() {
 const store = createFilesStore().create(), script = scriptedList(), abort = new AbortController()
 const face = filesFace(script.list, script.watch)('s' as SessionId, store.actions)
 onTestFinished(async () => { abort.abort(); await script.dispose() })
 face.start(tab, root, abort.signal)
 await script.watches.ready(root)
 return { store, script, abort, face, state: () => store.getSnapshot().byTab[tab]! }
}
describe('native Files navigation owner', () => {
 it('canonical directory changes history and back/forward preserve its identity', async () => {
  const h = await mount(); await h.script.settle({ ok:true,value:level(root) })
  h.face.navigate(tab, './中文', h.abort.signal); await h.script.settle({ok:true,value:level(root+'/中文')})
  expect(h.state().currentPath).toBe(root+'/中文'); expect(h.state().history).toEqual([root,root+'/中文'])
  h.face.navigate(tab, root, h.abort.signal, 0); await h.script.settle({ok:true,value:level(root)})
  expect(h.state().historyIndex).toBe(0)
  h.face.navigate(tab, root+'/中文', h.abort.signal, 1); await h.script.settle({ok:true,value:level(root+'/中文')})
  expect(h.state().historyIndex).toBe(1); expect(h.state().history).toHaveLength(2)
 })
 it('late A navigation never overwrites B or clears B pending state', async () => {
  const h=await mount(); await h.script.settle({ok:true,value:level(root)})
  h.face.navigate(tab,root+'/A',h.abort.signal); h.face.navigate(tab,root+'/B',h.abort.signal)
  await h.script.settle({ok:true,value:level(root+'/A')}); expect(h.state().pendingPath).toBe(root+'/B'); expect(h.state().currentPath).toBe(root)
  await h.script.settle({ok:true,value:level(root+'/B')}); expect(h.state().currentPath).toBe(root+'/B'); expect(h.state().pendingPath).toBeUndefined()
 })
 it('abort removes the tab; its late navigation cannot recreate a bucket', async () => {
  const h=await mount(); await h.script.settle({ok:true,value:level(root)})
  h.face.navigate(tab,root+'/A',h.abort.signal); h.abort.abort()
  await h.script.settle({ok:true,value:level(root+'/A')}); expect(h.store.getSnapshot().byTab[tab]).toBeUndefined()
 })
 it('expansion does not change directory; hiding uses the same store', async () => {
  const h=await mount(); await h.script.settle({ok:true,value:{ ...level(root), entries: [{ name: 'A', type: 'directory' as const }] }})
  h.face.toggle(tab, root, root+'/A', h.state().expanded, h.abort.signal); await h.script.watches.ready(root+'/A'); await h.script.settle({ok:true,value:level(root+'/A')})
  expect(h.state().currentPath).toBe(root); h.store.actions.hidden(tab,true); expect(h.state().showHidden).toBe(true)
 })
 it('refresh of a pending directory shares admission and completes canonical navigation', async () => {
  const h=await mount(); await h.script.settle({ok:true,value:level(root)})
  h.face.navigate(tab,root+'/A',h.abort.signal); h.face.load(tab,root+'/A',h.abort.signal)
  expect(h.script.outstanding()).toEqual([root+'/A'])
  await h.script.settle({ok:true,value:level(root+'/A')});expect(h.state().pendingPath).toBeUndefined();expect(h.state().currentPath).toBe(root+'/A')
 })
 it('root parent is unavailable and crumbs retain Chinese/space names', () => {
  expect(parentInWorkspace(root,root)).toBeUndefined()
  expect(directoryCrumbs(root,root+'/中文/空 格').map(row=>row.name)).toEqual(['工作区 空格','中文','空 格'])
  expect(directoryCrumbs(root,'/工作区 空格-other')).toEqual([])
  expect(directoryCrumbs('/work', '/work/a\\b').at(-1)).toEqual({path:'/work/a\\b',name:'a\\b'})
  expect(parentInWorkspace('C:\\work','C:\\work\\child')).toBe('C:\\work')
 })
})
