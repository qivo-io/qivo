// @vitest-environment jsdom
import { act, type ReactNode, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TooltipProvider } from '@/components/ui/tooltip'
import { endClosing, playClosingAnimations } from './closingAnimation.setup'

/* The shared window contents (components/ui) and their closing animation.
   An open window takes clicks and keys; a closing one takes no click and
   no key but Escape, and still gives focus back to its trigger. A window
   that only the React tree nests in it, opened through a portal, keeps
   its own presses. */

const pressed = vi.fn()
const keyed = vi.fn()
const nested = vi.fn()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Radix measures the popover's anchor
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  playClosingAnimations()
  pressed.mockReset()
  keyed.mockReset()
  nested.mockReset()
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

const KINDS = ['dialog', 'alert dialog', 'popover'] as const

/** A window of `kind` with a button, a field and a portal's button, opened
    and closed by its trigger. */
function Window({ kind }: { kind: (typeof KINDS)[number] }) {
  const [open, setOpen] = useState(false)
  const trigger = (
    <Button type="button" data-toggle>
      Toggle
    </Button>
  )
  const parts: ReactNode = (
    <>
      <Button type="button" data-act onClick={pressed}>
        Act
      </Button>
      <Input aria-label="Note" data-note onKeyDown={(event) => keyed(event.key)} />
      {createPortal(
        <Button type="button" data-nested onClick={nested}>
          Nested
        </Button>,
        document.body,
      )}
    </>
  )
  if (kind === 'dialog')
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent data-window>
          <DialogTitle>Window</DialogTitle>
          <DialogDescription>A window under test.</DialogDescription>
          {parts}
        </DialogContent>
      </Dialog>
    )
  if (kind === 'alert dialog')
    return (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
        <AlertDialogContent data-window>
          <AlertDialogTitle>Window</AlertDialogTitle>
          <AlertDialogDescription>A window under test.</AlertDialogDescription>
          {parts}
        </AlertDialogContent>
      </AlertDialog>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent data-window>{parts}</PopoverContent>
    </Popover>
  )
}

const find = (selector: string) => {
  const found = document.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`missing ${selector}`)
  return found
}
const press = (selector: string) => act(async () => find(selector).click())
const key = (selector: string, name: string) =>
  act(async () => {
    find(selector).dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    )
  })

describe.each(KINDS)('a shared %s', (kind) => {
  beforeEach(async () => {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Window kind={kind} />
        </TooltipProvider>,
      ),
    )
    find('[data-toggle]').focus()
    await press('[data-toggle]')
    expect(find('[data-window]').getAttribute('data-state')).toBe('open')
  })

  it('takes clicks and keys while it is open', async () => {
    await press('[data-act]')
    await key('[data-note]', 'Enter')
    expect(pressed).toHaveBeenCalledTimes(1)
    expect(keyed).toHaveBeenCalledWith('Enter')
  })

  it('takes no click and no key but Escape while it closes', async () => {
    await press('[data-toggle]')
    expect(find('[data-window]').getAttribute('data-state')).toBe('closed')
    await press('[data-act]')
    await key('[data-note]', 'Enter')
    await key('[data-note]', 'a')
    expect(pressed).not.toHaveBeenCalled()
    expect(keyed).not.toHaveBeenCalled()
    await key('[data-note]', 'Escape')
    expect(keyed).toHaveBeenCalledWith('Escape')
    // the portal's window is not this window's part
    await press('[data-nested]')
    expect(nested).toHaveBeenCalledTimes(1)
    await endClosing()
    expect(document.querySelector('[data-window]')).toBeNull()
    // focus goes back to the trigger once the window has gone
    expect(document.activeElement).toBe(find('[data-toggle]'))
  })
})
