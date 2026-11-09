import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../convex/lib/limits.js'
import {
  answerExportDownload,
  createExportDownloads,
  type DownloadItemLike,
  EXPORT_MAX_BYTES,
  exportDownloadURL,
  FALLBACK_NAME,
  savePathIn,
} from './exportDownload.js'

const SITE = 'https://brave-otter-123.convex.site'
const LINK = `${SITE}/exports/7a1d?e=1767225600&m=k57abc&t=mac123`
const DIR = path.join(path.sep, 'home', 'nora', 'Downloads')

/** A fake download item of `url`, `total` bytes and `mime`, whose events
 * the test sends. */
function fakeItem(url: string, opts: { total?: number; mime?: string; name?: string } = {}) {
  const listeners = {
    updated: [] as ((event: unknown, state: 'progressing' | 'interrupted') => void)[],
    done: [] as ((event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void)[],
  }
  let received = 0
  const item = {
    savePath: null as string | null,
    cancelled: 0,
    getURL: () => url,
    getFilename: () => opts.name ?? 'qivo-acme-2026-11-07.zip',
    getMimeType: () => opts.mime ?? 'application/zip',
    getTotalBytes: () => opts.total ?? 1000,
    getReceivedBytes: () => received,
    setSavePath(file: string) {
      item.savePath = file
    },
    cancel() {
      item.cancelled += 1
      for (const done of listeners.done.splice(0)) done({}, 'cancelled')
    },
    on(_event: 'updated', listener: (typeof listeners.updated)[number]) {
      listeners.updated.push(listener)
      return item
    },
    once(_event: 'done', listener: (typeof listeners.done)[number]) {
      listeners.done.push(listener)
      return item
    },
    progress(bytes: number) {
      received = bytes
      for (const listener of listeners.updated) listener({}, 'progressing')
    },
    interrupt() {
      for (const listener of listeners.updated) listener({}, 'interrupted')
    },
    finish(state: 'completed' | 'cancelled' | 'interrupted', bytes = received) {
      received = bytes
      for (const done of listeners.done.splice(0)) done({}, state)
    },
  }
  const typed: DownloadItemLike = item
  return Object.assign(item, { typed })
}

function setup(files: string[] = [], remove?: (file: string) => void) {
  const existing = new Set(files)
  const removed: string[] = []
  const contents = { downloadURL: vi.fn() }
  const downloads = createExportDownloads({
    downloadsDir: () => DIR,
    exists: (file) => existing.has(file),
    remove: (file) => {
      remove?.(file)
      removed.push(file)
      existing.delete(file)
    },
    timeoutMs: 1000,
    stallMs: 5000,
  })
  return { downloads, contents, removed, existing }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the export link the shell accepts', () => {
  it("accepts the route's shape on a Convex site, and loopback HTTP only from source", () => {
    expect(exportDownloadURL(LINK, true)?.href).toBe(LINK)
    expect(exportDownloadURL(LINK, false)?.href).toBe(LINK)
    const local = 'http://127.0.0.1:3237/exports/7a1d?e=1&m=k&t=x'
    expect(exportDownloadURL(local, false)?.href).toBe(local)
    expect(
      exportDownloadURL('http://localhost:3211/exports/7a1d?t=x&e=1&m=k', false),
    ).not.toBeNull()
    // a packaged build never downloads over HTTP, loopback included
    expect(exportDownloadURL(local, true)).toBeNull()
    // the build's own origin, when it sets one, is the only origin
    expect(exportDownloadURL(LINK, true, 'https://other-9.convex.site')).toBeNull()
    expect(
      exportDownloadURL(
        'https://other-9.convex.site/exports/7a1d?e=1&m=k&t=x',
        true,
        'https://other-9.convex.site',
      ),
    ).not.toBeNull()
  })

  it.each([
    ['another host', 'https://qivo.io/exports/7a1d?e=1&m=k&t=x'],
    [
      'a host that only contains the suffix',
      'https://convex.site.evil.example/exports/7a1d?e=1&m=k&t=x',
    ],
    ['the bare suffix', 'https://.convex.site/exports/7a1d?e=1&m=k&t=x'],
    ['HTTP to a Convex site', 'http://brave-otter-123.convex.site/exports/7a1d?e=1&m=k&t=x'],
    ['another path', `${SITE}/files/7a1d?e=1&m=k&t=x`],
    ['a second segment', `${SITE}/exports/7a1d/more?e=1&m=k&t=x`],
    ['an empty segment', `${SITE}/exports/?e=1&m=k&t=x`],
    ['a missing parameter', `${SITE}/exports/7a1d?e=1&m=k`],
    ['a repeated parameter', `${SITE}/exports/7a1d?e=1&m=k&t=x&t=y`],
    ['an extra parameter', `${SITE}/exports/7a1d?e=1&m=k&t=x&download=1`],
    ['credentials', 'https://user:pass@brave-otter-123.convex.site/exports/7a1d?e=1&m=k&t=x'],
    ['a fragment', `${LINK}#here`],
    ['no URL at all', 'not a url'],
  ])('refuses %s', (_, raw) => {
    expect(exportDownloadURL(raw, true)).toBeNull()
    expect(exportDownloadURL(raw, false)).toBeNull()
  })
})

