/* The read budgets that lib/archivedTasks.ts, lib/activeTaskPage.ts and
 * lib/core.ts build from constants of other modules, model/comments.ts
 * DOCUMENT_MAX_BYTES and lib/limits.ts MIB, are numbers whichever module
 * loads first. A value import that closes a cycle through them, such as
 * model/descriptions.ts importing lib/archivedTasks.ts, which imports it,
 * leaves them NaN when model/comments.ts loads first, and an archived page
 * then stops after one task. This file loads model/comments.ts first. */
import '../model/comments'
import { describe, expect, it } from 'vitest'
import { ACTIVE_RESERVE } from '../lib/activeTaskPage'
import { ARCHIVE_RESERVE } from '../lib/archivedTasks'
import { COMPLETION_RESERVE, TASK_READ_RESERVE } from '../lib/core'

describe('the read budgets', () => {
  it('are numbers when model/comments.ts loads first', () => {
    for (const budget of [ACTIVE_RESERVE, ARCHIVE_RESERVE, COMPLETION_RESERVE, TASK_READ_RESERVE])
      for (const value of Object.values(budget)) expect(Number.isFinite(value)).toBe(true)
  })
})
