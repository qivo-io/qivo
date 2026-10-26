// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { endClosing, playClosingAnimations } from '../../lib/closingAnimation.setup'
import { Backgrounds } from './Backgrounds'

/* Admin › Background images' dialogs as they give focus back. They open
   without a Trigger, from a card's preview, a week's or the default's
   button and a submission's thumbnail. The live queries answer from the
   images below, and an approval sends them again. */

type Image = {
  id: string
  title: string
  creator: string
  attribution: string
  license: string
  license_url: string
  source_url: string
  width: number
  height: number
  byte_size: number
  status: 'pending' | 'approved' | 'removed'
  image_url: string | null
  preview_url: string | null
  imported_at: string
}
const image = (id: string, title: string, status: Image['status'] = 'pending'): Image => ({
  id,
  title,
  creator: 'Nora Berg',
  attribution: 'Photo by Nora Berg',
  license: 'Unsplash License',
  license_url: '',
  source_url: '',
  width: 3000,
  height: 1875,
  byte_size: 1_200_000,
  status,
  image_url: `https://images.example/${id}.jpg`,
  preview_url: null,
  imported_at: '2026-10-01T00:00:00.000Z',
})

type Watch = { name: string; args: Record<string, unknown>; receive: (value: unknown) => void }
const server = vi.hoisted(() => ({
  images: [] as Image[],
  defaultId: null as string | null,
  watches: new Set<Watch>(),
  // while set, each write waits here for the test to refuse it
  refusals: null as ((error: Error) => void)[] | null,
}))
/** What a live query answers now. */
function answer(name: string, args: Record<string, unknown>): unknown {
  const approved = server.images.filter((i) => i.status === 'approved')
  if (name === 'panoramaImages:summary')
    return { pending: 0, approved: approved.length, removed: 0, total: server.images.length }
  if (name === 'panoramaImages:calendar')
    return {
      default_image: approved.find((i) => i.id === server.defaultId) ?? null,
      default_image_id: server.defaultId,
      approved_images: approved,
      slots: [],
    }
  if (name === 'panoramaImages:library')
    return {
      images: server.images.filter((i) => !args.status || i.status === args.status),
      isDone: true,
      continueCursor: '',
    }
  if (name === 'panoramaCuration:libraryImage')
    return server.images.find((i) => i.id === args.id) ?? null
  if (name === 'panoramaCuration:submissions')
    return {
      submissions: [
        {
          id: 'proposal-1',
          source_url: 'https://unsplash.com/photos/fjord',
          day: 'W12',
          title: 'Fjord at dawn',
          status: 'accepted',
          submitted_at: '2026-10-01T00:00:00.000Z',
          submitted_by: 'Curator agent',
          image_id: 'fjord',
          image_url: 'https://images.example/fjord.jpg',
          preview_url: null,
          existing_image_id: null,
          existing_image_title: null,
        },
      ],
      isDone: true,
      continueCursor: '',
    }
  return null
}
/** Sends every live query its answer again, as Convex does after a write. */
const publish = () => {
  for (const watch of server.watches) watch.receive(answer(watch.name, watch.args))
}
vi.mock('../../lib/convex', () => ({
  convex: {
    onUpdate: (
      ref: Parameters<typeof getFunctionName>[0],
      args: Record<string, unknown>,
      receive: (value: unknown) => void,
    ) => {
      const watch = { name: getFunctionName(ref), args, receive }
      server.watches.add(watch)
      queueMicrotask(() => {
        if (server.watches.has(watch)) receive(answer(watch.name, args))
      })
      return () => server.watches.delete(watch)
    },
  },
}))
vi.mock('../convex', () => ({
  runAction: vi.fn(),
  sendMutation: async (ref: Parameters<typeof getFunctionName>[0], args: { id: string }) => {
    const refusals = server.refusals
    if (refusals) await new Promise((_, refuse) => refusals.push(refuse))
    const name = getFunctionName(ref)
    const status =
      name === 'panoramaImages:approve'
        ? 'approved'
        : name === 'panoramaImages:remove'
          ? 'removed'
          : null
    // a new image, as Convex answers with new objects and leaves the old alone
    if (status) server.images = server.images.map((i) => (i.id === args.id ? { ...i, status } : i))
    publish()
    return null
  },
}))

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  playClosingAnimations()
  // the image picker (cmdk) measures its list and scrolls to the chosen image
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Element.prototype.scrollIntoView = vi.fn()
  server.images = [image('lake', 'Lake'), image('ridge', 'Ridge'), image('dunes', 'Dunes')]
  server.defaultId = null
  server.watches.clear()
  server.refusals = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Backgrounds />
      </TooltipProvider>,
    ),
  )
}
function button(name: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  )
  if (!found) throw new Error(`missing ${name}`)
  return found
}
/** Presses `target` from the keyboard, which gives it focus first. */
async function press(target: HTMLElement) {
  target.focus()
  await act(async () => target.click())
}
/** Leaves focus nowhere, as a browser can when it disables the focused
    button. jsdom keeps focus on a disabled button and ignores its blur. */
function dropFocus() {
  const elsewhere = document.body.appendChild(document.createElement('button'))
  elsewhere.focus()
  elsewhere.remove()
}
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')]
const footer = () => dialogs().at(-1)?.querySelector('[data-slot="dialog-footer"]') ?? document
const preview = (id: string) =>
  document.querySelector<HTMLElement>(`[data-background-image="${id}"] button`)
const control = (id: string, name: 'approve' | 'remove') =>
  document.querySelector<HTMLButtonElement>(`[data-image-${name}="${id}"]`)
