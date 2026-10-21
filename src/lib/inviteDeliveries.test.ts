import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* What a held invitation says about when it can go again, as the clock
   moves past that time on a page left open. */

vi.mock('./convex', () => ({ convex: { onUpdate: vi.fn() } }))

const { inviteLabel } = await import('./inviteDeliveries')

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-21T10:00:00.000Z') }))
afterEach(() => vi.useRealTimers())

describe('a held invitation', () => {
  it('names the time while the hour is full, and says now once it has passed', () => {
    const freeAt = '2026-10-21T10:20:00.000Z'
    expect(inviteLabel('held', freeAt).detail).toContain('Send it again after')
    vi.setSystemTime(Date.parse(freeAt) + 1000)
    const later = inviteLabel('held', freeAt).detail
    expect(later).toContain('It was held back by the limit of 50 invitation emails an hour.')
    expect(later).toContain('Send it again now.')
    // a time not known here names none
    expect(inviteLabel('held').detail).not.toContain('Send it again')
  })
})
