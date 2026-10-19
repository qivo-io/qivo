/* Long result lists in parts (lib/arrayLimit.ts): no array past the limit,
 * and the parts join back to the lists, in order. */
import { afterEach, describe, expect, it } from 'vitest'
import { ARRAY_LIMIT, chunkLists, joinLists } from '../lib/arrayLimit'

afterEach(() => {
  ARRAY_LIMIT.max = 8192
})

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('chunkLists', () => {
  it('leaves lists within the limit as they are, without `more`', () => {
    const lists = { issues: range(8192), labels: [] as number[] }
    const out = chunkLists(lists)
    expect(out).toEqual(lists)
    expect('more' in out).toBe(false)
  })

  it('keeps the first values under the name and the rest in parts of at most the limit', () => {
    const out = chunkLists({ issues: range(20_000), labels: ['a'] })
    expect(out.issues).toEqual(range(8192))
    expect(out.labels).toEqual(['a'])
    expect(out.more?.issues?.map((part) => part.length)).toEqual([8192, 20_000 - 2 * 8192])
    expect(out.more?.labels).toBeUndefined()
    expect(joinLists(out)).toEqual({ issues: range(20_000), labels: ['a'] })
  })

  it('splits at a lowered limit too, and joins back in order', () => {
    ARRAY_LIMIT.max = 3
    const out = chunkLists({ issues: range(7), links: range(3), labels: range(4) })
    expect(out).toEqual({
      issues: [0, 1, 2],
      links: [0, 1, 2],
      labels: [0, 1, 2],
      more: { issues: [[3, 4, 5], [6]], labels: [[3]] },
    })
    expect(joinLists({ auth_user_id: 'me', ...out })).toEqual({
      auth_user_id: 'me',
      issues: range(7),
      links: range(3),
      labels: range(4),
    })
  })
})
