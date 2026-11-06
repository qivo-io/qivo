// @vitest-environment jsdom
import type { Editor } from '@tiptap/core'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import { limitSentence, sentence } from '../lib/fieldLimits'
import { type ForcedMentions, mentionStandIn } from '../store/mentionStandIn.setup'

/* The editor's @ mention popup (mentionSuggestion.ts) driven as TipTap
   drives its renderer, with the store's read (P.mentionChoices) answered by
   the mention stand-in (store/mentionStandIn.setup.ts) when a test lets
   each read through, so answers can come late, out of order or not at all.
   Timers are fake, so the 150 ms rest is exact. */

type Choices = ReturnType<typeof mentionStandIn> | { state: 'refused'; message: string } | null
/* One read the popup sent, and how to answer it. */
type Read = { org: string; search: string; cursor: string | null; resolve: (a: Choices) => void }

const store = vi.hoisted(() => ({
  reads: [] as Read[],
  pictures: new Map<string, { avatarPath: string; avatarUrl: string }>(),
}))
vi.mock('../store/planner', () => ({
  P: {
    homeOrg: 'org-home',
    mentionChoices: (org: string, search: string, cursor: string | null) =>
      new Promise((resolve) => store.reads.push({ org, search, cursor, resolve })),
    user: (id: string) => store.pictures.get(id),
  },
}))
vi.mock('../lib/convex', () => ({ live: {}, convex: {} }))

const { mentionSuggestion, MENTION_DELAY_MS } = await import('./mentionSuggestion')

/* A profile of `org` as the workspace holds it. */
const person = (
  org: string,
  id: string,
  name: string,
  initials: string,
  email: string | null,
  color = '#335577',
) =>
  ({
    id,
    org_id: org,
    name,
    initials,
    color,
    org_role: 'user',
    active: true,
    kind: email ? 'person' : 'agent',
    created_at: '2026-09-14T08:00:00.000Z',
    ...(email ? { email } : {}),
  }) as Workspace['profiles'][number]

/* What the server holds: the task's organization with Anna, Erik and 20
   more, and my home organization with another Anna. */
const workspace: Pick<Workspace, 'myProfileIds' | 'profiles'> = {
  myProfileIds: ['me', 'me-home'],
  profiles: [
    person('org-task', 'me', 'Mira Holm', 'MH', 'mira@qivo.test'),
    person('org-task', 'anna', 'Anna Fält', 'AF', 'anna@qivo.test', '#aa3355'),
    person('org-task', 'erik', 'Erik Holm', 'EH', 'erik@qivo.test'),
    ...Array.from({ length: 20 }, (_, i) =>
      person('org-task', `p${i}`, `Person ${String(i).padStart(2, '0')}`, 'PE', null),
    ),
    person('org-home', 'me-home', 'Mira Holm', 'MH', 'mira@home.test'),
    person('org-home', 'home-anna', 'Anna Fält', 'AF', 'anna@home.test'),
  ],
}

/* Answers `read` as P.mentionChoices does: the stand-in's batch, a refusal
   with the server's sentence, or null for a failure. */
function answerOf(read: Read, force?: ForcedMentions): Choices {
  try {
    return mentionStandIn(
      workspace,
      {
        org_id: read.org,
        ...(read.search ? { search: read.search } : {}),
        ...(read.cursor ? { after: read.cursor } : {}),
      },
      { force },
    )
  } catch (e) {
    if (e instanceof ConvexError) return { state: 'refused', message: sentence(e.data.message) }
    return null
  }
}

/* Lets the newest read (or `read`) through and the popup take its answer. */
async function answer(read = store.reads.at(-1), force?: ForcedMentions) {
  if (!read) throw new Error('no read on its way')
  read.resolve(answerOf(read, force))
  await vi.advanceTimersByTimeAsync(0)
}
const fail = async (read = store.reads.at(-1)) => {
  read?.resolve(null)
  await vi.advanceTimersByTimeAsync(0)
}
const rest = (ms = MENTION_DELAY_MS) => vi.advanceTimersByTimeAsync(ms)

