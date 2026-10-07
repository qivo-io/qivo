import { describe, expect, it } from 'vitest'
import { roadmapEdges } from './roadmapEdges'

describe('roadmap week-count edges', () => {
  // The visible weeks are 10 through 17, including both boundary weeks.
  it.each([
    [10, 17],
    [12, 15],
    [10, 10],
    [17, 17],
  ])('does not mark a fully visible period %i–%i', (start, end) => {
    expect(roadmapEdges(start, end, 10, 17)).toEqual({ left: null, right: null })
  })

  it('counts the hidden beginning and reveals the planned start', () => {
    expect(roadmapEdges(7, 12, 10, 17)).toEqual({
      left: { kind: 'continuation', weeks: 3, endpoint: 7 },
      right: null,
    })
  })

  it('counts the hidden ending and reveals the planned end', () => {
    expect(roadmapEdges(15, 22, 10, 17)).toEqual({
      left: null,
      right: { kind: 'continuation', weeks: 5, endpoint: 22 },
    })
  })

  it('marks both continuations when the task spans the entire window', () => {
    expect(roadmapEdges(7, 22, 10, 17)).toEqual({
      left: { kind: 'continuation', weeks: 3, endpoint: 7 },
      right: { kind: 'continuation', weeks: 5, endpoint: 22 },
    })
  })

  it('treats touching a boundary week as a visible continuation, not an outside task', () => {
    expect(roadmapEdges(7, 10, 10, 17)).toEqual({
      left: { kind: 'continuation', weeks: 3, endpoint: 7 },
      right: null,
    })
    expect(roadmapEdges(17, 22, 10, 17)).toEqual({
      left: null,
      right: { kind: 'continuation', weeks: 5, endpoint: 22 },
    })
  })

  it('counts only the complete gap after an earlier task and reveals its end', () => {
    // Weeks 8 and 9 intervene; the task's duration does not contribute.
    expect(roadmapEdges(-20, 7, 10, 17)).toEqual({
      left: { kind: 'outside', weeks: 2, endpoint: 7 },
      right: null,
    })
  })

  it('counts only the complete gap before a later task and reveals its start', () => {
    // Weeks 18 through 21 intervene, excluding both endpoints.
    expect(roadmapEdges(22, 40, 10, 17)).toEqual({
      left: null,
      right: { kind: 'outside', weeks: 4, endpoint: 22 },
    })
  })

  it('keeps a detached zero-week marker for tasks immediately outside either boundary', () => {
    expect(roadmapEdges(7, 9, 10, 17)).toEqual({
      left: { kind: 'outside', weeks: 0, endpoint: 9 },
      right: null,
    })
    expect(roadmapEdges(18, 22, 10, 17)).toEqual({
      left: null,
      right: { kind: 'outside', weeks: 0, endpoint: 18 },
    })
  })

  it('changes an outside marker to a continuation when panning reveals the endpoint', () => {
    const initial = roadmapEdges(7, 9, 10, 17)
    const revealed = roadmapEdges(7, 9, initial.left!.endpoint, 16)
    expect(revealed).toEqual({
      left: { kind: 'continuation', weeks: 2, endpoint: 7 },
      right: null,
    })
    expect(roadmapEdges(7, 9, revealed.left!.endpoint, 14)).toEqual({
      left: null,
      right: null,
    })
  })

  it('preserves the inclusive semantics in a single-week window', () => {
    expect(roadmapEdges(9, 11, 10, 10)).toEqual({
      left: { kind: 'continuation', weeks: 1, endpoint: 9 },
      right: { kind: 'continuation', weeks: 1, endpoint: 11 },
    })
    expect(roadmapEdges(10, 10, 10, 10)).toEqual({ left: null, right: null })
  })
})