const card = (id: string) => document.querySelector(`[data-background-image="${id}"]`) ?? document
/** Shows All images, where a reviewed image keeps its card. */
async function showAll() {
  const status = document.querySelector<HTMLSelectElement>('#background-status')!
  status.value = 'all'
  await act(async () => status.dispatchEvent(new Event('change', { bubbles: true })))
}

describe('the library preview', () => {
  it('gives focus to the card now in its place after Approve and next took the card away', async () => {
    await render()
    await press(button('Preview Ridge'))
    await act(async () => button('Approve and next', footer()).click())
    expect(document.querySelector('[data-image-review-notice]')?.textContent).toBe(
      'Image approved. Reviewing Lake.',
    )
    expect(preview('ridge')).toBeNull()
    await act(async () => button('Close', footer()).click())
    await endClosing()
    expect(document.activeElement).toBe(preview('dunes'))
  })

  it('gives focus to the card before it when the approved card was the last', async () => {
    server.images = [image('lake', 'Lake'), image('dunes', 'Dunes')]
    await render()
    await press(button('Preview Dunes'))
    await act(async () => button('Approve and next', footer()).click())
    await act(async () => button('Close', footer()).click())
    await endClosing()
    expect(document.activeElement).toBe(preview('lake'))
  })

  it('gives focus to the empty queue’s heading once the last image waiting is approved', async () => {
    server.images = [image('dunes', 'Dunes')]
    await render()
    await press(button('Preview Dunes'))
    await act(async () => button('Approve and next', footer()).click())
    await act(async () => button('Close', footer()).click())
    await endClosing()
    expect(document.activeElement?.textContent).toBe('No images waiting for review')
  })
})

describe('the dialogs opened from a button that stays', () => {
  it('gives focus back to Change default once the default’s dialog closes', async () => {
    server.images = [image('lake', 'Lake', 'approved'), image('dunes', 'Dunes', 'approved')]
    server.defaultId = 'lake'
    await render()
    const change = button('Change default')
    await press(change)
    await act(async () => button('Cancel', footer()).click())
    await endClosing()
    expect(document.activeElement).toBe(change)
  })

  it('gives focus back to Preview in board inside the default’s dialog that stays open', async () => {
    server.images = [image('lake', 'Lake', 'approved')]
    server.defaultId = 'lake'
    await render()
    await press(button('Change default'))
    const inBoard = button('Preview in board')
    await press(inBoard)
    expect(dialogs()).toHaveLength(2)
    await act(async () => button('Close', footer()).click())
    await endClosing()
    expect(dialogs()).toHaveLength(1)
    expect(document.activeElement).toBe(inBoard)
  })

  it('gives focus back to a submission’s thumbnail once its preview closes', async () => {
    await render()
    const tab = button('Agent submissions')
    await act(async () =>
      tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })),
    )
    const thumbnail = button('Preview Fjord at dawn')
    await press(thumbnail)
    await act(async () => button('Close', footer()).click())
    await endClosing()
    expect(document.activeElement).toBe(thumbnail)
  })
})

describe('a card’s own Approve and Remove image', () => {
  it('gives focus to the next card’s Approve once an approval took the card off the list', async () => {
    await render()
    await press(control('ridge', 'approve')!)
    expect(preview('ridge')).toBeNull()
    expect(document.activeElement).toBe(control('dunes', 'approve'))
  })

  it('gives focus to the Remove of the card before once a removal took the last card away', async () => {
    await render()
    await press(control('dunes', 'remove')!)
    await press(document.querySelector<HTMLElement>('[data-image-remove-confirm="dunes"]')!)
    expect(preview('dunes')).toBeNull()
    expect(document.activeElement).toBe(control('ridge', 'remove'))
  })

  it('gives focus to the card’s preview when an approval keeps the card in All images', async () => {
    await render()
    await showAll()
    await press(control('ridge', 'approve')!)
    expect(control('ridge', 'approve')).toBeNull()
    expect(document.activeElement).toBe(preview('ridge'))
  })

  it('gives focus to the card’s preview when a removal keeps the card in All images', async () => {
    await render()
    await showAll()
    await press(control('ridge', 'remove')!)
    await press(document.querySelector<HTMLElement>('[data-image-remove-confirm="ridge"]')!)
    expect(control('ridge', 'remove')).toBeNull()
    expect(document.activeElement).toBe(preview('ridge'))
  })

  it('moves no focus when another operator approves an image in All images', async () => {
    await render()
    await showAll()
    dropFocus()
    server.images = server.images.map((i) => (i.id === 'ridge' ? { ...i, status: 'approved' } : i))
    await act(async () => publish())
    expect(control('ridge', 'approve')).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('gives focus back to Approve once its write is refused, and a later removal of the card moves none', async () => {
    server.refusals = []
    await render()
    const approve = control('ridge', 'approve')!
    await press(approve)
    expect(approve.disabled).toBe(true)
    dropFocus()
    expect(document.activeElement).toBe(document.body)
    await act(async () => server.refusals?.[0](new Error('The image changed. Review it again.')))
    expect(document.activeElement).toBe(approve)
    // the operator clicks the page, and another operator approves the image
    approve.blur()
    server.images = server.images.map((i) => (i.id === 'ridge' ? { ...i, status: 'approved' } : i))
    await act(async () => publish())
    expect(preview('ridge')).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })
})

describe('a card’s remove panel', () => {
  it('gives focus to the reason field when Remove opens the panel', async () => {
    await render()
    await press(control('ridge', 'remove')!)
    expect(document.activeElement).toBe(card('ridge').querySelector('textarea'))
  })

  it('gives focus back to Remove when the panel’s Cancel closes it', async () => {
    await render()
    await press(control('ridge', 'remove')!)
    await press(button('Cancel', card('ridge')))
    expect(document.activeElement).toBe(control('ridge', 'remove'))
  })
})
