// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObserverFactory } from '../lib/inlineImages'
import { TooltipProvider } from './ui/tooltip'

/* A copy of a rendered description pasted into the task's description
   editor (descEditor.tsx), with the store's inline image loader over
   stand-ins: a fake observer that brings images near only when the test
   moves them, a mint that answers a lease and a fetch of a small image.
   The clipboard HTML is what the read view (Markdown) renders. */

const OWN = '9d0b7c3e-1111-4222-8333-444455556601'
const OTHER = '9d0b7c3e-1111-4222-8333-444455556602'
const SECOND = '9d0b7c3e-1111-4222-8333-444455556603'

const reach = vi.hoisted(() => ({
  observers: [] as { receive: Parameters<ObserverFactory>[0]; elements: Set<Element> }[],
  serial: 0,
}))
vi.mock('../store/planner', async () => {
  const { createInlineImages } = await import('../lib/inlineImages')
  const blob = new Blob([new Uint8Array(64)], { type: 'image/webp' })
  const inlineImages = createInlineImages({
    held: () => true,
    mint: async (id) => ({
      state: 'lease',
      lease: { url: `https://files.test/files/${id}?e=1&t=x`, exp: Date.now() / 1000 + 600 },
    }),
    fetch: async () => ({ ok: true, status: 200, blob: async () => blob }) as unknown as Response,
    createUrl: () => `blob:https://app.test/image-${++reach.serial}`,
    revokeUrl: () => {},
    measure: async () => ({ width: 640, height: 480 }),
    observer: (receive) => {
      const obs = { receive, elements: new Set<Element>() }
      reach.observers.push(obs)
      return {
        observe: (e: Element) => obs.elements.add(e),
        unobserve: (e: Element) => obs.elements.delete(e),
        disconnect: () => obs.elements.clear(),
      }
    },
    rootOf: () => null,
  })
  const task = { uuid: 'task-1', description: '', org_id: 'org-1' }
  const known: Record<string, unknown> = {
    inlineImages,
    attachmentUrl: async () => null,
    homeOrg: 'org-1',
    taskShown: () => task,
    shownHandleOf: () => 'task-1',
    watchHandles: () => () => {},
    user: () => undefined,
  }
  // every other store call the editor makes is a no-op here
  const P = new Proxy(known, {
    get: (target, key: string) => (key in target ? target[key] : () => undefined),
  })
  return { P, textRefusal: () => null }
})
vi.mock('../lib/convex', () => ({ live: {}, convex: {} }))

const { default: DescEditor } = await import('./descEditor')
const { Markdown } = await import('./markdown')
const { P } = await import('../store/planner')

let container: HTMLDivElement
let root: Root
let toasts: string[]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  toasts = []
  window.showToast = (message: string) => {
    toasts.push(message)
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  reach.observers.length = 0
  P.inlineImages.clear()
  vi.unstubAllGlobals()
})

/* The read view of `text` and the description editor of a task whose
   saved description is `saved`, side by side. */
async function render(text: string, saved: string) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <div data-read>
          <Markdown text={text} />
        </div>
        <DescEditor
          issueKey="task-1"
          task="task-uuid-1"
          value={saved}
          ariaLabel="Task description"
        />
      </TooltipProvider>,
    ),
  )
  return await vi.waitFor(() => {
    const found = document.querySelector<TiptapEditorHTMLElement>(
      '[role="textbox"][aria-label="Task description"]',
    )?.editor
    if (!found) throw new Error('the editor has not mounted')
    return found
  })
}

/* Brings every image of the read view near, as scrolling to it would. */
async function bringNear() {
  const read = document.querySelector('[data-read]') as Element
  await act(async () => {
    for (const obs of reach.observers)
      for (const target of obs.elements)
        if (read.contains(target)) obs.receive([{ target, isIntersecting: true }])
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/* Pastes `html` into the editor at its end, as a copy from a page does. */
async function paste(editor: NonNullable<TiptapEditorHTMLElement['editor']>, html: string) {
  await act(async () => {
    editor.commands.focus('end')
    editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/* The image sources the editor's document holds. */
const sources = (editor: NonNullable<TiptapEditorHTMLElement['editor']>) => {
  const found: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') found.push(String(node.attrs.src))
  })
  return found
}

const readHtml = () => (document.querySelector('[data-read]') as Element).innerHTML

describe('pasting a copy of a rendered description into its editor', () => {
  it('names its task on the editor, which the @ mention popup reads its people for', async () => {
    const editor = await render('', '')
    expect(editor.view.dom.getAttribute('data-qivo-task')).toBe('task-uuid-1')
  })

  it('pastes an image still out of reach, which shows only its placeholder, back as its attachment', async () => {
    const text = `Rig ![Bench photo](att:${OWN}) done`
    const editor = await render(text, text)
    expect(readHtml()).toContain('Loading image…')
    expect(readHtml()).not.toContain('<img')
    await paste(editor, readHtml())
    expect(sources(editor)).toEqual([`att:${OWN}`, `att:${OWN}`])
    let alt = ''
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') alt = String(node.attrs.alt)
    })
    expect(alt).toBe('Bench photo')
    expect(toasts).toEqual([])
  })

  it('pastes a shown image, whose <img> holds a blob: URL, back as its attachment', async () => {
    const text = `![Bench photo](att:${OWN})`
    const editor = await render(text, text)
    await bringNear()
    expect(readHtml()).toMatch(/<img[^>]+src="blob:https:\/\/app\.test\/image-/)
    await paste(editor, readHtml())
    expect(sources(editor)).toEqual([`att:${OWN}`, `att:${OWN}`])
  })

  it('pastes a bare <img> of a blob: URL the loader shows, or of a gateway URL, as its attachment', async () => {
    const text = `![Bench photo](att:${OWN}) ![Second](att:${SECOND})`
    const editor = await render(text, text)
    await bringNear()
    const shown = document.querySelector('[data-read] img')?.getAttribute('src') ?? ''
    expect(P.inlineImages.attachmentOf(shown)).toBe(OWN)
    await paste(
      editor,
      `<p><img src="${shown}" alt="a"><img src="https://site.test/files/${SECOND}?e=1&amp;t=x" alt="b"></p>`,
    )
    expect(sources(editor)).toEqual([`att:${OWN}`, `att:${SECOND}`, `att:${OWN}`, `att:${SECOND}`])
    expect(toasts).toEqual([])
  })

  it('strips another task’s image with the toast, whatever its view showed', async () => {
    const editor = await render(`![Elsewhere](att:${OTHER})`, `![Mine](att:${OWN})`)
    await paste(editor, readHtml())
    expect(sources(editor)).toEqual([`att:${OWN}`])
    expect(toasts).toEqual(['Upload the image to this task before adding it here.'])
  })

  it('strips a blob: URL no attachment of this tab shows, with the toast, and never saves it', async () => {
    const editor = await render('', `![Mine](att:${OWN})`)
    await paste(editor, '<p><img src="blob:https://app.test/from-another-tab" alt="x"></p>')
    expect(sources(editor)).toEqual([`att:${OWN}`])
    expect(toasts).toEqual(['Upload the image to this task before adding it here.'])
  })

  it('keeps an external image the copy shows as its own URL', async () => {
    const editor = await render('![chart](https://example.com/chart.png)', '')
    await paste(editor, readHtml())
    expect(sources(editor)).toEqual(['https://example.com/chart.png'])
  })
})
