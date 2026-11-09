// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The organization export's delivery (lib/orgExport.ts): which way a page
   saves, the order of the file, the claim and the request, what a save
   must hold to be confirmed, and that only a confirmed save records. The
   Convex client, the page's planner, fetch, the picker and the desktop
   bridge are stand-ins. */

const network = vi.hoisted(() => ({ mutation: vi.fn() }))
vi.mock('./convex', () => ({ convex: network }))
const planner = vi.hoisted(() => ({
  cannotSaveText: vi.fn((): string | null => null),
  hasUnsavedWork: vi.fn(() => false),
}))
vi.mock('../store/planner', () => ({ P: planner }))

type Module = typeof import('./orgExport')
type Guard = typeof import('./leaveGuard')
type Updates = typeof import('./updateSafety')
let m: Module
let guard: Guard
let updates: Updates

const ORG = 'org-1'
const EXPORT = 'export-1'
const LINK = 'https://brave-otter-123.convex.site/exports/export-1?e=1&m=k&t=secret'
const order: string[] = []

/** The mutations sent, by name and arguments. */
const sent = () =>
  network.mutation.mock.calls.map(([ref, args]) => [getFunctionName(ref), args] as const)
const records = () => sent().filter(([name]) => name === 'orgRemovals:recordExport')

/** Answers each claim with `answer` and each record with null. */
function serve(answer: unknown = { url: LINK, expires_at: '2026-11-09T12:02:00.000Z' }) {
  network.mutation.mockImplementation(async (ref) => {
    const name = getFunctionName(ref)
    order.push(name)
    if (name === 'orgExport:claimDownload') {
      if (answer instanceof Error) throw answer
      return answer
    }
    return null
  })
}

/** A body of `chunks` that hands chunk k + 1 only once the writer took
 * chunk k, so a reader that collects the body before writing never ends. */
function pacedBody(chunks: Uint8Array[], taken: { count: number }, fail?: number) {
  let next = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (fail !== undefined && next === fail) {
        controller.error(new Error('the network went away'))
        return
      }
      if (next >= chunks.length) {
        controller.close()
        return
      }
      // wait until the writer took every chunk before this one
      for (let i = 0; i < 200 && taken.count < next; i++) await new Promise((r) => setTimeout(r, 0))
      if (taken.count < next) {
        controller.error(new Error('the reader collected the body before writing it'))
        return
      }
      controller.enqueue(chunks[next])
      next += 1
    },
  })
}

/** A file the picker answers, whose writable records what it took, closed
 * and aborted. */
function fakeFile(name = 'qivo-acme-2026-11-09.zip', taken = { count: 0 }) {
  const state = {
    bytes: [] as number[],
    chunks: 0,
    closed: false,
    aborted: false,
    opened: 0,
    removed: false,
    size: 0,
    order,
  }
  const file = {
    name,
    async createWritable() {
      state.opened += 1
      order.push('open')
      const stream = new WritableStream<Uint8Array>({
        write(chunk) {
          state.chunks += 1
          state.bytes.push(...chunk)
          taken.count += 1
        },
        close() {
          state.closed = true
          state.size = state.bytes.length
        },
        abort() {
          state.aborted = true
          state.bytes = []
        },
      })
      return Object.assign(stream, {})
    },
    async getFile() {
      return { size: state.size }
    },
    async remove() {
      state.removed = true
    },
  }
  return { file, state }
}

function zipResponse(body: ReadableStream<Uint8Array> | null, length: number | null, init = {}) {
  const headers = new Headers({ 'Content-Type': 'application/zip' })
  if (length !== null) headers.set('Content-Length', String(length))
  return new Response(body, { status: 200, headers, ...init })
}

const bytes = (n: number, from = 0) => Uint8Array.from({ length: n }, (_, i) => (from + i) % 251)

/** A body that holds `data` in one chunk. */
const streamOf = (data: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })

