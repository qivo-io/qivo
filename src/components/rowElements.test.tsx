// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersonView } from '../store/viewModels'

/* A portrait as avatar() draws it (rowElements.tsx) for each state P.person
   answers, in the live scope and in a Board card's static scope, which
   draws the same DOM: a named person's initials on their color with their
   picture over them, a plain square while their details load or after a
   failed read, the dashed face named "Unknown person" only once the
   server's answer leaves them out, and Unassigned for no person. */

const people = vi.hoisted(() => new Map<string, PersonView>())
vi.mock('@/store/planner', () => ({
  P: { person: (id: string | null) => (id ? people.get(id) : null) ?? null },
}))

const { avatar } = await import('./rowElements')
const { TooltipProvider } = await import('./ui/tooltip')

const ok = (over: Partial<Extract<PersonView, { state: 'ok' }>> = {}): PersonView => ({
  state: 'ok',
  id: 'ana',
  org: 'org',
  name: 'Ana Berg',
  initials: 'AB',
  color: '#335577',
  picture: null,
  avatar: null,
  sample: false,
  kind: 'person',
  orgRole: 'user',
  active: true,
  pending: false,
  nameOnly: false,
  plannableHours: 32,
  ...over,
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  people.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** The portrait of `id` in the live scope and in the static scope. */
async function draw(id: string | null) {
  const statics = { activate: () => {} }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <div data-live="">{avatar(null, id, 28)}</div>
        <div data-static="">{avatar(statics, id, 28)}</div>
      </TooltipProvider>,
    ),
  )
  const of = (scope: string) => {
    const el = container.querySelector<HTMLElement>(`[data-${scope}] [role="img"]`)
    if (!el) throw new Error(`no portrait in the ${scope} scope`)
    return {
      label: el.getAttribute('aria-label'),
      person: el.dataset.avatar ?? null,
      state: el.dataset.avatarState ?? null,
      text: el.textContent,
      dashed: el.className.includes('border-dashed'),
      picture: el.querySelector('img')?.getAttribute('src') ?? null,
    }
  }
  const live = of('live')
  // the static scope draws the same portrait
  expect(of('static')).toEqual(live)
  return live
}

describe('avatar', () => {
  it("draws a named person's initials on their color, with their picture over them", async () => {
    people.set('ana', ok({ picture: 'blob:ana' }))
    expect(await draw('ana')).toEqual({
      label: 'Ana Berg',
      person: 'ana',
      state: null,
      text: 'AB',
      dashed: false,
      picture: 'blob:ana',
    })
  })

  it('draws a plain square while the person loads and after a failed read, never Unassigned', async () => {
    people.set('ana', { state: 'loading', id: 'ana' })
    expect(await draw('ana')).toEqual({
      label: 'Loading person…',
      person: 'ana',
      state: 'loading',
      text: '',
      dashed: false,
      picture: null,
    })
    people.set('ana', { state: 'failed', id: 'ana' })
    expect(await draw('ana')).toMatchObject({
      label: "Couldn't load this person",
      state: 'failed',
      dashed: false,
    })
  })

  it("draws the dashed face as Unknown person only for the server's answer, and Unassigned for no one", async () => {
    people.set('ana', { state: 'gone', id: 'ana' })
    expect(await draw('ana')).toMatchObject({
      label: 'Unknown person',
      person: 'ana',
      state: 'gone',
      dashed: true,
    })
    expect(await draw(null)).toMatchObject({
      label: 'Unassigned',
      person: null,
      dashed: true,
    })
  })

  it("draws a person known by a picker's name with their initials on a neutral fill", async () => {
    people.set('ana', ok({ nameOnly: true, color: '' }))
    const drawn = await draw('ana')
    expect(drawn).toMatchObject({ label: 'Ana Berg', text: 'AB', dashed: false })
    expect(
      container.querySelector('[data-live] [role="img"]')?.className.includes('bg-surface-3'),
    ).toBe(true)
  })
})
