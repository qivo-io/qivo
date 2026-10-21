/* The task window's per-task caps (taskCaps.ts): a block at the cap and none
   below it, for attachments, links and labels. */
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_MAX, LABEL_MAX, LINK_MAX } from '../../convex/lib/taskLimits'
import { attachmentBlock, labelBlock, linkBlock } from './taskCaps'

const n = (count: number) => Array.from({ length: count }, (_, i) => i)

describe('taskCaps', () => {
  it('blocks an attachment at the cap, description images counted, and not below', () => {
    expect(attachmentBlock(ATTACHMENT_MAX - 1)).toBeUndefined()
    expect(attachmentBlock(ATTACHMENT_MAX)).toBe(
      'This task has 100 attachments, images in its description included, the most a task can have',
    )
  })

  it('blocks a link at the cap, naming the other task when asked, and not below', () => {
    expect(linkBlock(n(LINK_MAX - 1))).toBeUndefined()
    expect(linkBlock(n(LINK_MAX))).toBe('This task has 100 links, the most a task can have')
    expect(linkBlock(n(LINK_MAX), 'QN-9')).toBe('QN-9 has 100 links, the most a task can have')
  })

  it('blocks a label at the cap and not below', () => {
    expect(labelBlock(n(LABEL_MAX - 1))).toBeUndefined()
    expect(labelBlock(n(LABEL_MAX))).toBe('This task has 20 labels, the most a task can have')
  })
})
