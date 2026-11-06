/* The read budgets that lib/archivedTasks.ts, lib/activeTaskPage.ts,
 * lib/core.ts and model/descriptions.ts build from constants of other
 * modules, model/comments.ts DOCUMENT_MAX_BYTES and lib/limits.ts MIB, are
 * numbers whichever module loads first. A value import that closes a cycle
 * through them, such as model/descriptions.ts importing
 * lib/archivedTasks.ts, which imports it, leaves them NaN when
 * model/comments.ts loads first, and an archived page then stops after one
 * task. This file loads model/comments.ts first. */
import '../model/comments'
import { describe, expect, it } from 'vitest'
import { ACTIVE_RESERVE } from '../lib/activeTaskPage'
import { ARCHIVE_RESERVE } from '../lib/archivedTasks'
import {
  COMPLETION_RESERVE,
  RELATED_READ,
  SUBTASK_PAGE,
  TASK_DETAILS,
  TASK_READ_RESERVE,
} from '../lib/core'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { TEXT_READ } from '../model/descriptions'

describe('the read budgets', () => {
  it('are numbers when model/comments.ts loads first', () => {
    for (const budget of [
      ACTIVE_RESERVE,
      ARCHIVE_RESERVE,
      COMPLETION_RESERVE,
      RELATED_READ,
      SUBTASK_PAGE,
      TASK_DETAILS,
      TASK_READ_RESERVE,
      TEXT_READ,
    ])
      for (const value of Object.values(budget)) expect(Number.isFinite(value)).toBe(true)
    // a text is charged two documents at Convex's document size limit
    expect(TEXT_READ).toEqual({ documents: 2, bytes: 2 * DOCUMENT_MAX_BYTES })
  })
})
