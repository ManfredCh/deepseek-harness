// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { CreateWorkspaceEntry } from '../src/client/face.ts'
import { mountBody, ROOT, SESSION, TAB } from './mount.client.tsx'
import { zh } from '../src/client/locales.ts'
afterEach(()=>{cleanup()})
const level=(path=ROOT)=>({entries:[],truncated:false,absolutePath:path,rootPath:ROOT})
async function start(create?:CreateWorkspaceEntry){const h=mountBody(ROOT, undefined, create);await act(()=>h.script.watches.ready(ROOT));await act(()=>h.script.settle({ok:true,value:level()}));return h}
async function fill(h:Awaited<ReturnType<typeof start>>,kind:'file'|'directory',name:string){
 await act(async()=>{fireEvent.click(h.view.getByRole('button',{name:kind==='file'?zh.newFile:zh.newFolder}))})
 fireEvent.change(h.view.getByRole('textbox',{name:zh.entryName}),{target:{value:name}})
 await act(async()=>{fireEvent.click(h.view.getByRole('button',{name:zh.create}));await Promise.resolve()})
}
describe('native Files operations in the real component/store',()=>{
 it('directory entry updates canonical path, breadcrumbs and back/forward; expansion keeps its current path',async()=>{
  const h=mountBody();await act(()=>h.script.watches.ready(ROOT));await act(()=>h.script.settle({ok:true,value:{...level(),entries:[{name:'中文 空格',type:'directory'}]}}))
  fireEvent.click(h.view.getByRole('button',{name:'展开或收起 中文 空格'}));await act(()=>h.script.watches.ready(ROOT+'/中文 空格'));await act(()=>h.script.settle({ok:true,value:level(ROOT+'/中文 空格')}))
  expect(h.instance.getSnapshot().byTab[TAB]!.currentPath).toBe(ROOT)
  fireEvent.click(h.view.getByRole('button',{name:'中文 空格'}));await act(()=>h.script.settle({ok:true,value:level(ROOT+'/中文 空格')}))
  expect((h.view.getByRole('textbox',{name:zh.path}) as HTMLInputElement).value).toBe(ROOT+'/中文 空格')
  expect(h.view.getByRole('navigation',{name:zh.breadcrumbs}).textContent).toContain('中文 空格')
  fireEvent.click(h.view.getByRole('button',{name:zh.back}));await act(()=>h.script.settle({ok:true,value:level()}))
  expect(h.instance.getSnapshot().byTab[TAB]!.currentPath).toBe(ROOT)
  fireEvent.click(h.view.getByRole('button',{name:zh.forward}));await act(()=>h.script.settle({ok:true,value:level(ROOT+'/中文 空格')}))
  expect(h.instance.getSnapshot().byTab[TAB]!.currentPath).toBe(ROOT+'/中文 空格')
 })
 it('copy path uses the canonical directory value, including Chinese spaces',async()=>{
  const previous=Object.getOwnPropertyDescriptor(navigator,'clipboard'),writeText=vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}})
  try{const h=await start();act(()=>h.face.navigate(TAB,ROOT+'/中文 空格',h.controller.signal));await act(()=>h.script.settle({ok:true,value:level(ROOT+'/中文 空格')}))
   await act(async()=>{fireEvent.click(h.view.getByRole('button',{name:zh.copyPath}));await Promise.resolve()});expect(writeText).toHaveBeenCalledWith(ROOT+'/中文 空格')
  }finally{if(previous)Object.defineProperty(navigator,'clipboard',previous);else Reflect.deleteProperty(navigator,'clipboard')}
 })
 it('Cancel creates nothing and empty creation remains disabled',async()=>{
  const create=vi.fn<CreateWorkspaceEntry>();const h=await start(create)
  fireEvent.click(h.view.getByRole('button',{name:zh.newFolder}))
  expect((h.view.getByRole('button',{name:zh.create}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(h.view.getByRole('button',{name:zh.cancel}));expect(create).not.toHaveBeenCalled()
  expect(h.view.queryByRole('dialog')).toBeNull()
 })
 it('file creation uses the current Session/parent and opens the existing document address',async()=>{
  const create=vi.fn<CreateWorkspaceEntry>().mockResolvedValue({ok:true,value:{absolutePath:ROOT+'/notes.txt',path:'notes.txt',type:'file'}})
  const h=await start(create);await fill(h,'file','notes.txt')
  expect(create).toHaveBeenCalledWith(SESSION,ROOT,'notes.txt','file',expect.any(AbortSignal))
  expect(h.tabActions.openResource).toHaveBeenCalledWith('dsh-resource://file/session/s-test/notes.txt')
  expect(h.script.outstanding()).toEqual([ROOT]);await act(()=>h.script.settle({ok:true,value:level()}))
 })
 it('a real write-denied reply keeps the dialog/draft and never opens a fake document',async()=>{
  const create=vi.fn<CreateWorkspaceEntry>().mockResolvedValue({ok:false,error:new RemoteError('workspace-file/write-denied','read-only',{path:ROOT})})
  const h=await start(create);await fill(h,'directory','保留名字')
  expect(h.view.getByRole('alert').textContent).toBe(zh['error.writeDenied'])
  expect((h.view.getByRole('textbox',{name:zh.entryName}) as HTMLInputElement).value).toBe('保留名字')
  expect(h.tabActions.openResource).not.toHaveBeenCalled()
 })
 it('old A create/finally never touches B create after directory scope changes',async()=>{
  const pending:Array<{settle:(x:Awaited<ReturnType<CreateWorkspaceEntry>>)=>void;signal:AbortSignal}>=[]
  const create=vi.fn<CreateWorkspaceEntry>((_s,_p,_n,_k,signal)=>new Promise(settle=>pending.push({settle,signal})))
  const h=await start(create);await fill(h,'directory','A')
  act(()=>h.face.navigate(TAB,ROOT+'/B',h.controller.signal));await act(()=>h.script.settle({ok:true,value:level(ROOT+'/B')}))
  expect(pending[0]!.signal.aborted).toBe(true);await fill(h,'directory','B-child')
  await act(async()=>{pending[0]!.settle({ok:true,value:{absolutePath:ROOT+'/A',path:'A',type:'directory'}});await Promise.resolve()})
  expect((h.view.getByRole('button',{name:zh.create}) as HTMLButtonElement).disabled).toBe(true)
  await act(async()=>{pending[1]!.settle({ok:true,value:{absolutePath:ROOT+'/B/B-child',path:'B/B-child',type:'directory'}});await Promise.resolve()})
  expect(h.view.queryByRole('dialog')).toBeNull();expect(h.script.outstanding()).toEqual([ROOT+'/B'])
  await act(()=>h.script.settle({ok:true,value:{...level(ROOT+'/B'),entries:[{name:'B-child',type:'directory'}]}}))
  expect(h.instance.getSnapshot().byTab[TAB]!.selectedPath).toBe(ROOT+'/B/B-child')
 })
 it('creation of a dot folder makes the selected new entry visible',async()=>{
  const create=vi.fn<CreateWorkspaceEntry>().mockResolvedValue({ok:true,value:{absolutePath:ROOT+'/.notes',path:'.notes',type:'directory'}})
  const h=await start(create);await fill(h,'directory','.notes')
  await act(()=>h.script.settle({ok:true,value:{...level(),entries:[{name:'.notes',type:'directory'}]}}))
  expect(h.instance.getSnapshot().byTab[TAB]!.showHidden).toBe(true)
  expect(h.view.getByRole('button',{name:'.notes'})).toBeDefined()
 })
})
