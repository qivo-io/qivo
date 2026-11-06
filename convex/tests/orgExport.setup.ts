/* Helpers shared by the organization export job's suites
 * (orgExportJob.test.ts, orgExportDeleted.test.ts,
 * orgExportDelivery.test.ts): running a job to the end or a step at a
 * time, reading its rows and parts, and unzipping its archive with a ZIP
 * builder of the tests' own, the independent reference for the one the
 * /exports/ route streams (lib/orgExport.ts).
 *
 * Two dots in the basename keep the Convex CLI from deploying this module,
 * the same rule as helpers.setup.ts. */
/// <reference types="vite/client" />

import { inflateSync, unzipSync } from 'fflate/browser'
import { expect, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { crc32 } from '../lib/crc32'
import type { OrgExportRow } from '../lib/orgExport'
import { as, type T } from './helpers.setup'

/** The fake clock's start in the export suites. */
export const START = Date.parse('2026-05-04T10:00:00.000Z')

/** Runs every scheduled step, erase leg and expiry that is due now, until
 * none is left that is due. Later timers, such as an archive's expiry,
 * wait. */
export const settle = (t: T) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0), 5000)

/** Export job `id`'s row, or null. */
export const jobOf = (t: T, id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('org_exports')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

/** Runs the export step that is due now, and none that it schedules. */
export async function nextStep(t: T) {
  vi.advanceTimersByTime(0)
  await t.finishInProgressScheduledFunctions()
}

/** Runs export job `exportId`'s steps one at a time until it reads section
 * `section` (an index into lib/orgExport.ts JOB_ORDER) or ends, and
 * answers its row then. */
export async function exportUntil(t: T, exportId: string, section: number) {
  for (let guard = 0; guard < 500; guard++) {
    const job = await jobOf(t, exportId)
    if (job?.state !== 'collecting' || job.step.section >= section) return job
    await nextStep(t)
  }
  throw new Error(`the export did not reach section ${section}`)
}

/** Export job `id`'s parts in archive order. */
export const partsOf = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('org_export_parts')
      .withIndex('by_export_seq', (q) => q.eq('export_id', id))
      .collect(),
  )

/** Export job `id`'s request rows. */
export const requestsOf = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('org_export_requests')
      .withIndex('by_export_profile', (q) => q.eq('export_id', id))
      .collect(),
  )

/** How many files storage holds. */
export const storedFiles = (t: T) =>
  t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)

/** Whether stored file `id` is still there. */
export const exists = (t: T, id: Id<'_storage'>) =>
  t.run(async (ctx) => (await ctx.db.system.get(id)) !== null)

/** Asks for an export as `profile` and runs the job until nothing due is
 * left. */
export async function exportAs(t: T, profile: Doc<'profiles'>, orgId: string) {
  const asked = await as(t, profile).mutation(api.orgExport.request, { org_id: orgId })
  await settle(t)
  return asked.export_id
}

/* `iso` as a ZIP record's DOS date and time, in UTC: the day as
 * (year - 1980) << 9 | month << 5 | day and the time as
 * hours << 11 | minutes << 5 | seconds / 2. */
function dos(iso: string): { time: number; date: number } {
  const [day, clock] = iso.split('T')
  const [year, month, date] = day.split('-').map(Number)
  const [hours, minutes, seconds] = clock.slice(0, 8).split(':').map(Number)
  return {
    date: ((year - 1980) << 9) | (month << 5) | date,
    time: (hours << 11) | (minutes << 5) | Math.floor(seconds / 2),
  }
}

/** A ZIP archive of `parts` in archive order, each with its stored file:
 * a local header and the file for each, then the central directory and
 * its end record, every entry dated `completedAt` (1 January 1980 when
 * absent). The route must stream exactly these bytes. */