describe('where the shell saves an export', () => {
  it('saves under the name the answer gives, made unique as browsers do', () => {
    const taken = new Set<string>()
    const exists = (file: string) => taken.has(file)
    const first = savePathIn(DIR, 'qivo-acme-2026-11-07.zip', exists)
    expect(first).toBe(path.join(DIR, 'qivo-acme-2026-11-07.zip'))
    taken.add(first)
    const second = savePathIn(DIR, 'qivo-acme-2026-11-07.zip', exists)
    expect(second).toBe(path.join(DIR, 'qivo-acme-2026-11-07 (1).zip'))
    taken.add(second)
    expect(savePathIn(DIR, 'qivo-acme-2026-11-07.zip', exists)).toBe(
      path.join(DIR, 'qivo-acme-2026-11-07 (2).zip'),
    )
  })

  it.each([
    ['an empty name', ''],
    ['a name that is no ZIP file', 'report.exe'],
    ['a bare extension', '.zip'],
  ])('falls back to its own name for %s', (_, name) => {
    expect(savePathIn(DIR, name, () => false)).toBe(path.join(DIR, FALLBACK_NAME))
  })

  it('never leaves the Downloads folder, whatever the name says', () => {
    for (const name of ['../../etc/evil.zip', '..\\..\\evil.zip', '/tmp/evil.zip'])
      expect(path.dirname(savePathIn(DIR, name, () => false)), name).toBe(DIR)
  })

  it("caps a download at the server's archive cap", () => {
    expect(EXPORT_MAX_BYTES).toBe(LIMITS.exportSize.max * 1024 * 1024)
  })
})

