// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JOB_ORDER, LIVE_READ_WARNING } from '../../convex/lib/orgExport'
import { STOP_MESSAGES } from '../../convex/model/orgExports'
import { TooltipProvider } from '../components/ui/tooltip'
import { orgExportStandIn, STOP_MESSAGES_TEXT } from '../store/orgExportStandIn.setup'

/* Settings › Organization › General's export on the server job: what it
   says before any export, every state of the job with its sentence and
   buttons, the automatic attempt's conditions, the order of picker and
   request, and that every write waits for a page that can save. The
   real useKeptLiveView reads through the live double, whose client the
   shared stand-in answers (store/orgExportStandIn.setup.ts). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
const planner = vi.hoisted(() => ({
  cannotSaveText: vi.fn((): string | null => null),
  hasUnsavedWork: vi.fn(() => false),
  org: { id: 'org-1', slug: 'northstar' },
}))
vi.mock('../store/planner', () => ({ P: planner }))

const NOW = Date.parse('2026-11-09T12:00:00.000Z')
let container: HTMLDivElement
let root: Root
let server: ReturnType<typeof orgExportStandIn>
const order: string[] = []
// while set, a new subscription's answers wait here until released
let holding: (() => void)[] | null = null

/** Starts the stand-in with `states` and answers the client from it. */
function serve(states: string[] = []) {
  server = orgExportStandIn({
    now: () => Date.now(),
    states,
    link: 'https://brave-otter-123.convex.site/exports/x?e=1&m=k&t=t',
  })
  network.onUpdate.mockImplementation(
    (ref, _args, onValue: (value: unknown) => void, onError: (error: unknown) => void) => {
      const name = getFunctionName(ref)
      const answer = () => {
        try {
          const value = server.query(name)
          if (value !== undefined) onValue(value)
        } catch (error) {
          onError(error)
        }
      }
      if (holding) holding.push(answer)
      else answer()
      return server.subscribe(() => {
        if (holding) holding.push(answer)
        else answer()
      })
    },
  )
  network.mutation.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    order.push(name)
    try {
      return server.mutation(name, args as Record<string, unknown>)
    } catch (error) {
      const data = (error as { data?: { code: string; message: string } }).data
      throw data ? new ConvexError(data) : error
    }
  })
}

const sent = (name: string) =>
  network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, a]) => a)

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  order.length = 0
  holding = null
  network.mutation.mockReset()
  network.onUpdate.mockReset()
  planner.cannotSaveText.mockReset().mockReturnValue(null)
  planner.hasUnsavedWork.mockReset().mockReturnValue(false)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const frame of document.querySelectorAll('iframe')) frame.remove()
  Reflect.deleteProperty(document, 'visibilityState')
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
  delete (window as { qivoDesktop?: unknown }).qivoDesktop
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount() {
  const { OrganizationExport } = await import('./OrganizationExport')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <OrganizationExport orgId="org-1" />
      </TooltipProvider>,
    ),
  )
  await settle()
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
const section = () => container.querySelector('[data-org-export]')
const text = () => section()?.textContent ?? ''
const stateShown = () => section()?.getAttribute('data-export-state')
const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)
async function press(selector: string) {
  const found = button(selector)
  if (!found) throw new Error(`no ${selector}`)
  await act(async () => found.click())
  await settle()
}
const setVisibility = async (value: 'visible' | 'hidden') => {
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await settle()
}
const claims = () => sent('orgExport:claimDownload') as { automatic: boolean; export_id: string }[]
const desktop = (answer: object = { state: 'completed', file: 'a.zip', bytes: 2048 }) => {
  const download = vi.fn(async () => answer)
  ;(window as { qivoDesktop?: unknown }).qivoDesktop = { orgExport: { download } }
  return download
}

describe('before any export', () => {
  it('says what the archive holds and leaves out, the live-read warning, no restore and the server', async () => {
    serve()
    await mount()
    expect(stateShown()).toBe('none')
    expect(text()).toContain('every project and its tasks, archived work included')
    expect(text()).toContain('the Deleted items Qivo still keeps, in a folder of their own')
    expect(text()).toContain('It leaves out attachment files, images in descriptions and comments')
    expect(text()).toContain(LIVE_READ_WARNING)
    expect(text()).toContain('Qivo has no import or restore for exports')
    expect(text()).toContain('Qivo prepares the export on its server, so you can leave this page.')
    expect(text()).not.toContain('Keep this page open until')
    expect(button('[data-export-start]')?.textContent).toBe('Export data')
  })

  it('holds no update block while a job collects', async () => {
    serve(['collecting'])
    const { isUpdateBlocked } = await import('../lib/updateSafety')
    await mount()
    expect(stateShown()).toBe('collecting')
    expect(isUpdateBlocked()).toBe(false)
  })

  it('names every section of the job', async () => {
    const { SECTION_LABELS } = await import('../lib/orgExport')
    for (const entry of JOB_ORDER) expect(SECTION_LABELS[entry.key], entry.key).toBeTruthy()
  })

  it("shows the server's own failure sentences", () => {
    expect(STOP_MESSAGES_TEXT.deleted_changing).toBe(STOP_MESSAGES.deleted_changing)
    expect(STOP_MESSAGES_TEXT.too_large).toBe(STOP_MESSAGES.too_large)
  })
})