export function zipOf(
  parts: readonly Doc<'org_export_parts'>[],
  files: readonly Uint8Array[],
  completedAt = '1980-01-01T00:00:00.000Z',
) {
  const encoder = new TextEncoder()
  const when = dos(completedAt)
  const chunks: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const [i, part] of parts.entries()) {
    const name = encoder.encode(part.entry)
    const data = files[i]
    const local = new DataView(new ArrayBuffer(30))
    const central = new DataView(new ArrayBuffer(46))
    local.setUint32(0, 0x04034b50, true)
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 20, true)
    // version needed, UTF-8 names, deflate, the date, CRC and sizes, at
    // the same offsets past each record's own first field
    for (const [view, at] of [
      [local, 4],
      [central, 6],
    ] as const) {
      view.setUint16(at, 20, true)
      view.setUint16(at + 2, 0x0800, true)
      view.setUint16(at + 4, 8, true)
      view.setUint16(at + 6, when.time, true)
      view.setUint16(at + 8, when.date, true)
      view.setUint32(at + 10, part.crc32, true)
      view.setUint32(at + 14, data.length, true)
      view.setUint32(at + 18, part.raw_bytes, true)
      view.setUint16(at + 22, name.length, true)
    }
    central.setUint32(42, offset, true)
    chunks.push(new Uint8Array(local.buffer), name, data)
    directory.push(new Uint8Array(central.buffer), name)
    offset += 30 + name.length + data.length
  }
  const size = directory.reduce((sum, chunk) => sum + chunk.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, parts.length, true)
  end.setUint16(10, parts.length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  const all = [...chunks, ...directory, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of all) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** The stored files of `parts`, in their order. */
export async function filesOf(t: T, parts: readonly Doc<'org_export_parts'>[]) {
  // t.run answers Convex values, so the bytes come back as ArrayBuffers
  const buffers = await t.run(async (ctx) => {
    const out: ArrayBuffer[] = []
    for (const part of parts) {
      const blob = await ctx.storage.get(part.storage_id)
      if (blob === null) throw new Error(`the file of ${part.entry} is gone`)
      out.push(await blob.arrayBuffer())
    }
    return out
  })
  return buffers.map((buffer) => new Uint8Array(buffer))
}

/** The manifest of a format 4 archive as the tests read it. */
export type ArchiveManifest = {
  version: number
  consistency: string
  consistency_note: string
  file_contents_included: boolean
  collection_started_at: string
  collection_completed_at: string
  organization: { id: string; name?: string; slug?: string }
  tables: Record<string, { files: string[]; records: number }>
  skipped: { tasks: number; reason: string }
  exclusions: string[]
  deleted_items?: {
    tables: Record<string, { files: string[]; records: number }>
    items: { complete: number; partial: number }
    left_out: Record<string, number>
    note: string
  }
}

/** A ready job's archive: its parts, each inflated and checked against its
 * CRC and sizes, the ZIP they make and its entries, and each table's rows
 * joined from its files, keyed by folder and name: a live table by its
 * name (`tasks`), a Deleted items table by its path (`deleted/tasks`). */
export async function archiveOf(t: T, exportId: string) {
  const parts = await partsOf(t, exportId)
  const files = await filesOf(t, parts)
  const decoder = new TextDecoder()
  const texts: Record<string, string> = {}
  for (const [i, part] of parts.entries()) {
    expect(files[i].length, part.entry).toBe(part.stored_bytes)
    // each part is one complete raw DEFLATE stream of its own
    const raw = inflateSync(files[i])
    expect(raw.length, part.entry).toBe(part.raw_bytes)
    expect(crc32(raw), part.entry).toBe(part.crc32)
    texts[part.entry] = decoder.decode(raw)
  }
  const zip = zipOf(parts, files)
  const entries = unzipSync(zip)
  expect(Object.keys(entries)).toEqual(parts.map((part) => part.entry))
  for (const part of parts) expect(decoder.decode(entries[part.entry])).toBe(texts[part.entry])
  const tables: Record<string, OrgExportRow[]> = {}
  for (const part of parts) {
    if (part.kind !== 'data') continue
    const rows = JSON.parse(texts[part.entry]) as OrgExportRow[]
    expect(rows, part.entry).toHaveLength(part.records)
    const [folder, name] = part.entry.split('/')
    const key = folder === 'data' ? name : `${folder}/${name}`
    tables[key] = [...(tables[key] ?? []), ...rows]
  }
  return {
    parts,
    files,
    zip,
    tables,
    readme: texts['README.txt'],
    manifest: JSON.parse(texts['manifest.json']) as ArchiveManifest,
  }
}
