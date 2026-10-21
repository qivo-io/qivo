// @vitest-environment jsdom
import type { Editor } from '@tiptap/core'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../store/planner', () => ({
  P: {
    homeOrg: 'org-home',
    usersIn: (org: string) =>
      org === 'org-many'
        ? Array.from({ length: 12 }, (_, i) => ({
            id: `p${i}`,
            name: `Person ${i}`,
            initials: 'PE',
            email: null,
          }))
        : org === 'org-task'
          ? [
              { id: 'anna', name: 'Anna Fält', initials: 'AF', email: 'anna@qivo.test' },
              { id: 'erik', name: 'Erik Holm', initials: 'EH', email: 'erik@qivo.test' },
            ]
          : [{ id: 'home', name: 'Anna Fält', initials: 'AF', email: 'anna@home.test' }],
  },
}))

import { mentionSuggestion } from './mentionSuggestion'

const editor = {
  view: { dom: { getAttribute: () => 'org-task' } },
} as unknown as Editor
const signal = new AbortController().signal

describe('mention suggestions', () => {
  it('finds reordered name fragments and email fragments within the task organization', async () => {
    for (const query of ['ält ann', '  FÄ\tNA ', 'af', 'test ann']) {
      const rows = await mentionSuggestion.items!({ query, editor, signal })
      expect(rows.map((row) => row.id)).toEqual(['anna'])
    }
  })

  it('requires every fragment and excludes names from other organizations', async () => {
    expect(await mentionSuggestion.items!({ query: 'anna home', editor, signal })).toEqual([])
    expect(await mentionSuggestion.items!({ query: 'anna erik', editor, signal })).toEqual([])
  })
})

describe('the mention popup', () => {
  it('lists the first 8 matches and says how many more there are', async () => {
    Element.prototype.scrollIntoView = () => {}
    const crowded = { view: { dom: { getAttribute: () => 'org-many' } } } as unknown as Editor
    const items = await mentionSuggestion.items!({ query: 'person', editor: crowded, signal })
    expect(items).toHaveLength(8)
    let popup: HTMLElement | null = null
    const view = mentionSuggestion.render!()
    const props = {
      items,
      query: 'person',
      editor: crowded,
      command: () => {},
      mount: (el: HTMLElement) => {
        popup = el
        return () => {}
      },
    } as unknown as Parameters<NonNullable<typeof view.onStart>>[0]
    view.onStart?.(props)
    expect(popup!.querySelectorAll('[data-mention-option]')).toHaveLength(8)
    expect(popup!.querySelector('[data-mention-more]')?.textContent).toBe('+4 more, keep typing')
    // a query that fits shows no such line
    const one = await mentionSuggestion.items!({ query: 'person 11', editor: crowded, signal })
    view.onUpdate?.({ ...props, items: one, query: 'person 11' })
    expect(popup!.querySelector('[data-mention-more]')).toBeNull()
  })
})
