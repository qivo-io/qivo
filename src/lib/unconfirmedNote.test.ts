import { describe, expect, it } from 'vitest'
import { createUnconfirmedNote, unconfirmedText } from './unconfirmedNote'

/** A Storage double over a Map, in insertion order. */
function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    get length() {
      return items.size
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

const SCOPE = 'org-1:profile-1'

describe('unconfirmed note', () => {
  function pages(storage = memoryStorage(), live: string[] = []) {
    const open = (page: string) =>
      createUnconfirmedNote({ storage: () => storage, page, livePages: async () => new Set(live) })
    return { storage, open }
  }

  it('notes a sent change and clears it when the server answers', () => {
    const { storage, open } = pages()
    const note = open('a')
    const done = note.add(SCOPE, { task: 'QN-12', what: 'description' })
    const stored = JSON.parse(storage.getItem(`qivo.unconfirmed.v1:${SCOPE}:a`) ?? '[]')
    expect(stored).toEqual([
      { task: 'QN-12', what: 'description', id: '1', at: expect.any(Number) },
    ])
    done()
    expect(storage.items.size).toBe(0)
  })

  it('reports the notes of a closed page once, and leaves those of open pages', async () => {
    const { storage, open } = pages(memoryStorage(), ['still-open'])
    open('crashed').add(SCOPE, { task: 'QN-12', what: 'description' })
    open('still-open').add(SCOPE, { task: 'QN-14', what: 'comment' })
    open('crashed').add('org-2:profile-2', { task: 'QN-1', what: 'title' })
    const next = open('next')
    expect(await next.collect([SCOPE])).toEqual([
      { task: 'QN-12', what: 'description', scope: SCOPE },
    ])
    expect(await next.collect([SCOPE])).toEqual([])
    expect([...storage.items.keys()]).toEqual([
      `qivo.unconfirmed.v1:${SCOPE}:still-open`,
      'qivo.unconfirmed.v1:org-2:profile-2:crashed',
    ])
  })

  it('reports nothing when the browser cannot tell which pages are open', async () => {
    const storage = memoryStorage()
    const open = (page: string) =>
      createUnconfirmedNote({ storage: () => storage, page, livePages: async () => null })
    open('maybe-open').add(SCOPE, { task: 'QN-12', what: 'description' })
    storage.setItem(
      `qivo.unconfirmed.v1:${SCOPE}:long-gone`,
      JSON.stringify([{ task: 'QN-1', what: 'title', id: '1', at: 0 }]),
    )
    expect(await open('next').collect([SCOPE])).toEqual([])
    expect([...storage.items.keys()]).toEqual([`qivo.unconfirmed.v1:${SCOPE}:maybe-open`])
  })

  it('drops a month-old note in any scope, and leaves a fresh one of another person', async () => {
    const { storage, open } = pages()
    storage.setItem(
      'qivo.unconfirmed.v1:org-9:left-org:gone',
      JSON.stringify([{ task: 'QN-1', what: 'title', id: '1', at: 0 }]),
    )
    open('other-person').add('org-8:someone-else', { task: 'QN-2', what: 'title' })
    expect(await open('next').collect([SCOPE])).toEqual([])
    expect([...storage.items.keys()]).toEqual([
      'qivo.unconfirmed.v1:org-8:someone-else:other-person',
    ])
  })

  it('never reports its own page, and a sign-out clears every note in the browser', async () => {
    const { storage, open } = pages()
    const note = open('a')
    note.add(SCOPE, { task: null, what: 'a project change' })
    open('b').add(SCOPE, { task: 'QN-3', what: 'archive' })
    open('c').add('org-8:someone-else', { task: 'QN-2', what: 'title' })
    note.forgetAll()
    expect(storage.items.size).toBe(0)
    note.add(SCOPE, { task: 'QN-4', what: 'title' })
    expect(await note.collect([SCOPE])).toEqual([])
  })
})

describe('unconfirmed text', () => {
  it('names the task for one change and lists several', () => {
    expect(unconfirmedText([])).toBeNull()
    expect(unconfirmedText([{ task: 'QN-12', what: 'description' }])).toBe(
      'Qivo closed before it could confirm 1 change to QN-12 (description). Check the task.',
    )
    expect(
      unconfirmedText([
        { task: 'QN-12', what: 'description' },
        { task: 'QN-12', what: 'description' },
        { task: null, what: 'a project change' },
      ]),
    ).toBe(
      'Qivo closed before it could confirm 3 changes: QN-12 (description) and a project change. Check them.',
    )
  })
})
