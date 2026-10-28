// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BillingUsage as BillingUsageData } from '../../convex/lib/billingTypes'
import type { ApiAccessEntry } from '../lib/apiAccess'
import { BillingUsage } from './BillingUsage'

/* Billing's API calls by account: each account's total with a View
   credentials link, no nested credential rows. The report still lists each
   account's credentials (`keys`) for apps of the release before. */

const USAGE: BillingUsageData = {
  period_kind: 'month',
  period_key: 'month:2026-10',
  period_start: '2026-10-01T00:00:00.000Z',
  period_end: '2026-10-31T00:00:00.000Z',
  calls: 42,
  included_calls: null,
  storage_bytes: 0,
  included_storage_bytes: null,
  api_overage_cents: 0,
  storage_overage_cents: 0,
  waived: true,
  delivery_unconfirmed: false,
  users: [
    {
      profile_id: 'nora',
      name: 'Nora Lind',
      calls: 30,
      keys: [
        { id: 'mcp_tokens:a', name: 'Cursor', calls: 20 },
        { id: 'oauth_connections:b', name: 'Claude', calls: 10 },
      ],
    },
    {
      profile_id: 'gone',
      name: 'Removed user',
      calls: 12,
      keys: [{ id: 'agent_keys:c', name: 'Night job', calls: 12 }],
    },
  ],
  projects: [],
}

let container: HTMLDivElement
let root: Root

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

describe('API calls by account', () => {
  it('shows each account’s total with View credentials and no nested credential rows', async () => {
    const view = vi.fn<(entry: ApiAccessEntry) => void>()
    await act(async () =>
      root.render(
        <TooltipProvider>
          <BillingUsage
            usage={USAGE}
            currency={undefined}
            measuredAt={0}
            orgId="org-1"
            onViewCredentials={view}
          />
        </TooltipProvider>,
      ),
    )
    const accounts = [...container.querySelectorAll('[data-billing-account]')]
    expect(accounts.map((account) => account.textContent)).toEqual([
      'Nora Lind30 callsView credentials',
      'Removed user12 callsView credentials',
    ])
    expect(container.textContent).toContain('Each account’s total covers all of its credentials.')
    // the credentials are API access's to show, a page at a time
    expect(container.querySelector('[data-billing-usage] li')).toBeNull()
    for (const name of ['Cursor', 'Claude', 'Night job'])
      expect(container.textContent).not.toContain(name)

    const link = container.querySelector<HTMLButtonElement>(
      '[data-billing-view-credentials="gone"]',
    )
    expect(link?.getAttribute('aria-label')).toBe('View credentials of Removed user')
    await act(async () => link?.click())
    // the organization, account and period of the report on screen
    expect(view).toHaveBeenCalledWith({
      org_id: 'org-1',
      profile_id: 'gone',
      period_key: 'month:2026-10',
    })
  })
})
