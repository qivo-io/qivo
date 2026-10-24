// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OrgUsageMonth, UsageMonth, UsagePeople } from '../api'
import { USAGE_COLUMNS } from '../usage'

/* An organization's people breakdown shows the month it was asked for. An
   answer for a month the operator has since moved away from is dropped. */

const counts = Object.fromEntries(
  USAGE_COLUMNS.map((c) => [c.key, 0]),
) as UsageMonth['rows'][number]['counts']

const api = vi.hoisted(() => ({
  usageMonth: vi.fn<(month: string) => Promise<UsageMonth>>(),
  orgUsageMonths: vi.fn<(orgId: string) => Promise<OrgUsageMonth[]>>(),
  orgUsagePeople: vi.fn<(orgId: string, month: string) => Promise<UsagePeople>>(),
  fmtBytes: (n: number) => `${n} B`,
  fmtWhen: (iso: string | null) => iso ?? '',
}))
vi.mock('../api', () => api)

const person = (name: string): UsagePeople['people'][number] => ({
  profile_id: name,
  name,
  changes: 1,
  comments: 0,
  api_calls: 0,
  credentials: [],
  signed_in: true,
})

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
})

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))

describe('the people breakdown', () => {
  it('drops the answer for a month the operator moved away from', async () => {
    api.usageMonth.mockResolvedValue({
      month: '2026-03',
      current: false,
      unattributed: {
        mail_verification: 0,
        mail_password_reset: 0,
        mail_account_notes: 0,
        background_bytes: null,
      },
      rows: [
        { org_id: 'o1', name: 'Pine Studio', counts, api_estimated: false, computed_at: null },
      ],
    })
    api.orgUsageMonths.mockResolvedValue([
      { org_id: 'o1', month: '2026-03', counts, api_estimated: false, computed_at: null },
    ])
    const answers = new Map<string, (people: UsagePeople) => void>()
    api.orgUsagePeople.mockImplementation(
      (_org, month) =>
        new Promise((resolve) => {
          answers.set(month, resolve)
        }),
    )
    const { Usage } = await import('./Usage')
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Usage />
        </TooltipProvider>,
      ),
    )
    await act(async () => button('Pine Studio')?.click())
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Month for the people breakdown"]',
    )
    if (select === null) throw new Error('no month picker')
    const pick = (month: string) =>
      act(async () => {
        select.value = month
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    await pick('2026-03')
    await act(async () => button('Show people')?.click())
    await pick('2026-02')
    // March answers after February was picked
    await act(async () =>
      answers.get('2026-03')?.({ people: [person('March person')], api_estimated: false }),
    )
    expect(host.textContent).not.toContain('March person')
    expect(button('Show people')?.disabled).toBe(false)
    await act(async () => button('Show people')?.click())
    await act(async () =>
      answers.get('2026-02')?.({ people: [person('February person')], api_estimated: false }),
    )
    expect(host.textContent).toContain('February person')
  })
})
