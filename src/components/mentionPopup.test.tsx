// @vitest-environment jsdom
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Mention from '@tiptap/extension-mention'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import { astToMd } from '../lib/mdSerialize'
import { mentionStandIn } from '../store/mentionStandIn.setup'
import { docToAst, type PMNode } from './descDoc'

/* The @ mention popup in a real TipTap editor in jsdom, with the Mention
   configuration the description and comment editors use
   (descEditor.tsx), its read answered by the mention stand-in. Typing
   "@an" and Enter inserts the mention the server's notify triggers parse,
   with the caret after it, Escape leaves the draft as typed, and a second
   "@" reads again on the editor's one renderer. */

const store = vi.hoisted(() => ({ reads: [] as Promise<unknown>[] }))
const ANNA = '0b6c3d1e-7a54-4f8e-9a2b-5c1d2e3f4a5b'
const workspace: Pick<Workspace, 'myProfileIds' | 'profiles'> = {
  myProfileIds: ['me'],
  profiles: [
    { id: 'me', name: 'Mira Holm', initials: 'MH', email: 'mira@qivo.test' },
    { id: ANNA, name: 'Anna Fält', initials: 'AF', email: 'anna@qivo.test' },
    { id: 'erik', name: 'Erik Holm', initials: 'EH', email: 'erik@qivo.test' },
  ].map(
    (p) =>
      ({
        ...p,
        org_id: 'org-task',
        color: '#335577',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: '2026-09-14T08:00:00.000Z',
      }) as Workspace['profiles'][number],
  ),
}
vi.mock('../store/planner', () => ({
  P: {
    homeOrg: 'org-task',
    mentionChoices: (org: string, search: string, cursor: string | null) => {
      const read = Promise.resolve(
        mentionStandIn(workspace, {
          org_id: org,
          ...(search ? { search } : {}),
          ...(cursor ? { after: cursor } : {}),
        }),
      )
      store.reads.push(read)
      return read
    },
    user: () => undefined,
  },
}))
vi.mock('../lib/convex', () => ({ live: {}, convex: {} }))

const { mentionSuggestion, MENTION_DELAY_MS } = await import('./mentionSuggestion')

let editor: Editor

beforeEach(() => {
  vi.useFakeTimers()
  Element.prototype.scrollIntoView = () => {}
  // jsdom lays nothing out; the editor measures the caret to scroll to it
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  store.reads.length = 0
  const element = document.createElement('div')
  element.setAttribute('data-qivo-org', 'org-task')
  document.body.append(element)
  editor = new Editor({
    element,
    extensions: [
      Document,
      Paragraph,
      Text,
      Mention.configure({
        HTMLAttributes: { class: 'mention' },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        deleteTriggerWithBackspace: true,
        suggestion: mentionSuggestion,
      }),
    ],
    content: '<p>Ask</p>',
  })
  editor.view.dom.setAttribute('data-qivo-org', 'org-task')
})

afterEach(() => {
  editor.destroy()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

/* The draft as stored text, in the dialect the server parses. */
const stored = () => astToMd(docToAst(editor.getJSON() as PMNode))
const key = (name: string) =>
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
const popup = () => document.querySelector<HTMLElement>('[data-mention-popup]')

describe('the mention popup in an editor', () => {
  it('inserts the mention an Enter pressed at once picks, with the caret after it', async () => {
    editor.chain().focus('end').insertContent(' @an').run()
    expect(popup()).not.toBeNull()
    // Enter before the read: it acts once the answer for "an" arrives
    key('Enter')
    expect(store.reads).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(MENTION_DELAY_MS)
    expect(store.reads).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(0)
    // the node and the space the Mention extension puts after it
    expect(stored()).toBe(`Ask @[Anna Fält](user:${ANNA}) `)
    const end = editor.state.doc.content.size - 1
    expect(editor.state.selection.from).toBe(end)
    expect(popup()).toBeNull()
  })

  it('leaves with Escape, keeping the draft as typed', async () => {
    editor.chain().focus('end').insertContent(' @er').run()
    await vi.advanceTimersByTimeAsync(MENTION_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(popup()?.querySelector('[data-mention-id="erik"]')).not.toBeNull()
    key('Escape')
    await vi.advanceTimersByTimeAsync(0)
    expect(popup()).toBeNull()
    expect(stored()).toBe('Ask @er')
  })

  it('reads again for a second "@" with the words the first popup ended on', async () => {
    editor.chain().focus('end').insertContent(' @an').run()
    await vi.advanceTimersByTimeAsync(MENTION_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    key('Escape')
    await vi.advanceTimersByTimeAsync(0)
    expect(popup()).toBeNull()
    // the editor opens its next popup on the same renderer
    editor.chain().focus('end').insertContent(' @an').run()
    expect(popup()?.querySelector('[data-mention-stale]')).toBeNull()
    await vi.advanceTimersByTimeAsync(MENTION_DELAY_MS)
    expect(store.reads).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(0)
    key('Enter')
    expect(stored()).toBe(`Ask @an @[Anna Fält](user:${ANNA}) `)
  })
})
