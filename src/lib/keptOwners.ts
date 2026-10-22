/** Which items keep the block or chunk they had: the longest run, in list
    order, of owners that never decrease. Owner ids rise down the list, so
    an item a reorder moved across owners breaks that order and only it
    changes owner; the items around it keep theirs. New items (no owner)
    keep none. */
export function keptOwners(owners: (number | undefined)[]) {
  // patience sorting for the longest non-decreasing subsequence
  const tails: number[] = []
  const tailAt: number[] = []
  const before = Array.from({ length: owners.length }, () => -1)
  for (const [i, owner] of owners.entries()) {
    if (owner === undefined) continue
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (tails[mid] <= owner) low = mid + 1
      else high = mid
    }
    tails[low] = owner
    tailAt[low] = i
    before[i] = low > 0 ? tailAt[low - 1] : -1
  }
  const kept = Array.from({ length: owners.length }, () => false)
  for (let i = tails.length ? tailAt[tails.length - 1] : -1; i >= 0; i = before[i]) kept[i] = true
  return kept
}
