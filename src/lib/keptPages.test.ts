import { describe, expect, it } from 'vitest'
import { type KeptPages, keptPages, type MainPage, NO_PAGES, releasePages } from './keptPages'

/** Walks the pages `shown` in order in `scope`, from nothing kept. */
const walk = (scope: string | null, ...shown: (MainPage | null)[]) =>
  shown.reduce<KeptPages>(
    (kept, page) => keptPages({ kept, scope, scopeLive: true, shown: page }),
    NO_PAGES,
  )

describe('the main pages that stay loaded', () => {
  it('keeps every page the person opened, and keeps them while Settings shows', () => {
    const kept = walk('p1', 'inbox', 'kanban', 'overview', 'roadmap', 'sync', 'projects', null)
    expect(kept).toEqual({
      scope: 'p1',
      pages: ['inbox', 'kanban', 'overview', 'roadmap', 'sync', 'projects'],
    })
  })

  it('answers the same value when nothing changed', () => {
    const kept = walk('p1', 'kanban', 'overview')
    expect(keptPages({ kept, scope: 'p1', scopeLive: true, shown: 'kanban' })).toBe(kept)
    expect(keptPages({ kept, scope: 'p1', scopeLive: true, shown: null })).toBe(kept)
  })

  it('ends the pages of the old scope with a new one, and keeps the others', () => {
    const kept = walk('p1', 'kanban', 'roadmap', 'inbox')
    expect(keptPages({ kept, scope: 'p2', scopeLive: true, shown: 'overview' })).toEqual({
      scope: 'p2',
      pages: ['inbox', 'overview'],
    })
    expect(keptPages({ kept, scope: 'p2', scopeLive: true, shown: 'inbox' })).toEqual({
      scope: 'p2',
      pages: ['inbox'],
    })
  })

  it('keeps no page of a scope that is gone', () => {
    const kept = walk('p1', 'kanban', 'sync')
    expect(keptPages({ kept, scope: 'p1', scopeLive: false, shown: 'kanban' })).toEqual({
      scope: null,
      pages: ['sync'],
    })
    expect(keptPages({ kept: NO_PAGES, scope: null, scopeLive: true, shown: 'overview' })).toBe(
      NO_PAGES,
    )
  })

  it('keeps only the page on screen once released', () => {
    const kept = walk('p1', 'inbox', 'kanban', 'overview')
    expect(releasePages(kept, 'overview')).toEqual({ scope: 'p1', pages: ['overview'] })
    // in Settings no main page shows, so none stays
    expect(releasePages(kept, null)).toEqual({ scope: 'p1', pages: [] })
    const one = walk('p1', 'kanban')
    expect(releasePages(one, 'kanban')).toBe(one)
  })
})
