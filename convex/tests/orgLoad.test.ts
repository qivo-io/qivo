/* The organization-wide load fence the tests keep as their oracle
 * (orgLoad.setup.ts): its group rule over the rows it reads, which the
 * owner reader, the workload pages and the app's load rows are pinned
 * against. */

import { describe, expect, it } from 'vitest'
import { groupTest } from './orgLoad.setup'

const NOW = '2026-01-01T00:00:00.000Z'

describe('the oracle’s group rule', () => {
  it('makes a task a group by the subtasks among its rows', () => {
    const live = (id: string) => id === 'on'
    const rows = [
      { parent_id: 'a', archived_at: undefined, project_id: 'off' },
      { parent_id: 'b', archived_at: undefined, project_id: 'on' },
      { parent_id: 'c', archived_at: NOW, project_id: 'on' },
    ]
    const isGroup = groupTest(rows, live)
    const at = (id: string, project_id: string, archived_at?: string) => ({
      id,
      project_id,
      archived_at,
    })
    // an active parent in a live project counts only active subtasks in
    // live projects
    expect(isGroup(at('a', 'on'))).toBe(false)
    // an active parent in an archived project counts every active subtask
    expect(isGroup(at('a', 'off'))).toBe(true)
    expect(isGroup(at('b', 'on'))).toBe(true)
    // an archived subtask counts only for an archived parent
    expect(isGroup(at('c', 'on'))).toBe(false)
    expect(isGroup(at('c', 'on', NOW))).toBe(true)
    // a task without subtasks among the rows is no group
    expect(isGroup(at('d', 'on'))).toBe(false)
  })
})
