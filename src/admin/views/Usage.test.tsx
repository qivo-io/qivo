// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OrgUsageMonths, UsageMonth, UsagePeople } from '../api'
import { USAGE_COLUMNS } from '../usage'

/* The Usage page shows the month the operator picked: an answer for a month
   they have since moved away from is dropped, in the table and in an
   organization's people breakdown. The clock is fixed, so the picker's
   months do not depend on the day the tests run. */

const counts = Object.fromEntries(
  USAGE_COLUMNS.map((c) => [c.key, 0]),
) as UsageMonth['rows'][number]['counts']

const api = vi.hoisted(() => ({
  usageMonth: vi.fn<(month: string) => Promise<UsageMonth>>(),
  orgUsageMonths: vi.fn<(orgId: string) => Promise<OrgUsageMonths>>(),
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

/** One closed month's table, with one organization. */
const month = (key: string, name = 'Pine Studio'): UsageMonth => ({
  month: key,
  current: false,
  unattributed: {
    mail_verification: 0,
    mail_password_reset: 0,
    mail_account_notes: 0,
    background_bytes: null,
  },
  rows: [{ org_id: 'o1', name, counts, api_estimated: false, computed_at: null }],
  failed: [],
  status: { partial: false, run: { saved: 1, failed: 0, finished_at: `${key}-28T05:15:00Z` } },
})

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-04-10T12:00:00Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetAllMocks()
})

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))

const render = async () => {
  const { Usage } = await import('./Usage')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Usage />
      </TooltipProvider>,
    ),
  )
}

/** Picks `value` in the select labelled `label`. */
const pick = (label: string, value: string) => {
  const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (select === null) throw new Error(`no ${label} picker`)
  return act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('the month table', () => {
  it('shows the month picked last, whatever order the answers come in', async () => {
    const answers = new Map<string, (table: UsageMonth) => void>()
    api.usageMonth.mockImplementation(
      (key) =>
        new Promise((resolve) => {
          answers.set(key, resolve)
        }),
    )
    await render()
    await pick('Month', '2026-02')
    await act(async () => answers.get('2026-02')?.(month('2026-02', 'February org')))
    // March, asked for first, answers last
    await act(async () => answers.get('2026-03')?.(month('2026-03', 'March org')))
    expect(host.textContent).toContain('February org')
    expect(host.textContent).not.toContain('March org')
  })

  it('offers a month that began while the page was open once it is refreshed', async () => {
    vi.setSystemTime(Date.parse('2026-04-30T23:59:00Z'))
    api.usageMonth.mockImplementation(async (key) => month(key))
    await render()
    const options = () =>
      [...host.querySelectorAll<HTMLOptionElement>('select[aria-label="Month"] option')]
        .slice(0, 2)
        .map((o) => o.textContent)
    expect(options()).toEqual(['April 2026 (so far)', 'March 2026'])
    vi.setSystemTime(Date.parse('2026-05-01T00:01:00Z'))
    await act(async () => button('Refresh')?.click())
    expect(options()).toEqual(['May 2026 (so far)', 'April 2026'])
  })

  it('downloads a month with no organization rows, and names the ones that failed', async () => {
    api.usageMonth.mockResolvedValue({
      ...month('2026-03'),
      rows: [],
      failed: [{ org_id: 'o2', name: 'Fir Works' }],
      status: { partial: true, run: null },
    })
    await render()
    expect(button('Download CSV')?.disabled).toBe(false)
    expect(host.textContent).toContain('Not computed: Fir Works.')
    expect(host.textContent).toContain('Counting began during this month')
  })
})

describe('the people breakdown', () => {
  it('drops the answer for a month the operator moved away from', async () => {
    api.usageMonth.mockResolvedValue(month('2026-03'))
    api.orgUsageMonths.mockResolvedValue({
      months: [
        {
          org_id: 'o1',
          month: '2026-03',
          counts,
          api_estimated: false,
          computed_at: null,
          partial: false,
        },
      ],
      current_failed: false,
    })
    const answers = new Map<string, (people: UsagePeople) => void>()
    api.orgUsagePeople.mockImplementation(
      (_org, month) =>
        new Promise((resolve) => {
          answers.set(month, resolve)
        }),
    )
    await render()
    await act(async () => button('Pine Studio')?.click())
    const people = 'Month for the people breakdown'
    await pick(people, '2026-03')
    await act(async () => button('Show people')?.click())
    await pick(people, '2026-02')
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

  it('offers the month an organization opens on, though the picker lacks it', async () => {
    api.usageMonth.mockResolvedValue(month('2026-03'))
    // The page was opened in April; the organization's figures already hold May.
    api.orgUsageMonths.mockResolvedValue({
      months: [
        {
          org_id: 'o1',
          month: '2026-05',
          counts,
          api_estimated: false,
          computed_at: null,
          partial: true,
        },
      ],
      current_failed: true,
    })
    api.orgUsagePeople.mockResolvedValue({ people: [], api_estimated: false })
    await render()
    await act(async () => button('Pine Studio')?.click())
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Month for the people breakdown"]',
    )
    expect(select?.value).toBe('2026-05')
    expect(host.textContent).toContain('(so far, partial)')
    expect(host.textContent).toContain('This month could not be computed now.')
    await act(async () => button('Show people')?.click())
    expect(api.orgUsagePeople).toHaveBeenCalledWith('o1', '2026-05')
  })
})
