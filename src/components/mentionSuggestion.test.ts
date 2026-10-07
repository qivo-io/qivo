import type { Editor } from '@tiptap/core'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../store/planner', () => ({
  P: {
    homeOrg: 'org-home',
    usersIn: (org: string) =>
      org === 'org-task'
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