describe("the shell's export downloads", () => {
  it('saves its own item at once into Downloads and answers the file and its bytes when it completes whole', async () => {
    const { downloads, contents } = setup()
    const answer = downloads.start(contents, LINK)
    expect(contents.downloadURL).toHaveBeenCalledWith(LINK)
    const item = fakeItem(LINK)
    downloads.willDownload({}, item.typed, contents)
    expect(item.savePath).toBe(path.join(DIR, 'qivo-acme-2026-11-07.zip'))
    item.progress(400)
    item.finish('completed', 1000)
    await expect(answer).resolves.toEqual({
      state: 'completed',
      file: 'qivo-acme-2026-11-07.zip',
      bytes: 1000,
    })
  })

  it('leaves every other download to Electron, its URL or its contents another', async () => {
    const { downloads, contents } = setup()
    const answer = downloads.start(contents, LINK)
    const image = fakeItem('blob:https://qivo.io/1234', { mime: 'image/png', name: 'chart.png' })
    downloads.willDownload({}, image.typed, contents)
    const elsewhere = fakeItem(LINK)
    downloads.willDownload({}, elsewhere.typed, { downloadURL: vi.fn() })
    expect(image.savePath).toBeNull()
    expect(image.cancelled).toBe(0)
    expect(elsewhere.savePath).toBeNull()
    expect(elsewhere.cancelled).toBe(0)
    // and with no download of its own running, none either
    const own = fakeItem(LINK)
    downloads.willDownload({}, own.typed, contents)
    own.finish('completed', 1000)
    await answer
    const after = fakeItem('https://example.com/report.zip')
    downloads.willDownload({}, after.typed, contents)
    expect(after.savePath).toBeNull()
  })

  it.each([
    ['cancelled', 'cancelled', 'cancelled'],
    ['interrupted', 'interrupted', 'interrupted'],
  ] as const)('removes the file of an item %s and answers its state', async (_, end, state) => {
    const { downloads, contents, removed } = setup()
    const answer = downloads.start(contents, LINK)
    const item = fakeItem(LINK)
    downloads.willDownload({}, item.typed, contents)
    item.progress(300)
    item.finish(end)
    await expect(answer).resolves.toEqual({ state })
    expect(removed).toEqual([item.savePath])
  })

  it('answers failed, naming the file, when it cannot remove a partial one, and takes the next download', async () => {
    const { downloads, contents } = setup([], () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const answer = downloads.start(contents, LINK)
    const item = fakeItem(LINK)
    downloads.willDownload({}, item.typed, contents)
    item.progress(300)
    item.interrupt()
    await expect(answer).resolves.toEqual({
      state: 'failed',
      leftover: 'qivo-acme-2026-11-07.zip',
    })
    // the shell runs nothing any more, so the next export is not busy
    const next = downloads.start(contents, LINK)
    const again = fakeItem(LINK)
    downloads.willDownload({}, again.typed, contents)
    again.finish('completed', 1000)
    await expect(next).resolves.toMatchObject({ state: 'completed' })
  })

  it('answers interrupted for a completed item short of its total, and removes the file', async () => {
    const { downloads, contents, removed } = setup()
    const answer = downloads.start(contents, LINK)
    const item = fakeItem(LINK)
    downloads.willDownload({}, item.typed, contents)
    item.finish('completed', 999)
    await expect(answer).resolves.toEqual({ state: 'interrupted' })
    expect(removed).toEqual([item.savePath])
  })

  it('cancels an interrupted item Chromium would keep to resume, and one that stops making progress', async () => {
    const { downloads, contents, removed } = setup()
    const first = downloads.start(contents, LINK)
    const item = fakeItem(LINK)
    downloads.willDownload({}, item.typed, contents)
    item.progress(100)
    item.interrupt()
    await expect(first).resolves.toEqual({ state: 'interrupted' })
    expect(item.cancelled).toBe(1)
    expect(removed).toEqual([item.savePath])

    const second = downloads.start(contents, LINK)
    const stalled = fakeItem(LINK)
    downloads.willDownload({}, stalled.typed, contents)
    stalled.progress(100)
    vi.advanceTimersByTime(4999)
    stalled.progress(200)
    vi.advanceTimersByTime(4999)
    expect(stalled.cancelled).toBe(0)
    vi.advanceTimersByTime(2)
    await expect(second).resolves.toEqual({ state: 'interrupted' })
    expect(stalled.cancelled).toBe(1)
  })

  it.each([
    ['another type', { mime: 'text/html' }],
    ['no size', { total: 0 }],
    ['more than the cap', { total: EXPORT_MAX_BYTES + 1 }],
  ])('refuses an item of %s without saving it', async (_, opts) => {
    const { downloads, contents } = setup()
    const answer = downloads.start(contents, LINK)
    const item = fakeItem(LINK, opts)
    downloads.willDownload({}, item.typed, contents)
    expect(item.savePath).toBeNull()
    expect(item.cancelled).toBe(1)
    await expect(answer).resolves.toEqual({ state: 'failed' })
  })

  it('answers failed when no item comes within its time, and cancels a late one', async () => {
    const { downloads, contents } = setup()
    const answer = downloads.start(contents, LINK)
    vi.advanceTimersByTime(1000)
    await expect(answer).resolves.toEqual({ state: 'failed' })
    const late = fakeItem(LINK)
    downloads.willDownload({}, late.typed, contents)
    expect(late.cancelled).toBe(1)
    expect(late.savePath).toBeNull()
  })

  it('answers busy for a second download while one runs', async () => {
    const { downloads, contents } = setup()
    const first = downloads.start(contents, LINK)
    await expect(downloads.start(contents, LINK)).resolves.toEqual({ state: 'busy' })
    const item = fakeItem(LINK)
    downloads.willDownload({}, item.typed, contents)
    item.finish('completed', 1000)
    await expect(first).resolves.toMatchObject({ state: 'completed' })
  })
})

describe("the shell's download handler", () => {
  const start = vi.fn(async () => ({ state: 'completed' as const, file: 'a.zip', bytes: 1 }))
  const call = (over: Partial<Parameters<typeof answerExportDownload>[0]> = {}) =>
    answerExportDownload({
      authorized: true,
      raw: LINK,
      packaged: true,
      contents: () => ({ downloadURL: vi.fn() }),
      downloads: { start },
      ...over,
    })

  it("downloads only for the app's own page, a link the shell accepts and an open window", async () => {
    start.mockClear()
    await expect(call()).resolves.toMatchObject({ state: 'completed' })
    expect(start).toHaveBeenCalledTimes(1)
    for (const over of [
      { authorized: false },
      { raw: 42 },
      { raw: 'https://qivo.io/exports/7a1d?e=1&m=k&t=x' },
      { contents: () => null },
    ])
      await expect(call(over), JSON.stringify(over)).resolves.toEqual({ state: 'refused' })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("is registered in main.ts behind the app page's check, and listens for downloads on the session", () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    expect(main).toMatch(
      /ipcMain\.handle\('qivo:org-export:download', \(event, raw: unknown\) =>\s*answerExportDownload\(\{\s*authorized: isAuthorizedRenderer\(event\),/,
    )
    expect(main).toMatch(
      /session\.defaultSession\.on\('will-download', exportDownloads\.willDownload\)/,
    )
  })
})
