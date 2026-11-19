/* The group rule over the rows it reads of the organization-wide load
 * fence the tests keep as their oracle (orgLoad.setup.ts), which the owner
 * reader, the workload pages and the app's load rows are pinned against. */

import { describe, expect, it } from 'vitest'
import { groupTest } from './orgLoad.setup'

const NOW = '2026-01-01T00:00:00.000Z'

describe('the oracle’s group rule', () => {
  it('makes a task a group by the subtasks among its rows', () => {
    const rows = [
      { parent_id: 'a', org_id: 'o', archived_at: undefined, project_id: 'p' },
      { parent_id: 'c', org_id: 'o', archived_at: NOW, project_id: 'p' },
    ]
    const isGroup = groupTest(rows)
    const at = (id: string, archived_at?: string) => ({
      id,
      org_id: 'o',
      project_id: 'p',
      archived_at,
    })
    // an active subtask counts
    expect(isGroup(at('a'))).toBe(true)
    // an archived subtask counts only for an archived parent
    expect(isGroup(at('c'))).toBe(false)
    expect(isGroup(at('c', NOW))).toBe(true)
    // a task without subtasks among the rows is no group
    expect(isGroup(at('e'))).toBe(false)
  })
})
