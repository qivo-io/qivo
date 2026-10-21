// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AuditRow } from '../api'

/* The operator audit log loads its newest entries, says when older ones
   exist and loads them on request. A refresh drops an older page asked for
   before it, so no entries go missing between the pages. */

type Page = { rows: AuditRow[]; next: string | null }
const api = vi.hoisted(() => ({
  auditLog: vi.fn<(cursor?: string | null) => Promise<Page>>(),
  listOrgNames: vi.fn(async () => []),
}))
vi.mock('../api', () => api)

const entry = (n: number): AuditRow => ({
  id: `row-${n}`,
  ts: new Date(Date.UTC(2026, 9, 21, 12, 0, 0) - n * 60_000).toISOString(),
  actor_email: 'operator@example.test',
  action: 'create_org',
  target_org_id: null,
  target_profile_id: null,
  detail: { n },
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

const shown = () => [...host.querySelectorAll('tbody tr')].length
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))

describe('the audit log', () => {
  it('says it shows the newest entries, and a refresh drops an older page asked for before it', async () => {
    let older: (page: Page) => void = () => {}
    api.auditLog.mockImplementation(async (cursor) =>
      cursor
        ? new Promise<Page>((resolve) => {
            older = resolve
          })
        : { rows: [entry(1), entry(2)], next: 'cursor-2' },
    )
    const { Audit } = await import('./Audit')
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Audit />
        </TooltipProvider>,
      ),
    )
    expect(shown()).toBe(2)
    expect(host.textContent).toContain('Showing the newest 2')
    await act(async () => button('Load older entries')?.click())
    await act(async () => button('Refresh')?.click())
    // the older page answers after the refresh did
    await act(async () => older({ rows: [entry(3), entry(4)], next: null }))
    expect(shown()).toBe(2)
    expect(button('Load older entries')).toBeDefined()
  })
})
