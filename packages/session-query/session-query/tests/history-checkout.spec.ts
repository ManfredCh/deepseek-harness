import { expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildSessionEventSearchDocuments } from '../src/documents.ts'

it('classifies a checkout-revived original node as current while retaining raw audit search records', () => {
  const session = Session.create(SessionId('search-checkout'))
  const message = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const a = session.append('user/message', message('original A'), { surfaceOp: 'append' })
  const b = session.append('user/message', message('original B'), { surfaceOp: 'append' })
  session.append('user/message', message('summary'), { surfaceOp: { op: 'replace', startSeq: a.seq, endSeq: b.seq }, sourceEventSeqs: [a.seq, b.seq] })
  session.checkout(a.seq)
  const docs = buildSessionEventSearchDocuments(session.id, session.snapshotEvents())
  expect(docs.find(row => row.seq === a.seq)?.surface).toBe('current')
  expect(docs.find(row => row.seq === b.seq)?.text).toContain('original B')
})