beforeEach(async () => {
  vi.resetModules()
  order.length = 0
  network.mutation.mockReset()
  planner.cannotSaveText.mockReset().mockReturnValue(null)
  planner.hasUnsavedWork.mockReset().mockReturnValue(false)
  serve()
  vi.stubGlobal('isSecureContext', true)
  m = await import('./orgExport')
  guard = await import('./leaveGuard')
  updates = await import('./updateSafety')
})
afterEach(() => {
  m.resetExportDelivery()
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
  delete (window as { qivoDesktop?: unknown }).qivoDesktop
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const picker = (answer: () => Promise<unknown>) => {
  ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(() => {
    order.push('picker')
    return answer()
  })
}
const bridge = (download: (url: string) => Promise<unknown>) => {
  ;(window as { qivoDesktop?: unknown }).qivoDesktop = { orgExport: { download: vi.fn(download) } }
}

describe('the way a page saves an export', () => {
  it('is the desktop app with its bridge, also where the picker exists', () => {
    picker(async () => ({}))
    bridge(async () => ({ state: 'failed' }))
    expect(m.exportWay()).toBe('desktop')
  })

  it('is the link in a desktop test build without the export bridge', () => {
    picker(async () => ({}))
    ;(window as { qivoDesktop?: unknown }).qivoDesktop = { isElectron: true }
    expect(m.exportWay()).toBe('link')
  })

  it('is a file only in a secure context with the picker, else the link', async () => {
    picker(async () => ({}))
    expect(m.exportWay()).toBe('file')
    m.resetExportDelivery()
    vi.stubGlobal('isSecureContext', false)
    expect(m.exportWay()).toBe('link')
    m.resetExportDelivery()
    vi.stubGlobal('isSecureContext', true)
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    expect(m.exportWay()).toBe('link')
  })
})

describe('the file way', () => {
  async function save(
    response: Response | (() => Response | Promise<Response>),
    archiveBytes: number,
    file = fakeFile(),
  ) {
    picker(async () => file.file)
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      typeof response === 'function' ? response() : response,
    )
    vi.stubGlobal('fetch', fetcher)
    const chosen = await m.chooseExportFile('acme')
    if (chosen.file === null) throw new Error('no file')
    await m.deliverExport({
      orgId: ORG,
      exportId: EXPORT,
      archiveBytes,
      automatic: false,
      file: chosen.file,
    })
    return { fetcher, ...file }
  }

  it('streams exactly the archive into a file that closes, then records it once with its export', async () => {
    // each chunk comes only once the file took the one before, so a page
    // that collected the body before writing it would never finish
    const taken = { count: 0 }
    const chunks = [bytes(1000), bytes(1000, 1000), bytes(500, 2000)]
    const file = fakeFile(undefined, taken)
    const { fetcher, state } = await save(zipResponse(pacedBody(chunks, taken), 2500), 2500, file)
    expect(state.closed).toBe(true)
    expect(state.bytes).toEqual([...chunks[0], ...chunks[1], ...chunks[2]])
    expect(records()).toEqual([['orgRemovals:recordExport', { org_id: ORG, export_id: EXPORT }]])
    // the file first, the claim second, the request at once
    expect(order.slice(0, 3)).toEqual(['picker', 'orgExport:claimDownload', 'open'])
    expect(fetcher).toHaveBeenCalledWith(LINK, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
    expect(m.deliveryNow()).toEqual({
      exportId: EXPORT,
      state: 'saved',
      file: 'qivo-acme-2026-11-09.zip',
      record: 'recorded',
    })
    expect(JSON.stringify(m.deliveryNow())).not.toContain('secret')
  })

  it('saves a body without Content-Length by counting it', async () => {
    const { state } = await save(zipResponse(streamOf(bytes(300)), null), 300)
    expect(state.closed).toBe(true)
    expect(records()).toHaveLength(1)
  })

  it.each([
    [
      'a body that errors part way',
      () => zipResponse(pacedBody([bytes(100), bytes(100)], { count: 9 }, 1), 200),
      200,
    ],
    ['a body shorter than its length', () => zipResponse(streamOf(bytes(150)), null), 200],
    ['a body longer than the archive', () => zipResponse(streamOf(bytes(250)), null), 200],
  ])('never closes the file or records for %s', async (_, response, archiveBytes) => {
    const { state } = await save(response, archiveBytes)
    expect(state.opened).toBe(1)
    expect(state.closed).toBe(false)
    expect(state.aborted).toBe(true)
    expect(records()).toEqual([])
    // the empty file the picker made goes again
    expect(state.removed).toBe(true)
    expect(m.deliveryNow()).toEqual({ exportId: EXPORT, state: 'stopped', removed: true })
  })

  it.each([
    ['a length that differs from the archive', () => zipResponse(streamOf(bytes(10)), 10), 20],
    [
      'another type',
      () =>
        new Response(streamOf(bytes(20)), {
          status: 200,
          headers: { 'Content-Type': 'text/html', 'Content-Length': '20' },
        }),
      20,
    ],
    ['a 404', () => new Response(null, { status: 404 }), 20],
  ])('never opens the file for %s', async (_, response, archiveBytes) => {
    const { state } = await save(response, archiveBytes)
    expect(state.opened).toBe(0)
    expect(records()).toEqual([])
    expect(m.deliveryNow()).toEqual({ exportId: EXPORT, state: 'unconfirmed' })
  })

  it('answers busy with the seconds of a 429', async () => {
    const { state } = await save(
      new Response(null, { status: 429, headers: { 'Retry-After': '30' } }),
      20,
    )
    expect(state.opened).toBe(0)
    expect(m.deliveryNow()).toEqual({ exportId: EXPORT, state: 'busy', retryAfter: 30 })
  })

  it('stops a save on Stop, discarding what it wrote', async () => {
    let release: () => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(100))
      },
      pull() {
        return new Promise<void>((resolve) => {
          release = resolve
        })
      },
    })
    picker(async () => fakeFile().file)
    const file = fakeFile()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => zipResponse(body, 200)),
    )
    const saving = m.deliverExport({
      orgId: ORG,
      exportId: EXPORT,
      archiveBytes: 200,
      automatic: false,
      file: file.file,
    })
    await vi.waitFor(() => expect(m.deliveryNow()).toMatchObject({ state: 'saving' }))
    m.stopExportSave()
    release()
    await saving
    expect(file.state.closed).toBe(false)
    expect(file.state.aborted).toBe(true)
    expect(records()).toEqual([])
    expect(m.deliveryNow()).toMatchObject({ state: 'stopped' })
  })

  it('claims nothing for a cancelled picker', async () => {
    picker(async () => {
      throw new DOMException('cancelled', 'AbortError')
    })
    expect(await m.chooseExportFile('acme')).toEqual({ file: null, reason: null })
    expect(
      await m.deliverExport({ orgId: ORG, exportId: EXPORT, archiveBytes: 1, automatic: false }),
    ).toBe(false)
    expect(sent()).toEqual([])
  })

  it('suggests the name the route gives the archive', async () => {
    const show = vi.fn(async () => fakeFile().file)
    ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = show
    await m.chooseExportFile('acme')
    expect(show).toHaveBeenCalledWith({
      suggestedName: expect.stringMatching(/^qivo-acme-\d{4}-\d{2}-\d{2}\.zip$/),
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      startIn: 'downloads',
    })
  })

  it('sends a local demo through its forwarded backend', async () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_APP_MODE', 'demo')
    vi.stubEnv('VITE_CONVEX_URL', 'http://127.0.0.1:3210')
    vi.stubEnv('VITE_CONVEX_SITE_URL', 'http://127.0.0.1:3211')
    serve({ url: 'http://127.0.0.1:3211/exports/export-1?e=1&m=k&t=x', expires_at: '' })
    const { fetcher } = await save(zipResponse(streamOf(bytes(5)), 5), 5)
    expect(fetcher.mock.calls[0][0]).toBe(
      `${window.location.origin}/__qivo_http/exports/export-1?e=1&m=k&t=x`,
    )
  })

  it('holds the unsaved lease and the update block only while it writes', async () => {
    let during: [boolean, boolean] | null = null
    const response = async () => {
      during = [guard.hasUnsaved(), updates.isUpdateBlocked()]
      return zipResponse(streamOf(bytes(5)), 5)
    }
    expect([guard.hasUnsaved(), updates.isUpdateBlocked()]).toEqual([false, false])
    await save(response, 5)
    expect(during).toEqual([true, true])
    expect([guard.hasUnsaved(), updates.isUpdateBlocked()]).toEqual([false, false])
  })

  it('leaves a saved, unrecorded export to Try again, which records and never downloads again', async () => {
    let fail = true
    network.mutation.mockImplementation(async (ref) => {
      const name = getFunctionName(ref)
      if (name === 'orgExport:claimDownload') return { url: LINK, expires_at: '' }
      if (fail) throw new Error('offline')
      return null
    })
    const { fetcher } = await save(zipResponse(streamOf(bytes(5)), 5), 5)
    expect(m.deliveryNow()).toMatchObject({ state: 'saved', record: 'failed' })
    fail = false
    await m.retryExportRecord()
    expect(m.deliveryNow()).toMatchObject({ state: 'saved', record: 'recorded' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(sent().filter(([name]) => name === 'orgExport:claimDownload')).toHaveLength(1)
    expect(records()).toHaveLength(2)
  })
})

