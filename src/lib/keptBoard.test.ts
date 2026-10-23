import { describe, expect, it } from 'vitest'
import { keptBoardScope } from './keptBoard'

const at = (kept: string | null, scope: string | null, boardShown: boolean, scopeLive = true) =>
  keptBoardScope({ kept, scope, scopeLive, boardShown })

describe('the scope whose Board stays loaded', () => {
  it('starts when the Board shows and stays on every other page of the scope', () => {
    expect(at(null, 'p1', false)).toBeNull()
    expect(at(null, 'p1', true)).toBe('p1')
    // the Overview, the Roadmap, the Inbox, Team sync, Projects, Settings
    expect(at('p1', 'p1', false)).toBe('p1')
  })

  it('goes with a new scope, or a scope that is gone', () => {
    expect(at('p1', 'p2', false)).toBeNull()
    expect(at('p1', 'p2', true)).toBe('p2')
    expect(at('p1', 'p1', false, false)).toBeNull()
    expect(at('p1', 'p1', true, false)).toBeNull()
    expect(at('p1', null, false)).toBeNull()
  })
})
