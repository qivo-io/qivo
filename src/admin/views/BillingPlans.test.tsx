// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BillingPlan } from '../../../convex/lib/billingTypes'
import { endClosing, playClosingAnimations } from '../../lib/closingAnimation.setup'
import { BillingPlans } from './BillingPlans'

/* Admin › Billing plans' Make default question. The catalogue reload that
   follows the change swaps the plan's button for its default line while the
   question closes. The change is answered by hand. */

const server = vi.hoisted(() => ({
  defaultId: 'team-2025',
  changes: [] as { resolve: () => void; reject: (cause: Error) => void }[],
  // the catalogue's reads fail from now on
  down: false,
}))
const plan = (id: string, name: string): BillingPlan => ({
  id,
  name,
  currency: 'usd',
  seat_price_cents: 1000,
  minimum_seats: 5,
  storage_gb_per_seat: 1,
  minimum_storage_gb: 5,
  api_calls_per_seat: 25000,
  storage_block_price_cents: 100,
  api_block_price_cents: 100,
  api_block_size: 25000,
  polar_product_id: `polar-${id}`,
  api_meter_id: `api-${id}`,
  storage_meter_id: `storage-${id}`,
  created_at: '2026-01-01T00:00:00.000Z',
  archived: false,
})
vi.mock('@/lib/convex', () => ({
  convex: {
    query: async () => {
      if (server.down) throw new Error('The catalogue could not be read')
      return {
        plans: [plan('team-2025', 'Team 2025'), plan('team-2026', 'Team 2026')],
        default_plan_id: server.defaultId,
      }
    },
  },
}))
vi.mock('../convex', () => ({
  runAction: vi.fn(),
  sendMutation: (_ref: unknown, args: { plan_id: string }) =>
    new Promise<void>((resolve, reject) =>
      server.changes.push({
        resolve: () => {
          server.defaultId = args.plan_id
          resolve()
        },
        reject,
      }),
    ),
}))

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  playClosingAnimations()
  server.defaultId = 'team-2025'
  server.changes.length = 0
  server.down = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <BillingPlans />
      </TooltipProvider>,
    ),
  )
  const use = [
    ...document.querySelectorAll<HTMLElement>('[data-billing-plan="team-2026"] button'),
  ].find((button) => button.textContent === 'Use for new customers')
  await act(async () => use?.click())
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const dialog = () => document.querySelector('[role="alertdialog"]')
const confirm = () => document.querySelector<HTMLButtonElement>('[data-make-default]')
const line = () => document.querySelector('[data-billing-plan="team-2026"] p.font-semibold')

describe('the Make default question', () => {
  it('waits for the change, fades as the default line replaces its button, and gives that line focus', async () => {
    await act(async () => confirm()?.click())
    expect(dialog()?.getAttribute('data-state')).toBe('open')
    expect(confirm()?.textContent).toBe('Saving…')
    await act(async () => server.changes[0].resolve())
    expect(line()?.textContent).toBe('Default for new customers')
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(confirm()?.textContent).toBe('Saving…')
    await act(async () => confirm()?.click())
    expect(server.changes).toHaveLength(1)
    await endClosing()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(line())
  })

  it('shows a refusal in the question and keeps it open', async () => {
    await act(async () => confirm()?.click())
    await act(async () => server.changes[0].reject(new Error('Polar is unavailable')))
    expect(dialog()?.getAttribute('data-state')).toBe('open')
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBeTruthy()
    expect(confirm()?.textContent).toBe('Make default')
    expect(line()).toBeNull()
  })

  it('closes once the change lands, and the page says when only the reload after it failed', async () => {
    await act(async () => confirm()?.click())
    server.down = true
    await act(async () => server.changes[0].resolve())
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector('[data-billing-plans] > [role="alert"]')?.textContent).toBe(
      'The catalogue could not be read',
    )
    expect(document.querySelector('[data-billing-plans] > [role="status"]')?.textContent).toMatch(
      /^Team 2026 is the default/,
    )
  })
})
