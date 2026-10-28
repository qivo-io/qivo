/* The read budgets that lib/archivedTasks.ts and lib/core.ts build from
 * model/comments.ts DOCUMENT_MAX_BYTES are numbers whichever module loads
 * first. A value import that closes a cycle through them, such as
 * model/descriptions.ts importing lib/archivedTasks.ts, which imports it,
 * leaves them NaN when model/comments.ts loads first, and an archived page
 * then stops after one task. This file loads model/comments.ts first. */
import '../model/comments'
import { describe, expect, it } from 'vitest'
import { ARCHIVE_RESERVE } from '../lib/archivedTasks'
import {
  COMMENT_READS_RESERVE,
  DESCRIPTION_READS_RESERVE,
  LABEL_READS_RESERVE,
  TASK_READ_RESERVE,
} from '../lib/core'

describe('the read budgets', () => {
  it('are numbers when model/comments.ts loads first', () => {
    for (const budget of [
      ARCHIVE_RESERVE,
      COMMENT_READS_RESERVE,
      DESCRIPTION_READS_RESERVE,
      LABEL_READS_RESERVE,
      TASK_READ_RESERVE,
    ])
      for (const value of Object.values(budget)) expect(Number.isFinite(value)).toBe(true)
  })
})
