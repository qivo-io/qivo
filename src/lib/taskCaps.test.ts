/* The task window's per-task caps (taskCaps.ts): a block at the cap and none
   below it, for attachments, links and labels, with the registry sentence. */
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import { attachmentBlock, labelBlock, linkBlock } from './taskCaps'

const n = (count: number) => Array.from({ length: count }, (_, i) => i)

describe('taskCaps', () => {
  it('blocks an attachment at the cap, description images counted, and not below', () => {
    expect(attachmentBlock(LIMITS.attachments.max - 1)).toBeUndefined()
    expect(attachmentBlock(LIMITS.attachments.max)).toBe(
      'This task already has 100 attachments, images in its description included, the most a task can have. Remove one first.',
    )
  })

  it('blocks a link at the cap, naming the other task when asked, and not below', () => {
    expect(linkBlock(n(LIMITS.links.max - 1))).toBeUndefined()
    expect(linkBlock(n(LIMITS.links.max))).toBe(
      'This task already has 100 links, the most a task can have. Remove one of its links first.',
    )
    expect(linkBlock(n(LIMITS.links.max), 'QN-9')).toBe(
      'QN-9 already has 100 links, the most a task can have. Remove one of its links first.',
    )
  })

  it('blocks a label at the cap and not below', () => {
    expect(labelBlock(n(LIMITS.labels.max - 1))).toBeUndefined()
    expect(labelBlock(n(LIMITS.labels.max))).toBe(
      'This task already has 20 labels, the most a task can have. Remove one first.',
    )
  })
})
