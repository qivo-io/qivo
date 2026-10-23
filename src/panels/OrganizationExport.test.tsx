// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'

/* Settings › General's export loads its code through the shared loader
   (lib/workspaceChunks) only when an admin asks for it, says why when that
   code waits for the connection, and works once the connection is back. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: null }) },
  signOut: vi.fn(),
}))
const exporter = vi.hoisted(() => ({
  exportOrganization: vi.fn(async () => ({ blob: new Blob(['zip']), filename: 'acme.zip' })),
}))
vi.mock('../lib/orgExport', () => exporter)

const UP = { connected: true, everConnected: true }
const DOWN = { connected: false, everConnected: true }

let container: HTMLDivElement
let root: Root
let downloads: string[]

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  network.onUpdate.mockImplementation(() => () => {})
  network.mutation.mockReset()
  network.mutation.mockResolvedValue(null)
  exporter.exportOrganization.mockClear()
  URL.createObjectURL = vi.fn(() => 'blob:export')
  URL.revokeObjectURL = vi.fn()
  downloads = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function load() {
  const { syncStatus, OFFLINE_DELAY_MS } = await import('../lib/syncStatus')
  const { loadOrgExport } = await import('../lib/workspaceChunks')
  const { OrganizationExport } = await import('./OrganizationExport')
  syncStatus.setSocket(UP)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <OrganizationExport orgId="org-1" />
      </TooltipProvider>,
    ),
  )
  return { syncStatus, OFFLINE_DELAY_MS, loadOrgExport }
}
async function exportData() {
  const button = container.querySelector<HTMLButtonElement>('[data-export-download]')
  await act(async () => {
    button?.click()
    await vi.advanceTimersByTimeAsync(0)
  })
}
const alert = () => container.querySelector('[role="alert"]')?.textContent ?? null
const status = () => container.querySelector('[role="status"]')?.textContent ?? ''
const recorded = () =>
  network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'orgRemovals:recordExport')

describe('the organization export', () => {
  it('loads its code only when asked, then downloads the ZIP and records it', async () => {
    const { loadOrgExport } = await load()
    expect(loadOrgExport.peek()).toBeUndefined()
    expect(loadOrgExport.loading()).toBe(false)
    await exportData()
    expect(exporter.exportOrganization).toHaveBeenCalledTimes(1)
    expect(downloads).toEqual(['acme.zip'])
    expect(status()).toBe('Export downloaded.')
    expect(alert()).toBeNull()
    expect(recorded()).toHaveLength(1)
    expect(recorded()[0][1]).toEqual({ org_id: 'org-1' })
  })

  it('says why while the connection is down, and exports once it is back', async () => {
    const { syncStatus, loadOrgExport } = await load()
    // down, before the offline notice
    syncStatus.setSocket(DOWN)
    await exportData()
    expect(alert()).toBe('Export failed: This code loads when the connection is back.')
    expect(exporter.exportOrganization).not.toHaveBeenCalled()
    expect(loadOrgExport.failed()).toBe(false)
    expect(container.querySelector('[data-export-download]')?.textContent).toBe('Export data')
    syncStatus.setSocket(UP)
    await exportData()
    expect(alert()).toBeNull()
    expect(downloads).toEqual(['acme.zip'])
  })

  it('refuses while offline without asking for the code', async () => {
    const { syncStatus, OFFLINE_DELAY_MS, loadOrgExport } = await load()
    syncStatus.setSocket(DOWN)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    await exportData()
    expect(alert()).toContain('offline')
    expect(loadOrgExport.loading()).toBe(false)
    expect(loadOrgExport.peek()).toBeUndefined()
    expect(exporter.exportOrganization).not.toHaveBeenCalled()
  })
})
