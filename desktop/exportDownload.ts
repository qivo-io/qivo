import path from 'node:path'

/* The desktop app's own download of an organization export: the export page
 * claims a two-minute link to the /exports/ route (convex/orgExport.ts
 * claimDownload) and hands it to the shell through
 * window.qivoDesktop.orgExport.download (preload.cts), and the shell
 * downloads it into the Downloads folder with Electron's download item and
 * answers when the item is done. Only a completed item that received
 * exactly its total bytes counts as saved, which the page then records for
 * the deletion reminder (src/lib/orgExport.ts). Every other download in the
 * session keeps Electron's default, its own save dialog.
 *
 * This module has no Electron import, so its tests run with fakes of the
 * download item and the page's contents, as updatePrompt.ts does. */

/** The most bytes an export download may hold: convex/lib/limits.ts
 * LIMITS.exportSize, 95 MiB, the server's archive cap. */
export const EXPORT_MAX_BYTES = 95 * 1024 * 1024

/** The base name the shell saves an export under when the route's answer
 * names no ZIP file. */
export const FALLBACK_NAME = 'qivo-export.zip'

/** What the page's download call answers: the saved file's base name and
 * its bytes when the download completed whole, else how it ended. A
 * download that did not complete and whose partial file the shell could not
 * remove answers `failed` with that file's base name in `leftover`, so the
 * page can ask the person to delete it. `declined` is an answer of the
 * route that is no archive, such as its 429 while other downloads of the
 * archive run or its 404, apart from a transfer that broke off, and
 * `refused` a link the shell would not download at all. */
export type ExportDownloadAnswer =
  | { state: 'completed'; file: string; bytes: number }
  | { state: 'failed'; leftover: string }
  | { state: 'cancelled' | 'interrupted' | 'failed' | 'busy' | 'refused' | 'declined' }

/** The parts of Electron's DownloadItem this module uses. */
export type DownloadItemLike = {
  getURL(): string
  getFilename(): string
  getMimeType(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  setSavePath(path: string): void
  cancel(): void
  on(
    event: 'updated',
    listener: (event: unknown, state: 'progressing' | 'interrupted') => void,
  ): unknown
  once(
    event: 'done',
    listener: (event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void,
  ): unknown
}

/** The part of Electron's WebContents that starts a download. */
export type DownloadContents = { downloadURL(url: string): void }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const SITE_SUFFIX = '.convex.site'

/**
 * `raw` as a URL the shell may download an export from, else null: the
 * route's shape, `/exports/<one segment>` with exactly the query `e`, `m`
 * and `t`, once each, no user name, password or fragment. A `packaged`
 * build takes it only from `origin`, its deployment's export origin
 * (appURL.ts resolveExportOrigin), compared whole, port included, and
 * refuses every link without one. A run from source takes HTTPS from a
 * host ending in `.convex.site`, the form every Convex site URL has
 * (docs/deployment.md), and HTTP on a loopback host, a local backend's
 * site. The origin never comes from the page.
 */
export function exportDownloadURL(
  raw: string,
  packaged: boolean,
  origin: string | null,
): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password || url.hash || raw.includes('#')) return null
  if (packaged) {
    if (origin === null || url.origin !== origin) return null
  } else {
    const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
    const site = url.protocol === 'https:' && isConvexSite(url.hostname)
    if (!local && !site) return null
  }
  if (!/^\/exports\/[^/]+$/.test(url.pathname)) return null
  const names = [...url.searchParams.keys()]
  if (names.length !== 3 || new Set(names).size !== 3) return null
  if (!['e', 'm', 't'].every((name) => url.searchParams.has(name))) return null
  return url
}

const isConvexSite = (host: string) =>
  host.endsWith(SITE_SUFFIX) && host.length > SITE_SUFFIX.length

/**
 * The path in `dir` to save a download named `name` at: the base name
 * Chromium took from the answer's Content-Disposition, or FALLBACK_NAME
 * when it is empty or names no ZIP file, made unique with ` (1)`, ` (2)`
 * and on before the extension while `exists` finds a file of that name.
 */
export function savePathIn(dir: string, name: string, exists: (file: string) => boolean): string {
  const base = path.basename(name.replaceAll('\\', '/'))
  const file = base.toLowerCase().endsWith('.zip') && base.length > 4 ? base : FALLBACK_NAME
  const stem = file.slice(0, -4)
  let candidate = path.join(dir, file)
  for (let n = 1; exists(candidate); n++) candidate = path.join(dir, `${stem} (${n}).zip`)
  return candidate
}

type Options = {
  /** The Downloads folder, read when a download starts. */
  downloadsDir: () => string
  exists: (file: string) => boolean
  /** Removes a file, if any, ignoring a missing one. It may throw, for a
   * file another program holds open or a folder whose permission changed. */
  remove: (file: string) => void
  /** How long the shell waits for Chromium to start the item. */
  timeoutMs?: number
  /** How long an item may go without progress before the shell stops it. */
  stallMs?: number
  maxBytes?: number
}

