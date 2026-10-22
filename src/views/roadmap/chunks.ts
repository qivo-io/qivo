/* The desktop Roadmap renders a track's task rows in chunks (RowChunk in
   Roadmap.tsx), which a delivery skips unless one of their rows changed. */
import { keptOwners } from '@/lib/keptOwners'
import type { Row } from './TimelineRow'

/** A rail row as laid out: the row, its offset and height, and its bar's
    start and end weeks with any live drag draft. */
export type LaidRow = {
  row: Row & { subIds?: string[]; parentPid?: string }
  top: number
  h: number
  start: number | null
  end: number | null
  /** whether the task is stale now (P.isStale), which follows the clock */
  stale: boolean
}

/* The most rows one chunk holds. */
const CHUNK_ROWS = 32
const rowKey = (L: LaidRow) => `${L.row.kind}:${L.row.issue?.uuid ?? L.row.pid}`

/** What stableChunks keeps of a track between renders: each row's chunk,
    each chunk's place in the track, and the next new chunk's key. */
export type ChunkMemory = { owners: Map<string, number>; places: Map<number, number>; next: number }

/** A track's rows in chunks that keep their rows: a row stays in the chunk
    that held it while the order allows (keptOwners on the chunks' last
    places), so a row that only shifts as others come and go is not
    remounted with its open menus and focus. A new or moved row joins the
    chunk before it, or a new chunk, as no chunk takes more than CHUNK_ROWS
    rows. A chunk's key stays the same while it lives; `memory` is updated. */
export function stableChunks(rows: LaidRow[], memory: ChunkMemory) {
  const keys = rows.map(rowKey)
  const owners = keys.map((key) => memory.owners.get(key))
  const kept = keptOwners(
    owners.map((owner) => (owner === undefined ? undefined : memory.places.get(owner))),
  )
  const chunks: { key: number; rows: LaidRow[] }[] = []
  const used = new Set<number>()
  let current: (typeof chunks)[number] | null = null
  for (const [i, row] of rows.entries()) {
    const owner = kept[i] ? owners[i] : undefined
    if (owner !== undefined && current?.key !== owner && !used.has(owner)) {
      current = { key: owner, rows: [] }
      chunks.push(current)
      used.add(owner)
    } else if (!current || current.rows.length >= CHUNK_ROWS) {
      // a full chunk, even the row's own when rows were inserted into it,
      // is followed by a new one
      current = { key: memory.next++, rows: [] }
      chunks.push(current)
      used.add(current.key)
    }
    current.rows.push(row)
  }
  memory.owners.clear()
  memory.places.clear()
  for (const [place, chunk] of chunks.entries()) {
    memory.places.set(chunk.key, place)
    for (const row of chunk.rows) memory.owners.set(rowKey(row), chunk.key)
  }
  return chunks
}
