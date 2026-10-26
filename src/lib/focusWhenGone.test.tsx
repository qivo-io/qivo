// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusAround, useFocusWhenGone } from './focusWhenGone'

/* A control that gives way to a line once its change lands, with a
   dialog of its own that can be on screen meanwhile. */

function Panel({ shown, dialog }: { shown: boolean; dialog: boolean }) {
  const line = useRef<HTMLParagraphElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useFocusWhenGone(shown, () => line.current, content)
  return (
    <>
      {shown ? (
        <button type="button">Act</button>
      ) : (
        <p ref={line} tabIndex={-1}>
          Done
        </p>
      )}
      <input aria-label="Elsewhere" />
      {dialog && <div ref={content} />}
    </>
  )
}

let container: HTMLDivElement
let root: Root
const show = (shown: boolean, dialog = false) =>
  act(async () => root.render(<Panel shown={shown} dialog={dialog} />))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('focus when a control leaves', () => {
  it('goes to the line that replaced the control that held it', async () => {
    await show(true)
    container.querySelector('button')?.focus()
    await show(false)
    expect(document.activeElement?.textContent).toBe('Done')
  })

  it('stays where it moved on to', async () => {
    await show(true)
    container.querySelector('input')?.focus()
    await show(false)
    expect(document.activeElement).toBe(container.querySelector('input'))
  })

  it("waits for the control's own dialog while it is on screen", async () => {
    await show(true, true)
    await show(false, true)
    expect(document.activeElement).toBe(document.body)
  })

  it('moves nothing for a control that never showed', async () => {
    await show(false)
    expect(document.activeElement).toBe(document.body)
  })
})

describe('the target around a row that may leave', () => {
  /* Rows a, b and c, each with a button, then a line; `hidden` puts the
     rows in a kept view hidden behind another page. */
  function list(hidden = false) {
    container.innerHTML = `<div ${hidden ? 'data-hidden-view' : ''}>${['a', 'b', 'c']
      .map((id) => `<div data-row="${id}"><button>${id}</button></div>`)
      .join('')}</div><p tabindex="-1">None</p>`
  }
  const row = (id: string) => container.querySelector(`[data-row="${id}"]`)
  const target = (id: string) =>
    focusAround(
      'data-row',
      id,
      (shown) => shown.querySelector('button'),
      () => container.querySelector('p'),
    )

  it("answers the row's own button while it is listed, and the next row's once it left", () => {
    list()
    const focus = target('b')
    expect(focus()?.textContent).toBe('b')
    row('b')?.remove()
    expect(focus()?.textContent).toBe('c')
  })

  it('answers the row before once no row after it is left, and the rest after the last', () => {
    list()
    const focus = target('b')
    row('b')?.remove()
    row('c')?.remove()
    expect(focus()?.textContent).toBe('a')
    row('a')?.remove()
    expect(focus()?.textContent).toBe('None')
  })

  it('passes by rows in a hidden view', () => {
    list(true)
    expect(target('b')()?.textContent).toBe('None')
  })
})