describe('the desktop way', () => {
  it('hands the claimed link to the bridge at once and records a completed download of the archive', async () => {
    bridge(async (url) => {
      order.push(`bridge ${url}`)
      return { state: 'completed', file: 'qivo-acme.zip', bytes: 2500 }
    })
    await m.deliverExport({ orgId: ORG, exportId: EXPORT, archiveBytes: 2500, automatic: true })
    expect(order).toEqual(['orgExport:claimDownload', `bridge ${LINK}`, 'orgRemovals:recordExport'])
    expect(records()).toEqual([['orgRemovals:recordExport', { org_id: ORG, export_id: EXPORT }]])
    expect(m.deliveryNow()).toMatchObject({ state: 'saved', file: 'qivo-acme.zip' })
  })

  it.each([
    ['completed with other bytes', { state: 'completed', file: 'a.zip', bytes: 2499 }],
    ['interrupted', { state: 'interrupted' }],
    ['cancelled', { state: 'cancelled' }],
    ['failed', { state: 'failed' }],
    ['busy', { state: 'busy' }],
    ['refused', { state: 'refused' }],
  ])('records nothing for an answer %s', async (_, answer) => {
    bridge(async () => answer)
    await m.deliverExport({ orgId: ORG, exportId: EXPORT, archiveBytes: 2500, automatic: false })
    expect(records()).toEqual([])
    expect(m.deliveryNow()?.state).not.toBe('saved')
  })

  it('holds the unsaved lease and the update block until the bridge answers', async () => {
    let answer: (value: unknown) => void = () => {}
    bridge(() => new Promise((resolve) => (answer = resolve)))
    const saving = m.deliverExport({
      orgId: ORG,
      exportId: EXPORT,
      archiveBytes: 1,
      automatic: false,
    })
    await vi.waitFor(() => expect(m.deliveryNow()).toMatchObject({ state: 'downloading' }))
    expect([guard.hasUnsaved(), updates.isUpdateBlocked()]).toEqual([true, true])
    answer({ state: 'completed', file: 'a.zip', bytes: 1 })
    await saving
    expect([guard.hasUnsaved(), updates.isUpdateBlocked()]).toEqual([false, false])
  })
})