describe('the job', () => {
  it.each([
    ['collecting', /Reading tasks, section 5 of 26\. 1,240 records so far\./, 'collecting'],
    ['deleted', /Reading Deleted items: comments, section 25 of 26/, 'collecting'],
    ['others', /Ola Berg is preparing an export, started at/, 'collecting'],
    ['joined', /Ola Berg started this export at .*\. You asked for it\./, 'collecting'],
    ['failed', /many deleted items changed while it ran/, 'failed'],
    ['too-large', /too large to export as one download yet/, 'failed'],
    ['cancelled', /Cancelled by Ola Berg\./, 'cancelled'],
    ['expired', /This export expired at .*\. Prepare a new export\./, 'expired'],
  ])('shows %s with its sentence', async (state, sentence, shown) => {
    serve([state])
    await mount()
    expect(stateShown()).toBe(shown)
    expect(text()).toMatch(sentence)
  })

  it('offers Join export only to an admin who has not asked, and Export data once a job ended', async () => {
    serve(['others'])
    await mount()
    expect(button('[data-export-join]')).not.toBeNull()
    expect(button('[data-export-start]')).toBeNull()
    expect(button('[data-export-cancel]')).not.toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    serve(['joined'])
    await mount()
    expect(button('[data-export-join]')).toBeNull()
    for (const state of ['failed', 'cancelled', 'expired']) {
      await act(async () => root.unmount())
      root = createRoot(container)
      serve([state])
      await mount()
      expect(button('[data-export-start]'), state).not.toBeNull()
    }
  })

  it('says when the reading ends and the archive is being finished', async () => {
    serve(['collecting'])
    await mount()
    await act(async () =>
      server.update({
        progress: { section: '', records: 9, sections_done: 26, sections_total: 26 },
      }),
    )
    await settle()
    expect(text()).toContain(
      'Finishing the archive: its README, its manifest and a check of its files.',
    )
    expect(text()).not.toContain('27 of 26')
  })

  it('shows a ready archive, the server sending it and how many tasks it left out, never as saved', async () => {
    desktop()
    serve(['served', 'skipped'])
    server.update({ auto_download_at: new Date(NOW - 1000).toISOString() })
    await mount()
    expect(stateShown()).toBe('ready')
    expect(text()).toMatch(/Ready\. Available until .*, 0\.0 MB\./)
    expect(text()).toMatch(/Sent by Qivo at /)
    expect(text()).toContain('3 tasks were moving to or from Deleted items')
    expect(text()).not.toMatch(/Saved as/)
    expect(text()).toMatch(/The automatic download started at .*, here or on another device\./)
  })

  it('shows a ready job past its four hours as expired, with Export data', async () => {
    serve(['ready'])
    await mount()
    expect(stateShown()).toBe('ready')
    await act(async () => server.update({ expires_at: new Date(NOW - 1000).toISOString() }))
    await settle()
    expect(stateShown()).toBe('expired')
    expect(button('[data-export-download="latest"]')).toBeNull()
    expect(button('[data-export-start]')).not.toBeNull()
  })

  it('shows an older ready archive beside a newer job, with its own download', async () => {
    serve(['older'])
    await mount()
    expect(stateShown()).toBe('collecting')
    expect(text()).toContain('A newer export replaces it once it')
    expect(button('[data-export-download="older"]')).not.toBeNull()
  })

  it("says it couldn't load the export when the read fails, never that there is none", async () => {
    serve(['error'])
    await mount()
    expect(text()).toContain("Couldn't load the export.")
    expect(text()).not.toContain('No export has been prepared yet.')
    expect(button('[data-export-start]')).toBeNull()
  })

  it('says how each way saves in the record line, counting only confirmed saves', async () => {
    serve()
    // an export recorded before confirmed saves, which a backend from before
    // them answers alone, is no confirmed save
    const query = server.query
    server.query = (name) =>
      name === 'orgRemovals:state'
        ? { ...(query(name) as object), last_export_at: '2026-11-05T10:00:00.000Z' }
        : query(name)
    await mount()
    expect(container.querySelector('[data-org-last-export]')?.textContent).toBe(
      "No saved export has been confirmed yet. This browser can't tell Qivo when a download finishes. Chrome and Edge on a computer can. Deletion reminders count only confirmed saves.",
    )
  })
})

