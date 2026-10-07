/** Cache lookups for each derived array's lifetime without retaining disposed snapshots. */
export function createEntityLookup<T extends { id: string }>() {
  const indexes = new WeakMap<readonly T[], Map<string, T>>()
  return (items: readonly T[], id: string | null | undefined): T | undefined => {
    let index = indexes.get(items)
    if (!index) {
      index = new Map()
      for (const item of items) {
        if (!index.has(item.id)) index.set(item.id, item)
      }
      indexes.set(items, index)
    }
    return id == null ? undefined : index.get(id)
  }
}
