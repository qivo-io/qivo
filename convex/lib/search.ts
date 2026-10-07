/* One search rule for the planner, pickers, operator console and machine
 * surfaces: every whitespace-separated fragment must occur, in any order.
 * REST also keeps its existing explicit `*` wildcard within a fragment. */
export function allWordsMatcher(query: string, stars = false): (hay: string) => boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const fragments = words.map((word) => (stars ? word.split('*') : [word]))
  return (hay) => {
    const h = hay.toLowerCase()
    return fragments.every((parts) => {
      let from = 0
      return parts.every((part) => {
        const index = h.indexOf(part, from)
        if (index < 0) return false
        from = index + part.length
        return true
      })
    })
  }
}

export function matchesAllWords(hay: string, query: string): boolean {
  return allWordsMatcher(query)(hay)
}
