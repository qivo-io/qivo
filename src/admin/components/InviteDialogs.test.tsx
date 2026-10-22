// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OrgMember } from '../api'

/* Edit invite checks only an address that changed, so an invitation stored
   before the address rule can still have its name corrected. */

const api = vi.hoisted(() => ({
  editInvite: vi.fn(async () => ({ sent: null })),
  checkPeople: vi.fn(async () => []),
}))
vi.mock('../api', () => api)
vi.mock('../convex', () => ({ beginChange: () => () => {} }))

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  api.editInvite.mockClear()
})

/** Types `value` into `input` as React sees a change. */
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const field = (label: string) => {
  const id = [...document.querySelectorAll('label')]
    .find((l) => l.textContent === label)
    ?.getAttribute('for')
  return document.getElementById(id ?? '') as HTMLInputElement
}
const save = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save') as
    | HTMLButtonElement
    | undefined

async function open(email: string) {
  const { EditInviteDialog } = await import('./InviteDialogs')
  const member = { profile_id: 'seat-1', name: 'Jørn Lie', email } as OrgMember
  await act(async () =>
    root.render(
      <TooltipProvider>
        <EditInviteDialog
          orgId="org-1"
          member={member}
          onClose={() => {}}
          onSaved={async () => {}}
        />
      </TooltipProvider>,
    ),
  )
}

describe('Edit invite', () => {
  it('saves a new name for an invitation whose stored address the rule now refuses', async () => {
    await open('jørn@example.no')
    await act(async () => type(field('Name'), 'Jørn Lie Berg'))
    expect(save()?.disabled).toBe(false)
    await act(async () => save()?.click())
    expect(api.editInvite).toHaveBeenCalledWith('seat-1', 'Jørn Lie Berg', 'jørn@example.no')
  })

  it('still refuses a changed address the rule refuses', async () => {
    await open('jorn@example.no')
    await act(async () => type(field('Email address'), 'jørn@example.no'))
    expect(save()?.disabled).toBe(true)
  })
})
