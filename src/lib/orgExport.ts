import { strToU8, Zip, ZipPassThrough } from 'fflate'
import {
  ORG_EXPORT_SECTIONS,
  type OrgExportPage,
  type OrgExportRow,
  type OrgExportSection,
} from '../../convex/lib/orgExport'
import { browserBackendUrl } from './backendUrl'

export type OrgExportOptions = {
  orgId: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

type PageArgs = {
  org_id: string
  section: OrgExportSection
  parent_id?: string
  cursor: string | null
}

/** Injectable IO keeps the archive format testable without opening a Convex connection. */
export type OrgExportDependencies = {
  page: (args: PageArgs) => Promise<OrgExportPage>
  mintUrls: (args: {
    org_id: string
    attachment_ids?: string[]
    profile_ids?: string[]
  }) => Promise<{
    attachments: Record<string, { url: string; exp: number }>
    avatars: Record<string, { url: string; exp: number }>
  }>
  fetch: typeof fetch
  now?: () => Date
}

type PendingFile = {
  kind: 'attachment' | 'avatar'
  id: string
  storage_id: string
  original_name: string
  mime?: string
  size_bytes?: number
}

const EXCLUSIONS = [
  'Private inbox messages (messages)',
  'Personal task subscriptions (task_subscriptions)',
  'Personal preferences (user_prefs)',
  'Personal appearance and backgrounds (account_appearance, custom_backgrounds, background_uploads)',
  'Personal MCP tokens (mcp_tokens)',
  'Authentication accounts, sessions, login identifiers, and credentials',
  'Agent key secrets and hashes (agent key metadata is included)',
  'Platform administration, audit logs, demo receipts, and shared panorama library data',
  'External images linked in descriptions and Gravatar images (uploaded files are included)',
]

const README = `Qivo organization export — format version 2

manifest.json identifies the organization, export times, table counts, exclusions,
and the archive path of each uploaded file. data/<table>.json contains JSON arrays
with snake_case fields. Empty tables are included. Task records are in tasks;
their related tables are task_links, task_labels, and task_attachments.

Application id fields are UUIDs. References such as org_id, project_id, task_id,
profile_id, and label_id refer to these application IDs in the corresponding
tables. QN task numbers are organization-scoped; a task's num gives QN-<num>.
The organization's next_task_num is its task-number counter. Task activity events
use target_type "task" and target_id references the task's UUID.
Description and comment content can contain att:<attachment UUID> image references;
resolve these using task_attachments and the attachment entries in the manifest.
Files are stored under files/attachments/ and files/avatars/. The manifest retains
original attachment names and maps storage_id / avatar_storage_id to archive files.
Archive paths use safe names. No temporary download URLs are needed to open files.

Dates ending in _at, and activity ts values, are ISO-8601 UTC timestamps. Week/date
fields are YYYY-MM-DD strings. Optional fields can be absent. Internal Convex
document IDs and creation timestamps are omitted. Join tables may not have an id.
Agent key metadata is included; secrets and hashes are excluded. The manifest lists
personal, authentication, and platform data outside this organization export.

This is a sequence of live reads, not an atomic snapshot. Changes made during the
export can appear across different pages or files, and references can reflect
those changes. Start and completion times describe the collection window. The
archive is created only after every requested page and uploaded file succeeds and
organization administrator access has been checked again. If the export fails,
retry when changes have settled. The finished archive is held in browser memory.

This archive is intended for data portability and inspection. Qivo does not
currently provide an import or restore operation for this format.
`

// The archive is a public data interface; keep storage names behind this boundary.
const EXPORT_NAMES: Partial<Record<OrgExportSection, string>> = {
  issues: 'tasks',
  issue_links: 'task_links',
  issue_labels: 'task_labels',
  issue_attachments: 'task_attachments',
}

function archiveRow(row: OrgExportRow): OrgExportRow {
  return Object.fromEntries(
    Object.entries(row).map(([field, value]) => {
      if (field === 'issue_id') return ['task_id', value]
      if (field === 'next_issue_num') return ['next_task_num', value]
      if (field === 'target_type' && value === 'issue') return [field, 'task']
      return [field, value]
    }),
  )
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
}

/** Convex queries cannot be cancelled in flight; stop waiting and ignore their result. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException('Export cancelled', 'AbortError'))
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
    if (signal.aborted) cancel()
  })
}

// Encode IDs injectively, including dots, so even unexpected IDs cannot traverse
// directories or collide after replacing punctuation. A literal '%' is encoded.
function pathId(id: string): string {
  return encodeURIComponent(id).replace(
    /[.!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function safeName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? ''
  const cleaned = Array.from(leaf)
    .map((c) => (c.charCodeAt(0) < 32 || /[<>:"|?*]/.test(c) ? '_' : c))
    .join('')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120)
  // Windows reserves these basenames even when an extension follows.
  return !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
    ? `file${cleaned ? `-${cleaned}` : ''}`
    : cleaned
}

function avatarExtension(mime: string): string {
  return (
    { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] ??
    'bin'
  )
}

async function browserDependencies(): Promise<OrgExportDependencies> {
  const [{ convex }, { api }] = await Promise.all([
    import('./convex'),
    import('../../convex/_generated/api'),
  ])
  return {
    page: (args) => convex.query(api.orgExport.page, args),
    mintUrls: (args) => convex.query(api.files.mintUrls, args),
    fetch: (input, init) => fetch(input, init),
  }
}

/** Collect one organization into a portable archive; downloading is the UI's job. */
export async function exportOrganization(
  { orgId, signal, onProgress }: OrgExportOptions,
  dependencies?: OrgExportDependencies,
): Promise<{ blob: Blob; filename: string }> {
  checkAbort(signal)
  const io = dependencies ?? (await abortable(browserDependencies(), signal))
  const now = io.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const chunks: ArrayBuffer[] = []
  let archiveBytes = 0
  let archiveEntries = 0
  let archiveError: Error | undefined
  let finished = false
  const zip = new Zip((error, bytes, final) => {
    if (error) {
      archiveError = error
      return
    }
    archiveBytes += bytes.byteLength
    // fflate writes ZIP32. Refuse overflow instead of returning a corrupt ZIP.
    if (archiveBytes >= 0xffffffff) {
      archiveError = new Error('This export exceeds the ZIP archive size limit (4 GiB).')
      return
    }
    chunks.push(bytes.slice().buffer)
    if (final) finished = true
  })
  const check = () => {
    checkAbort(signal)
    if (archiveError) throw archiveError
  }
  const addEntry = (path: string) => {
    check()
    if (++archiveEntries >= 0xffff) {
      throw new Error('This export exceeds the ZIP archive limit (65,534 files).')
    }
    const entry = new ZipPassThrough(path)
    zip.add(entry)
    return entry
  }
  const addText = (path: string, value: string) => {
    addEntry(path).push(strToU8(value), true)
    check()
  }
  const pendingFiles: PendingFile[] = []
  const files: Array<PendingFile & { path: string; size_bytes: number }> = []
  const parentIds = new Map<OrgExportSection, string[]>()
  const parentSections = new Set(Object.values(ORG_EXPORT_SECTIONS).filter(Boolean))
  const tables: Record<string, { path: string; count: number }> = {}
  let organization: { id: string; name?: string; slug?: string } = { id: orgId }

  try {
    for (const section of Object.keys(ORG_EXPORT_SECTIONS) as OrgExportSection[]) {
      check()
      const name = EXPORT_NAMES[section] ?? section
      const path = `data/${name}.json`
      const entry = addEntry(path)
      entry.push(strToU8('[\n'))
      let count = 0
      const parentSection = ORG_EXPORT_SECTIONS[section]
      const parents: Array<string | undefined> = parentSection
        ? (parentIds.get(parentSection) ?? [])
        : [undefined]
      if (parentSections.has(section)) parentIds.set(section, [])
      const readPage = (parentId: string | undefined, cursor: string | null) =>
        abortable(
          io.page({
            org_id: orgId,
            section,
            ...(parentId === undefined ? {} : { parent_id: parentId }),
            cursor,
          }),
          signal,
        )
      // Parent lookups dominate large exports. Prefetch only four first pages,
      // wait for every result, then write parents in their original order. No
      // outstanding writer can append to an archive after a failed batch.
      for (let start = 0; start < parents.length; start += 4) {
        check()
        onProgress?.(`Collecting ${name.replaceAll('_', ' ')}, ${count} records`)
        const batch = parents.slice(start, start + 4)
        const results = await Promise.allSettled(
          batch.map(async (parentId) => readPage(parentId, null)),
        )
        check()
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (failures.length) throw failures[0]
        const firstPages = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        )
        for (const [index, parentId] of batch.entries()) {
          let cursor: string | null = null
          const cursors = new Set<string>()
          do {
            check()
            onProgress?.(`Collecting ${name.replaceAll('_', ' ')}, ${count} records`)
            const page = cursor === null ? firstPages[index] : await readPage(parentId, cursor)
            check()
            for (const row of page.rows) {
              entry.push(strToU8(`${count ? ',\n' : ''}${JSON.stringify(archiveRow(row))}`))
              count++
              const id = typeof row.id === 'string' ? row.id : undefined
              if (parentSections.has(section)) {
                if (!id) throw new Error(`Missing record ID in ${name}; export could not finish.`)
                parentIds.get(section)?.push(id)
              }
              if (section === 'organizations') {
                if (id !== orgId) throw new Error('The export returned a different organization.')
                organization = {
                  id,
                  ...(typeof row.name === 'string' ? { name: row.name } : {}),
                  ...(typeof row.slug === 'string' ? { slug: row.slug } : {}),
                }
              }
              queueFiles(section, row, pendingFiles)
            }
            check()
            if (page.isDone) break
            if (!page.continueCursor || cursors.has(page.continueCursor)) {
              throw new Error(`Pagination stalled in ${name}; retry the export.`)
            }
            cursors.add(page.continueCursor)
            cursor = page.continueCursor
          } while (cursor !== null)
        }
      }
      entry.push(strToU8('\n]\n'), true)
      tables[name] = { path, count }
      if (section === 'organizations' && count !== 1) {
        throw new Error('The organization could not be read; retry the export.')
      }
    }

    for (const file of pendingFiles) {
      check()
      onProgress?.(`Downloading files, ${files.length + 1} of ${pendingFiles.length}`)
      try {
        const minted = await abortable(
          io.mintUrls({
            org_id: orgId,
            ...(file.kind === 'attachment'
              ? { attachment_ids: [file.id] }
              : { profile_ids: [file.id] }),
          }),
          signal,
        )
        check()
        const url = (file.kind === 'attachment' ? minted.attachments : minted.avatars)[file.id]?.url
        if (!url) throw new Error('The uploaded file is no longer available.')
        if (file.kind === 'avatar' && new URL(url).searchParams.get('v') !== file.storage_id) {
          throw new Error('The avatar changed during the export.')
        }
        const response = await abortable(
          io.fetch(browserBackendUrl(url), { signal }).then((result) => {
            // Also release a body delivered just as cancellation wins the race.
            if (signal?.aborted) void result.body?.cancel().catch(() => {})
            return result
          }),
          signal,
        )
        check()
        if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`)
        const responseMime = response.headers.get('content-type')?.split(';')[0]?.trim()
        // The gateway serves non-image attachments as octet-stream for safe
        // downloads. Preserve their stored MIME rather than that transport MIME.
        const mime = file.kind === 'attachment' ? file.mime || responseMime : responseMime
        const path =
          file.kind === 'attachment'
            ? `files/attachments/${pathId(file.id)}/${safeName(file.original_name)}`
            : `files/avatars/${pathId(file.id)}/avatar.${avatarExtension(mime ?? '')}`
        const entry = addEntry(path)
        let size = 0
        const push = (bytes: Uint8Array) => {
          check()
          size += bytes.byteLength
          entry.push(bytes)
          check()
        }
        if (response.body) {
          const reader = response.body.getReader()
          try {
            while (true) {
              const chunk = await abortable(reader.read(), signal)
              check()
              if (chunk.done) break
              push(chunk.value)
            }
          } catch (error) {
            void reader.cancel().catch(() => {})
            throw error
          } finally {
            reader.releaseLock()
          }
        } else {
          push(new Uint8Array(await abortable(response.arrayBuffer(), signal)))
        }
        if (file.size_bytes !== undefined && size !== file.size_bytes) {
          throw new Error('The downloaded file size did not match its stored size.')
        }
        entry.push(new Uint8Array(), true)
        files.push({ ...file, ...(mime ? { mime } : {}), path, size_bytes: size })
      } catch (error) {
        check()
        const detail = error instanceof Error ? error.message : 'The file could not be read.'
        throw new Error(
          `Could not export ${file.kind} "${file.original_name}": ${detail} Retry the export.`,
        )
      }
    }

    onProgress?.('Finishing export…')
    // A long file download must not outlive revoked administrator access.
    const access = await abortable(
      io.page({ org_id: orgId, section: 'organizations', cursor: null }),
      signal,
    )
    check()
    if (access.rows.length !== 1 || access.rows[0].id !== orgId) {
      throw new Error('Organization access changed; export could not finish.')
    }
    const completedAt = now().toISOString()
    addText('README.txt', README)
    addText(
      'manifest.json',
      `${JSON.stringify(
        {
          format: 'qivo-organization-export',
          version: 2,
          organization,
          started_at: startedAt,
          completed_at: completedAt,
          consistency: 'live_read',
          tables,
          files,
          exclusions: EXCLUSIONS,
        },
        null,
        2,
      )}\n`,
    )
    zip.end()
    check()
    if (!finished) throw new Error('The ZIP archive could not be completed.')
    return {
      blob: new Blob(chunks, { type: 'application/zip' }),
      filename: `qivo-${safeName(organization.slug || orgId)}-${startedAt.slice(0, 10)}.zip`,
    }
  } catch (error) {
    zip.terminate()
    chunks.length = 0
    throw error
  }
}

function queueFiles(section: OrgExportSection, row: OrgExportRow, files: PendingFile[]) {
  const id = typeof row.id === 'string' ? row.id : undefined
  if (section === 'issue_attachments') {
    if (!id || typeof row.storage_id !== 'string' || typeof row.name !== 'string') {
      throw new Error('An attachment has incomplete metadata; export could not finish.')
    }
    files.push({
      kind: 'attachment',
      id,
      storage_id: row.storage_id,
      original_name: row.name,
      ...(typeof row.mime === 'string' ? { mime: row.mime } : {}),
      ...(typeof row.size_bytes === 'number' ? { size_bytes: row.size_bytes } : {}),
    })
  } else if (section === 'profiles' && typeof row.avatar_storage_id === 'string') {
    if (!id) throw new Error('An avatar has incomplete metadata; export could not finish.')
    files.push({
      kind: 'avatar',
      id,
      storage_id: row.avatar_storage_id,
      original_name: 'avatar',
    })
  }
}