describe('the automatic attempt', () => {
  it('claims once with automatic when a current answer turns ready for the admin who asked', async () => {
    const download = desktop()
    // the route serves the archive as the desktop app downloads it
    download.mockImplementation(async () => {
      server.serve('export-1')
      return { state: 'completed', file: 'a.zip', bytes: 2048 }
    })
    serve(['collecting'])
    await mount()
    expect(claims()).toEqual([])
    await act(async () => server.finish())
    await settle()
    expect(claims()).toEqual([{ org_id: 'org-1', export_id: 'export-1', automatic: true }])
    expect(download).toHaveBeenCalledTimes(1)
    expect(sent('orgRemovals:recordExport')).toEqual([{ org_id: 'org-1', export_id: 'export-1' }])
    expect(container.querySelector('[data-org-last-export]')?.textContent).toMatch(
      /^Last saved export confirmed on .*2026\./,
    )
    // once the save ended, Download is offered again
    expect(button('[data-export-download="latest"]')?.disabled).toBe(false)
    // more answers bring no second attempt
    await act(async () => server.publish())
    await settle()
    expect(claims()).toHaveLength(1)
  })

  it('makes none while the tab is hidden, and one once it shows again', async () => {
    desktop()
    serve(['collecting'])
    await mount()
    await setVisibility('hidden')
    await act(async () => server.finish())
    await settle()
    expect(claims()).toEqual([])
    await setVisibility('visible')
    expect(claims()).toEqual([{ org_id: 'org-1', export_id: 'export-1', automatic: true }])
  })

  it('makes none from the answer it kept across a pause, and none once the new one says another device took it', async () => {
    desktop()
    serve(['ready'])
    // the page cannot save when the job shows ready, so no attempt yet
    planner.cannotSaveText.mockReturnValue('Saving is paused.')
    await mount()
    expect(claims()).toEqual([])
    await setVisibility('hidden')
    // meanwhile another device took the attempt
    server.update({ auto_download_at: new Date(NOW).toISOString() })
    planner.cannotSaveText.mockReturnValue(null)
    holding = []
    await setVisibility('visible')
    // the kept answer still says ready and unclaimed, but is not current,
    // also when the page looks again a minute later
    expect(section()?.getAttribute('aria-busy')).toBe('true')
    await act(async () => vi.advanceTimersByTime(60_000))
    await settle()
    expect(claims()).toEqual([])
    const waiting = holding
    holding = null
    await act(async () => {
      for (const answer of waiting) answer()
    })
    await settle()
    expect(claims()).toEqual([])
    expect(text()).toMatch(/The automatic download started at /)
  })

  it.each([
    ['an admin who did not ask', ['others'], () => server.finish()],
    ['an archive whose attempt was claimed', ['claimed'], () => {}],
    ['the older archive beside a newer job', ['older'], () => {}],
  ])('makes none for %s', async (_, states, step) => {
    desktop()
    serve(states)
    await mount()
    await act(async () => step())
    await settle()
    expect(claims()).toEqual([])
  })

  it('makes none after this page downloaded the export by hand', async () => {
    const download = desktop()
    serve(['ready'])
    // the page cannot save when the job shows ready, so no attempt yet
    planner.cannotSaveText.mockReturnValue('Saving is paused.')
    await mount()
    expect(claims()).toEqual([])
    planner.cannotSaveText.mockReturnValue(null)
    await press('[data-export-download="latest"]')
    expect(claims()).toEqual([{ org_id: 'org-1', export_id: 'export-1', automatic: false }])
    // the next answers and minutes bring no second download of the archive
    await act(async () => server.publish())
    await settle()
    await act(async () => vi.advanceTimersByTime(60_000))
    await settle()
    expect(claims()).toHaveLength(1)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('makes none a second time after its claim was refused', async () => {
    desktop()
    serve(['collecting'])
    await mount()
    network.mutation.mockImplementationOnce(async () => {
      throw new ConvexError({ code: 'rule', message: 'This export is no longer available.' })
    })
    await act(async () => server.finish())
    await settle()
    expect(claims()).toHaveLength(1)
    expect(text()).toContain('This export is no longer available.')
    await act(async () => server.publish())
    await settle()
    expect(claims()).toHaveLength(1)
  })

  it('waits while the page cannot save, spending no attempt, and claims once it can', async () => {
    desktop()
    serve(['collecting'])
    await mount()
    planner.cannotSaveText.mockReturnValue('Saving is paused while the connection is down.')
    await act(async () => server.finish())
    await settle()
    expect(claims()).toEqual([])
    planner.cannotSaveText.mockReturnValue(null)
    await act(async () => server.publish())
    await settle()
    expect(claims()).toHaveLength(1)
  })

  it('goes by the link in a browser that chooses files but holds none for the job', async () => {
    ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn()
    vi.stubGlobal('isSecureContext', true)
    serve(['collecting'])
    await mount()
    expect(section()?.getAttribute('data-export-delivery')).toBe('file')
    await act(async () => server.finish())
    await settle()
    expect(claims()).toEqual([{ org_id: 'org-1', export_id: 'export-1', automatic: true }])
    expect(text()).toContain('Your browser is downloading the export.')
    expect(sent('orgRemovals:recordExport')).toEqual([])
    expect(button('[data-export-download="latest"]')?.textContent).toBe('Save export…')
  })
})

describe('starting, joining, downloading and cancelling', () => {
  it('opens the picker before request in a browser that chooses files, and requests whatever it answered', async () => {
    const picker = vi.fn(async () => {
      order.push('picker')
      throw new DOMException('cancelled', 'AbortError')
    })
    ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker
    vi.stubGlobal('isSecureContext', true)
    serve()
    await mount()
    expect(button('[data-export-start]')?.textContent).toBe('Export data…')
    await press('[data-export-start]')
    expect(order).toEqual(['picker', 'orgExport:request'])
    expect(stateShown()).toBe('collecting')
  })

  it('joins an export another admin started, which gives this admin an attempt of their own', async () => {
    desktop()
    serve(['others'])
    await mount()
    await press('[data-export-join]')
    expect(sent('orgExport:request')).toEqual([{ org_id: 'org-1' }])
    expect(text()).toContain('You asked for it.')
    expect(text()).toContain('An export was already being prepared, so you joined it.')
  })

  it('downloads by hand with automatic false, the picker first in a browser that chooses files', async () => {
    const file = { name: 'x.zip', createWritable: vi.fn(), getFile: vi.fn() }
    ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => {
      order.push('picker')
      return file
    })
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    )
    serve(['claimed'])
    await mount()
    await press('[data-export-download="latest"]')
    expect(order).toEqual(['picker', 'orgExport:claimDownload'])
    expect(claims()).toEqual([{ org_id: 'org-1', export_id: 'export-1', automatic: false }])
  })

  it('says when the chosen file cannot be written, and asks for another place on the next Save export', async () => {
    const unwritable = {
      name: 'x.zip',
      createWritable: vi.fn(async () => {
        throw new DOMException('the folder is gone', 'NotFoundError')
      }),
      getFile: vi.fn(),
    }
    const picker = vi.fn(async () => unwritable)
    ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(2048), {
            status: 200,
            headers: { 'Content-Type': 'application/zip', 'Content-Length': '2048' },
          }),
      ),
    )
    serve(['claimed'])
    await mount()
    await press('[data-export-download="latest"]')
    expect(container.querySelector('[data-export-unwritable]')?.textContent).toContain(
      "Qivo couldn't write to the file you chose, so no export was saved.",
    )
    expect(button('[data-export-download="latest"]')?.textContent).toBe('Save export…')
    expect(button('[data-export-download="latest"]')?.disabled).toBe(false)
    await press('[data-export-download="latest"]')
    expect(picker).toHaveBeenCalledTimes(2)
  })

  it('asks before it cancels, then cancels', async () => {
    serve(['collecting'])
    await mount()
    await press('[data-export-cancel]')
    expect(sent('orgExport:cancel')).toEqual([])
    expect(text()).toContain('This stops the export for every admin who joined it.')
    await press('[data-export-cancel-confirm]')
    expect(sent('orgExport:cancel')).toEqual([{ org_id: 'org-1', export_id: 'export-1' }])
    expect(stateShown()).toBe('cancelled')
  })

  it('refuses every write while the page cannot save', async () => {
    desktop()
    serve(['others'])
    await mount()
    planner.cannotSaveText.mockReturnValue('Saving is paused.')
    await press('[data-export-join]')
    await press('[data-export-cancel]')
    await press('[data-export-cancel-confirm]')
    expect(network.mutation).not.toHaveBeenCalled()
    expect(text()).toContain('Saving is paused.')
  })

  it('names the unfinished file the desktop app could not delete', async () => {
    desktop({ state: 'failed', leftover: 'qivo-northstar-2026-11-09.zip' })
    serve(['claimed'])
    await mount()
    await press('[data-export-download="latest"]')
    expect(container.querySelector('[data-export-unconfirmed]')?.textContent).toBe(
      "The download didn't finish, so no export was saved. Try again. The desktop app couldn't delete the unfinished file qivo-northstar-2026-11-09.zip in your Downloads folder, so delete it yourself.",
    )
    expect(sent('orgRemovals:recordExport')).toEqual([])
  })

  it('offers Try again after a saved export whose record failed', async () => {
    desktop()
    serve(['collecting', 'record-error'])
    await mount()
    await act(async () => server.finish())
    await settle()
    expect(container.querySelector('[data-export-recorded="false"]')?.textContent).toContain(
      "The export was saved, but Qivo couldn't record it.",
    )
  })
})