/* A popup as TipTap drives it in an editor of organization `org`. TipTap
   calls `render` once for each editor, so `start` after `exit` opens the
   editor's next popup on the same renderer. */
function popup(org: string | null = 'org-task') {
  let el: HTMLElement | null = null
  const command = vi.fn()
  const view = mentionSuggestion.render?.()
  if (!view?.onStart || !view.onUpdate || !view.onKeyDown || !view.onExit)
    throw new Error('no renderer')
  const editor = { view: { dom: { getAttribute: () => org } } } as unknown as Editor
  type Props = Parameters<NonNullable<typeof view.onStart>>[0]
  const props = (query: string) =>
    ({
      query,
      items: [],
      editor,
      command,
      mount: (node: HTMLElement) => {
        el = node
        document.body.append(node)
        return () => node.remove()
      },
    }) as unknown as Props
  const key = (name: string) =>
    view.onKeyDown?.({
      event: new KeyboardEvent('keydown', { key: name }),
    } as Parameters<NonNullable<typeof view.onKeyDown>>[0])
  return {
    start: (query = '') => view.onStart?.(props(query)),
    type: (query: string) => view.onUpdate?.(props(query)),
    key,
    exit: () => view.onExit?.(props('')),
    el: () => el,
    command,
  }
}
type Popup = ReturnType<typeof popup>

const state = (p: Popup) => p.el()?.getAttribute('data-mention-state')
const ids = (p: Popup) =>
  [...(p.el()?.querySelectorAll<HTMLElement>('[data-mention-id]') ?? [])].map(
    (row) => row.dataset.mentionId,
  )
const stale = (p: Popup) => p.el()?.querySelectorAll('[data-mention-stale]').length ?? 0
const lines = (p: Popup) =>
  [...(p.el()?.querySelectorAll('[data-mention-end]') ?? [])].map((line) => line.textContent)
const active = (p: Popup) =>
  p.el()?.querySelector<HTMLElement>('.mentionpop-row.active')?.dataset.mentionId ??
  (p.el()?.querySelector('.mentionpop-row.active[data-mention-more]') ? 'more' : null) ??
  (p.el()?.querySelector('.mentionpop-row.active[data-mention-retry]') ? 'retry' : null)
const press = (element: Element | null | undefined) =>
  element?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