describe('the link way', () => {
  it('clicks one anchor to the link with no download and no target, and removes it; no fetch, no record', async () => {
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this)
    })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await m.deliverExport({ orgId: ORG, exportId: EXPORT, archiveBytes: 1, automatic: true })
    expect(clicked).toHaveLength(1)
    expect(clicked[0].href).toBe(LINK)
    expect(clicked[0].hasAttribute('download')).toBe(false)
    expect(clicked[0].hasAttribute('target')).toBe(false)
    expect(clicked[0].rel).toBe('noopener')
    expect(clicked[0].isConnected).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    expect(records()).toEqual([])
    expect(m.deliveryNow()).toEqual({ exportId: EXPORT, state: 'sent' })
  })

  it('waits for no write in flight before it claims and navigates', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    planner.hasUnsavedWork.mockReturnValue(true)
    const sending = m.deliverExport({
      orgId: ORG,
      exportId: EXPORT,
      archiveBytes: 1,
      automatic: true,
    })
    await new Promise((r) => setTimeout(r, 600))
    expect(sent()).toEqual([])
    planner.hasUnsavedWork.mockReturnValue(false)
    await sending
    expect(sent().map(([name]) => name)).toEqual(['orgExport:claimDownload'])
  })
})

describe('the runner', () => {
  it('answers busy for a second delivery while one runs', async () => {
    let answer: (value: unknown) => void = () => {}
    bridge(() => new Promise((resolve) => (answer = resolve)))
    const first = m.deliverExport({
      orgId: ORG,
      exportId: EXPORT,
      archiveBytes: 1,
      automatic: false,
    })
    await vi.waitFor(() => expect(m.deliveryRunning()).toBe(true))
    expect(
      await m.deliverExport({ orgId: ORG, exportId: EXPORT, archiveBytes: 1, automatic: false }),
    ).toBe(false)
    answer({ state: 'completed', file: 'a.zip', bytes: 1 })
    await first
    expect(sent().filter(([name]) => name === 'orgExport:claimDownload')).toHaveLength(1)
  })

  it('refuses while the page cannot save, spending no automatic attempt', async () => {
    bridge(async () => ({ state: 'completed', file: 'a.zip', bytes: 1 }))
    planner.cannotSaveText.mockReturnValue('You are offline.')
    expect(
      await m.deliverExport({ orgId: ORG, exportId: EXPORT, archiveBytes: 1, automatic: true }),
    ).toBe(false)
    expect(sent()).toEqual([])
    expect(m.autoAttempted(EXPORT)).toBe(false)
    expect(m.deliveryNow()).toEqual({
      exportId: EXPORT,
      state: 'refused',
      message: 'You are offline.',
    })
  })

  it("counts an automatic attempt the server answered, its refusal included, and shows the server's sentence", async () => {
    bridge(async () => ({ state: 'completed', file: 'a.zip', bytes: 1 }))
    serve(
      new ConvexError({
        code: 'rule',
        message: 'This export is no longer available. Prepare a new export.',
      }),
    )
    await m.deliverExport({ orgId: ORG, exportId: EXPORT, archiveBytes: 1, automatic: true })
    expect(m.autoAttempted(EXPORT)).toBe(true)
    expect(m.deliveryNow()).toEqual({
      exportId: EXPORT,
      state: 'refused',
      message: 'This export is no longer available. Prepare a new export.',
    })
    serve({ url: null, reason: 'claimed' })
    await m.deliverExport({ orgId: ORG, exportId: 'export-2', archiveBytes: 1, automatic: true })
    expect(m.autoAttempted('export-2')).toBe(true)
    expect(m.deliveryNow()).toEqual({ exportId: 'export-2', state: 'claimed' })
  })

  it('goes on and records after the panel that started it is gone, keeping no link', async () => {
    let answer: (value: unknown) => void = () => {}
    bridge(() => new Promise((resolve) => (answer = resolve)))
    const saving = m.deliverExport({
      orgId: ORG,
      exportId: EXPORT,
      archiveBytes: 3,
      automatic: false,
    })
    await vi.waitFor(() => expect(m.deliveryNow()).toMatchObject({ state: 'downloading' }))
    // nothing of the panel takes part from here on
    answer({ state: 'completed', file: 'a.zip', bytes: 3 })
    await saving
    expect(records()).toHaveLength(1)
    expect(JSON.stringify(m.deliveryNow())).not.toContain('secret')
    expect(JSON.stringify({ ...localStorage })).not.toContain('secret')
  })

  it('deletes a held file that is still empty when it lets go of it, never one that holds anything', async () => {
    const empty = fakeFile()
    m.holdExportFile(EXPORT, empty.file)
    expect(await m.discardExportFile(EXPORT)).toBe(true)
    expect(empty.state.removed).toBe(true)
    expect(m.heldExportFile(EXPORT)).toBeNull()
    const full = fakeFile()
    full.state.size = 10
    m.holdExportFile(EXPORT, full.file)
    expect(await m.discardExportFile(EXPORT)).toBe(false)
    expect(full.state.removed).toBe(false)
  })
})
