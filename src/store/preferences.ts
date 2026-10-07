import type { RoadmapWin } from '../lib/dates'

/** Known fields in the server's opaque per-profile preference object. */
export type UIPrefs = Partial<{
  scope: string
  view: string
  focus: boolean
  metaViz: string
  roadmapWin: RoadmapWin
  roadmapWinDefault: RoadmapWin
  syncScope: string
}>

export type PreferencesRow = {
  profile_id: string
  prefs: UIPrefs
  updated_at: string
}

type Dependencies = {
  profileId: () => string
  read: () => Promise<PreferencesRow | null>
  write: (profileId: string, preferences: UIPrefs) => Promise<unknown>
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  beginUpdate: () => () => void
}
type BootRead = { epoch: number; row: PreferencesRow | null }

/** Local storage warms startup; a guarded one-shot server read wins on boot.
 * Gesture writes debounce for 600ms. Decisions flush before navigation, and
 * both pending and active writes hold the app's update/reload blocker. */
export function createPreferences(deps: Dependencies) {
  let row: PreferencesRow | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let releaseUpdate: (() => void) | undefined
  let dirty = false
  let epoch = 0
  const key = (profileId: string) => `planner.ui.v1:${profileId}`

  const load = (): UIPrefs => {
    let local: UIPrefs = {}
    try {
      // An old shared-browser blob cannot be attributed to the current account.
      deps.storage().removeItem('planner.ui.v1')
    } catch {
      // Reads may remain available when browser storage refuses a write.
    }
    try {
      const parsed: unknown = JSON.parse(deps.storage().getItem(key(deps.profileId())) || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) local = parsed
    } catch {
      // Corrupt or unavailable storage must not block the workspace.
    }
    return { ...local, ...(row?.profile_id === deps.profileId() ? row.prefs : null) }
  }

  const flush = () => {
    if (!dirty) return
    clearTimeout(timer)
    timer = undefined
    dirty = false
    const release = releaseUpdate
    releaseUpdate = undefined
    const profileId = deps.profileId()
    if (!profileId || !row || row.profile_id !== profileId) {
      release?.()
      return
    }
    try {
      void deps
        .write(profileId, row.prefs)
        .catch((error) => console.warn('[qivo] prefs save failed:', error))
        .finally(() => release?.())
    } catch (error) {
      console.warn('[qivo] prefs save failed:', error)
      release?.()
    }
  }

  const save = (patch: UIPrefs) => {
    const merged = { ...load(), ...patch }
    const profileId = deps.profileId()
    try {
      deps.storage().setItem(key(profileId), JSON.stringify(merged))
    } catch {
      // The server copy still saves if browser storage is unavailable or full.
    }
    if (profileId)
      row = { profile_id: profileId, prefs: merged, updated_at: new Date().toISOString() }
    releaseUpdate ??= deps.beginUpdate()
    dirty = true
    epoch++
    clearTimeout(timer)
    timer = setTimeout(flush, 600)
  }

  return {
    load,
    save,
    saveNow(patch: UIPrefs) {
      save(patch)
      flush()
    },
    async beginBoot(): Promise<BootRead> {
      const atBoot = epoch
      try {
        return { epoch: atBoot, row: await deps.read() }
      } catch (error) {
        console.warn('[qivo] prefs load failed:', error)
        return { epoch: atBoot, row: null }
      }
    },
    adopt(read: BootRead) {
      if (read.epoch === epoch && !dirty)
        row = read.row?.profile_id === deps.profileId() ? read.row : null
    },
    dispose(forgetProfiles: Iterable<string> = []) {
      clearTimeout(timer)
      timer = undefined
      releaseUpdate?.()
      releaseUpdate = undefined
      dirty = false
      epoch++
      row = null
      for (const profileId of forgetProfiles) {
        try {
          deps.storage().removeItem(key(profileId))
        } catch {
          // Disposal still clears memory when browser storage is unavailable.
        }
      }
    },
  }
}
