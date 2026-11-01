// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* workspace.css gives a view's full-view empty card its frame: the shell
   narrows its content beside it, and the card keeps to the top of the
   view. The Board puts its empty states inside its own root
   (views/board/BoardNote.tsx BoardFrame), so the rules must reach them
   there too. */

const css = readFileSync(join(__dirname, 'workspace.css'), 'utf8')

/** The style rules of workspace.css whose body holds `declaration`. */
function rulesWith(declaration: string) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  const found = [...(style.sheet?.cssRules ?? [])]
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
    .filter((rule) => rule.cssText.includes(declaration))
  style.remove()
  return found
}

/** A desktop shell whose view holds `body` in its kept content. */
function shell(view: string, body: string) {
  document.body.innerHTML = `<div class="planner-shell"><main><div data-workspace-view="${view}"><div data-kept-content>${body}</div></div></main></div>`
  const card = document.querySelector('.qivo-empty-state')
  if (!card) throw new Error('no card')
  return { shell: document.querySelector('.planner-shell') as Element, card }
}

describe('the full-view empty card', () => {
  const [frame] = rulesWith('max-width: 600px')
  const [narrow] = rulesWith('--workspace-content-max: 640px')

  it.each([
    ['a view body', 'overview', '<div class="qivo-empty-state"></div>'],
    ['the Board root', 'kanban', '<div data-board-root><div class="qivo-empty-state"></div></div>'],
  ])('frames the empty card of %s', (_, view, body) => {
    const { shell: root, card } = shell(view, body)
    expect(card.matches(frame.selectorText)).toBe(true)
    expect(root.matches(narrow.selectorText)).toBe(true)
  })

  it('leaves a note inside a populated view alone', () => {
    const { shell: root, card } = shell(
      'kanban',
      '<div data-board-root><div data-scroll><div class="qivo-empty-state"></div></div></div>',
    )
    expect(card.matches(frame.selectorText)).toBe(false)
    expect(root.matches(narrow.selectorText)).toBe(false)
  })
})