beforeEach(() => {
  vi.useFakeTimers()
  Element.prototype.scrollIntoView = () => {}
  store.reads.length = 0
  store.pictures.clear()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('the mention popup', () => {
  it('reads nothing until it opens, then once typing rests 150 ms, and nothing for words that did not change', async () => {
    const p = popup()
    expect(store.reads).toEqual([])
    p.start()
    await rest(MENTION_DELAY_MS - 1)
    expect(store.reads).toEqual([])
    expect(state(p)).toBe('loading')
    expect(lines(p)).toEqual(['Searching…'])
    await rest(1)
    expect(store.reads.map((r) => [r.org, r.search, r.cursor])).toEqual([['org-task', '', null]])
    await answer()
    expect(ids(p)).toHaveLength(8)
    // typing that keeps resting less than 150 ms reads only at its end
    for (const q of ['a', 'an', 'ann']) {
      p.type(q)
      await rest(100)
    }
    expect(store.reads).toHaveLength(1)
    await rest(50)
    expect(store.reads.map((r) => r.search)).toEqual(['', 'ann'])
    await answer()
    // the same words in another case or spacing read nothing
    p.type(' ANN ')
    await rest(500)
    expect(store.reads).toHaveLength(2)
    expect(ids(p)).toEqual(['anna'])
  })

  it("matches by the server's rule in the editor's organization, else the home one", async () => {
    const p = popup()
    p.start('ält ann')
    await rest()
    expect(store.reads.at(-1)).toMatchObject({ org: 'org-task', search: 'ält ann' })
    await answer()
    expect(ids(p)).toEqual(['anna'])
    p.exit()
    const home = popup(null)
    home.start('anna')
    await rest()
    expect(store.reads.at(-1)?.org).toBe('org-home')
    await answer()
    expect(ids(home)).toEqual(['home-anna'])
  })

  it('shows only the newest answer when two arrive out of order', async () => {
    const p = popup()
    p.start('anna')
    await rest()
    const first = store.reads.at(-1)
    p.type('erik')
    await rest()
    const second = store.reads.at(-1)
    await answer(second)
    expect(ids(p)).toEqual(['erik'])
    await answer(first)
    expect(ids(p)).toEqual(['erik'])
  })

  it('keeps the last rows dimmed and unpickable while the next answer is on its way', async () => {
    const p = popup()
    p.start('holm')
    await rest()
    await answer()
    expect(ids(p)).toEqual(['erik', 'me'])
    p.type('holm e')
    expect(state(p)).toBe('stale')
    expect(stale(p)).toBe(2)
    expect(lines(p)).toEqual(['Searching…'])
    expect(active(p)).toBeNull()
    press(p.el()?.querySelector('[data-mention-id="erik"]'))
    expect(p.command).not.toHaveBeenCalled()
    // arrow keys wait for the answer
    p.key('ArrowDown')
    await rest()
    await answer()
    expect(state(p)).toBe('ok')
    expect(active(p)).toBe('erik')
    // an Enter while Erik's row shows dimmed waits for Mira's answer
    p.type('mira')
    expect(stale(p)).toBe(2)
    p.key('Enter')
    expect(p.command).not.toHaveBeenCalled()
    await rest()
    await answer()
    expect(p.command).toHaveBeenCalledWith({ id: 'me', label: 'Mira Holm' })
  })

  it('picks the first row of the answer an Enter waited for, and drops it when the text changes first', async () => {
    const p = popup()
    p.start('an')
    expect(p.key('Enter')).toBe(true)
    await rest()
    expect(p.command).not.toHaveBeenCalled()
    await answer()
    expect(p.command).toHaveBeenCalledWith({ id: 'anna', label: 'Anna Fält' })
    const q = popup()
    q.start('an')
    q.key('Tab')
    q.type('erik')
    await rest()
    await answer()
    expect(q.command).not.toHaveBeenCalled()
    expect(ids(q)).toEqual(['erik'])
  })

  it('loads 8 more, inert while it reads, and moves the highlight to the first new row', async () => {
    const p = popup()
    p.start('person')
    await rest()
    await answer()
    expect(ids(p)).toHaveLength(8)
    const more = () => p.el()?.querySelector<HTMLElement>('[data-mention-more]')
    expect(more()?.textContent).toBe('Load more')
    // the arrow keys reach it as the last row, and Enter presses it
    for (let i = 0; i < 8; i++) p.key('ArrowDown')
    expect(active(p)).toBe('more')
    p.key('Enter')
    expect(more()?.textContent).toBe('Loading…')
    press(more())
    p.key('Enter')
    expect(store.reads).toHaveLength(2)
    expect(store.reads[1].cursor).not.toBeNull()
    await answer()
    expect(ids(p)).toHaveLength(16)
    expect(active(p)).toBe(ids(p)[8])
  })

  it('keeps its rows with Try again after a failed Load more, and reads that place again', async () => {
    const p = popup()
    p.start('person')
    await rest()
    await answer()
    press(p.el()?.querySelector('[data-mention-more]'))
    await fail()
    expect(ids(p)).toHaveLength(8)
    expect(state(p)).toBe('failed')
    expect(lines(p)).toEqual(["Couldn't load more people."])
    expect(active(p)).toBe(ids(p)[0])
    press(p.el()?.querySelector('[data-mention-retry]'))
    expect(store.reads.at(-1)?.cursor).toBe(store.reads[1].cursor)
    await answer()
    expect(ids(p)).toHaveLength(16)
    // its batch moves the highlight as Load more's does
    expect(active(p)).toBe(ids(p)[8])
  })

  it('reaches Try again with the keys after a failed first read, where Enter and Tab read again', async () => {
    const p = popup()
    p.start('anna')
    await rest()
    await fail()
    expect([state(p), lines(p)]).toEqual(['failed', ["Couldn't load people."]])
    // the one row the keys reach
    p.key('ArrowDown')
    expect(active(p)).toBe('retry')
    expect(p.key('Enter')).toBe(true)
    expect(store.reads).toHaveLength(2)
    await fail()
    expect(active(p)).toBe('retry')
    expect(p.key('Tab')).toBe(true)
    expect(store.reads).toHaveLength(3)
    await answer()
    expect(ids(p)).toEqual(['anna'])
    expect(p.command).not.toHaveBeenCalled()
  })

  it("reaches a failed Load more's Try again after the rows, and its batch moves the highlight to the first new row", async () => {
    const p = popup()
    p.start('person')
    await rest()
    await answer()
    for (let i = 0; i < 8; i++) p.key('ArrowDown')
    p.key('Enter')
    await fail()
    expect(lines(p)).toEqual(["Couldn't load more people."])
    // the highlight stays in Load more's place, now Try again's
    expect(active(p)).toBe('retry')
    p.key('ArrowDown')
    expect(active(p)).toBe(ids(p)[0])
    p.key('ArrowUp')
    expect(active(p)).toBe('retry')
    p.key('Enter')
    expect(store.reads).toHaveLength(3)
    expect(store.reads[2].cursor).toBe(store.reads[1].cursor)
    await answer()
    expect(ids(p)).toHaveLength(16)
    expect(active(p)).toBe(ids(p)[8])
    expect(p.command).not.toHaveBeenCalled()
  })

  it('tells each state apart, and says No matching members only at the real end', async () => {
    const p = popup()
    p.start('anna')
    await rest()
    await fail()
    expect([state(p), lines(p)]).toEqual(['failed', ["Couldn't load people."]])
    press(p.el()?.querySelector('[data-mention-retry]'))
    await answer(undefined, { notReady: true })
    expect([state(p), lines(p)]).toEqual(['held', ["People can't be listed yet."]])
    p.type('erik')
    await rest()
    store.reads.at(-1)?.resolve({ state: 'refused', message: 'This search was refused.' })
    await rest(0)
    expect([state(p), lines(p)]).toEqual(['held', ['This search was refused.']])
    p.type('nobody')
    await rest()
    await answer(undefined, { stop: 3 })
    expect(lines(p)).toEqual(['Showing the people found so far.'])
    expect(p.el()?.querySelector('[data-mention-more]')).not.toBeNull()
    p.type('nobody here')
    await rest()
    await answer()
    expect([state(p), lines(p)]).toEqual(['ok', ['No matching members']])
    p.type('x'.repeat(LIMITS.search.max + 1))
    await rest()
    expect(store.reads.at(-1)?.search).toBe('nobody here')
    expect([state(p), lines(p)]).toEqual(['held', [limitSentence(LIMITS.search)]])
  })

  it('measures LIMITS.search on the words it reads, so a text long only by its spaces reads and its correction keeps that read', async () => {
    const p = popup()
    // past the limit only through its spaces: the words are "anna fält"
    p.start(`anna${' '.repeat(LIMITS.search.max)}fält`)
    expect([state(p), lines(p)]).toEqual(['loading', ['Searching…']])
    await rest()
    // taking spaces out keeps the words, so it reads nothing new
    p.type(`anna${' '.repeat(LIMITS.search.max - 10)}fält`)
    await rest()
    expect(store.reads.map((r) => r.search)).toEqual(['anna fält'])
    await answer()
    expect([state(p), ids(p)]).toEqual(['ok', ['anna']])
    expect(p.key('Enter')).toBe(true)
    expect(p.command).toHaveBeenCalledWith({ id: 'anna', label: 'Anna Fält' })
  })

  it('says no match without a read for a text that starts with one that matched nobody', async () => {
    const p = popup()
    p.start('zz')
    await rest()
    await answer()
    expect(lines(p)).toEqual(['No matching members'])
    const reads = store.reads.length
    p.type('zzq')
    await rest()
    p.type('zz q')
    await rest()
    expect(store.reads).toHaveLength(reads)
    expect(lines(p)).toEqual(['No matching members'])
    // a stopped or failed search proves nothing
    p.type('qq')
    await rest()
    await answer(undefined, { stop: 3 })
    p.type('qqa')
    await rest()
    expect(store.reads).toHaveLength(reads + 2)
  })

  it('highlights the first row of a new text, not the place a Load more of the text before began', async () => {
    const p = popup()
    p.start()
    await rest()
    await answer(undefined, { stop: 3 })
    expect(ids(p)).toEqual(['anna', 'erik', 'me'])
    press(p.el()?.querySelector('[data-mention-more]'))
    // the text changes while that Load more reads
    p.type('person')
    await rest()
    await answer()
    expect(ids(p)).toHaveLength(8)
    expect(active(p)).toBe(ids(p)[0])
  })

  it('starts the next popup of one editor afresh, reading again for the words the last one ended on', async () => {
    const p = popup()
    p.start()
    await rest()
    await answer()
    p.key('ArrowDown')
    p.key('Enter')
    expect(p.command).toHaveBeenLastCalledWith({ id: 'erik', label: 'Erik Holm' })
    p.exit()
    // "@" again in the same editor, with the same (empty) words
    p.start()
    expect(stale(p)).toBe(0)
    expect([state(p), lines(p)]).toEqual(['loading', ['Searching…']])
    await rest()
    expect(store.reads.map((r) => r.search)).toEqual(['', ''])
    await answer()
    expect(active(p)).toBe('anna')
    expect(p.key('Enter')).toBe(true)
    expect(p.command).toHaveBeenLastCalledWith({ id: 'anna', label: 'Anna Fält' })
  })

  it('asks again in the next popup of one editor for a text that matched nobody in the last one', async () => {
    const p = popup()
    p.start('zz')
    await rest()
    await answer()
    expect(lines(p)).toEqual(['No matching members'])
    p.exit()
    p.start('zzq')
    expect(lines(p)).toEqual(['Searching…'])
    await rest()
    expect(store.reads.map((r) => r.search)).toEqual(['zz', 'zzq'])
    await answer()
    expect(lines(p)).toEqual(['No matching members'])
  })

  it('stops at PICKER_CAPS.mentions and asks for more typing', async () => {
    const { PICKER_CAPS } = await import('../lib/pickerCaps')
    const was = PICKER_CAPS.mentions
    PICKER_CAPS.mentions = 16
    try {
      const p = popup()
      p.start('person')
      await rest()
      await answer()
      press(p.el()?.querySelector('[data-mention-more]'))
      await answer()
      expect(ids(p)).toHaveLength(16)
      expect(p.el()?.querySelector('[data-mention-more]')).toBeNull()
      expect(lines(p)).toEqual(['Keep typing to find more people.'])
    } finally {
      PICKER_CAPS.mentions = was
    }
  })

  it('drops a late answer on leaving and leaves no popup behind', async () => {
    const p = popup()
    p.start('anna')
    await rest()
    p.exit()
    expect(document.querySelector('[data-mention-popup]')).toBeNull()
    await answer()
    expect(document.querySelector('[data-mention-popup]')).toBeNull()
    expect(p.command).not.toHaveBeenCalled()
    // a timer still running reads nothing after leaving
    const q = popup()
    q.start('erik')
    q.exit()
    await rest(1000)
    expect(store.reads).toHaveLength(1)
  })

  it("paints the row's portrait, and a picture only from the store", async () => {
    store.pictures.set('erik', { avatarPath: 'storage-1', avatarUrl: 'https://example.test/erik' })
    const p = popup()
    p.start('holm')
    await rest()
    await answer()
    const av = (id: string) =>
      p.el()?.querySelector<HTMLElement>(`[data-mention-id="${id}"] .mentionpop-av`)
    expect(av('me')?.textContent).toBe('MH')
    expect(av('me')?.querySelector('img')).toBeNull()
    expect(av('erik')?.querySelector('img')?.getAttribute('src')).toBe('https://example.test/erik')
    expect(p.el()?.querySelector('[title]')).toBeNull()
  })
})