/**
 * The shell's export downloads, one at a time. `start` downloads `url` in
 * `contents` and answers when its item is done, `busy` while another runs,
 * and `failed` when no item came within `timeoutMs`; an item of that URL
 * that comes later is cancelled. `willDownload` is the session's
 * will-download listener: it takes only the item whose URL `start` asked
 * for in the same contents, leaving every other download to Electron's
 * default, and saves it at once into the Downloads folder under a unique
 * name. It declines an item that is not a ZIP file of a positive size up
 * to `maxBytes`, which is how the route's refusals arrive. An interrupted item is cancelled, since Chromium would keep
 * it waiting to resume, and so is one without progress for `stallMs`; a
 * download that did not complete whole leaves no file, or answers the file
 * it could not remove. Every download answers, whatever its cleanup does, so
 * the next one is never refused as busy.
 */
export function createExportDownloads(options: Options) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const stallMs = options.stallMs ?? 120_000
  const maxBytes = options.maxBytes ?? EXPORT_MAX_BYTES
  let running: {
    url: string
    contents: DownloadContents
    taken: boolean
    answer: (value: ExportDownloadAnswer) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  const late = new Set<string>()

  const end = (value: ExportDownloadAnswer) => {
    const current = running
    if (current === null) return
    clearTimeout(current.timer)
    running = null
    current.answer(value)
  }

  function start(contents: DownloadContents, url: string): Promise<ExportDownloadAnswer> {
    if (running !== null) return Promise.resolve({ state: 'busy' })
    return new Promise((answer) => {
      const timer = setTimeout(() => {
        if (running?.taken === false) {
          late.add(url)
          end({ state: 'failed' })
        }
      }, timeoutMs)
      running = { url, contents, taken: false, answer, timer }
      try {
        contents.downloadURL(url)
      } catch {
        end({ state: 'failed' })
      }
    })
  }

  function willDownload(_event: unknown, item: DownloadItemLike, contents: unknown): void {
    const url = item.getURL()
    if (late.delete(url)) {
      item.cancel()
      return
    }
    const current = running
    if (current === null || current.taken || url !== current.url || contents !== current.contents)
      return
    current.taken = true
    clearTimeout(current.timer)
    const total = item.getTotalBytes()
    if (item.getMimeType() !== 'application/zip' || !(total > 0) || total > maxBytes) {
      // the route's 429 and 404 have no body and no ZIP type, so no archive
      // came, which the page tells apart from a broken transfer
      item.cancel()
      end({ state: 'declined' })
      return
    }
    let file: string
    try {
      file = savePathIn(options.downloadsDir(), item.getFilename(), options.exists)
      item.setSavePath(file)
    } catch {
      // the Downloads folder could not be read; nothing was written yet
      item.cancel()
      end({ state: 'failed' })
      return
    }
    let stopped: 'interrupted' | null = null
    const stall = () => {
      clearTimeout(current.timer)
      current.timer = setTimeout(() => {
        stopped = 'interrupted'
        item.cancel()
      }, stallMs)
    }
    stall()
    item.on('updated', (_updated, state) => {
      if (state === 'interrupted') {
        // Chromium keeps an interrupted item to resume it, which would hold
        // the page's save open for good
        stopped = 'interrupted'
        item.cancel()
        return
      }
      stall()
    })
    item.once('done', (_done, state) => {
      const bytes = item.getReceivedBytes()
      if (state === 'completed' && stopped === null && bytes === total) {
        end({ state: 'completed', file: path.basename(file), bytes })
        return
      }
      let answer: ExportDownloadAnswer = {
        state: stopped ?? (state === 'completed' ? 'interrupted' : state),
      }
      try {
        options.remove(file)
      } catch {
        // a file another program holds open, or one in a folder whose
        // permission changed, stays for the person to delete, since it
        // holds part of an archive
        answer = { state: 'failed', leftover: path.basename(file) }
      } finally {
        end(answer)
      }
    })
  }

  return { start, willDownload }
}

/**
 * The answer of the shell's `qivo:org-export:download` handler (main.ts):
 * `refused` unless the call came from the app's own top-level page
 * (`authorized`, main.ts isAuthorizedRenderer), the value is a URL
 * exportDownloadURL accepts from the build's export `origin` and the main
 * window's contents exist; else the download's own answer. The page never
 * chooses where the file goes, and on `refused` takes the link way instead
 * (src/lib/orgExport.ts).
 */
export async function answerExportDownload(call: {
  authorized: boolean
  raw: unknown
  packaged: boolean
  origin: string | null
  contents: () => DownloadContents | null
  downloads: Pick<ReturnType<typeof createExportDownloads>, 'start'>
}): Promise<ExportDownloadAnswer> {
  if (!call.authorized || typeof call.raw !== 'string') return { state: 'refused' }
  const url = exportDownloadURL(call.raw, call.packaged, call.origin)
  const contents = call.contents()
  if (url === null || contents === null) return { state: 'refused' }
  return await call.downloads.start(contents, url.href)
}
