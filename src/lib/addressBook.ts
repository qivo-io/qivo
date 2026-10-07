/* Remember the organization uuid last opened through a slug, per login.
   Renaming releases a slug for reuse. A viewer who also gains a seat in its
   new organization could otherwise follow an old bookmark without noticing
   the change. Warn until they accept the new destination; server access rules
   still decide which organizations are visible. Local storage is best-effort
   and scoped to the login because shared browsers can resolve different seats. */

const KEY = 'qivo.addr.v1:'

type Book = Record<string, string> // slug -> organization uuid

const load = (who: string): Book => {
  try {
    const raw = localStorage.getItem(KEY + who)
    const b = raw ? JSON.parse(raw) : null
    return b && typeof b === 'object' ? (b as Book) : {}
  } catch {
    return {}
  } // storage blocked, or somebody hand-edited it
}

const save = (who: string, b: Book) => {
  try {
    localStorage.setItem(KEY + who, JSON.stringify(b))
  } catch {
    /* storage blocked */
  }
}

/** The organization this address opened last time, when that is a DIFFERENT
    one from the organization it names now — otherwise null. A first sighting
    is not a move, so it answers null too: there is nothing to warn about an
    address this login has never followed. */
export function addressMoved(who: string, slug: string, orgId: string): string | null {
  if (!who || !slug || !orgId) return null
  const prev = load(who)[slug]
  return prev && prev !== orgId ? prev : null
}

/** Record what this address opened. Called once the person has actually been
    shown the organization — including straight after they accept a move, which
    is what stops the same warning appearing on every reload. */
export function rememberAddress(who: string, slug: string, orgId: string): void {
  if (!who || !slug || !orgId) return
  const b = load(who)
  if (b[slug] === orgId) return
  b[slug] = orgId
  save(who, b)
}
