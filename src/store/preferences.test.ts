import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreferences, type PreferencesRow } from './preferences'

describe('preference persistence lifecycle', () => {
  let profileId: string
  let storage: Map<string, string>
  let read: ReturnType<typeof vi.fn<() => Promise<PreferencesRow | null>>>
  let write: ReturnType<typeof vi.fn<() => Promise<unknown>>>
  let blockers: Set<symbol>
  let preferences: ReturnType<typeof createPreferences>
  const saved = (prefs: PreferencesRow['prefs'], id = 'person-a'): PreferencesRow => ({
    profile_id: id,
    prefs,
    updated_at: '2026-10-01T12:00:00.000Z',
  })
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    profileId = 'person-a'
    storage = new Map()
    blockers = new Set()
    read = vi.fn<() => Promise<PreferencesRow | null>>().mockResolvedValue(null)
    write = vi.fn<() => Promise<unknown>>().mockResolvedValue(null)
    preferences = createPreferences({
      profileId: () => profileId,
      read,
      write,
      storage: () => ({
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      }),
      beginUpdate: () => {
        const token = Symbol()
        blockers.add(token)
        return () => {
          blockers.delete(token)
        }
      },
    })
  })

  afterEach(() => {
    preferences.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('merges the server copy over a private warm cache and removes the old shared cache', async () => {
    storage.set('planner.ui.v1', JSON.stringify({ scope: 'someone-else' }))
    storage.set('planner.ui.v1:person-a', JSON.stringify({ scope: 'local', view: 'kanban' }))
    read.mockResolvedValue(saved({ scope: 'server' }))
    preferences.adopt(await preferences.beginBoot())
    expect(preferences.load()).toEqual({ scope: 'server', view: 'kanban' })
    expect(storage.has('planner.ui.v1')).toBe(false)
  })

  it('coalesces pans and keeps reload blocked until the write settles', async () => {
    let finish!: () => void
    write.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    preferences.save({ scope: 'one' })
    vi.advanceTimersByTime(400)
    preferences.save({ scope: 'two' })
    expect(blockers.size).toBe(1)
    vi.advanceTimersByTime(599)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledExactlyOnceWith('person-a', { scope: 'two' })
    expect(blockers.size).toBe(1)
    finish()
    await settle()
    expect(blockers.size).toBe(0)
  })

  it('flushes decisions immediately and rejects boot results predating even a completed edit', async () => {
    let deliver!: (row: PreferencesRow) => void
    read.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    const boot = preferences.beginBoot()
    preferences.saveNow({ view: 'roadmap' })
    expect(write).toHaveBeenCalledExactlyOnceWith('person-a', { view: 'roadmap' })
    await settle()
    deliver(saved({ view: 'kanban' }))
    preferences.adopt(await boot)
    expect(preferences.load().view).toBe('roadmap')
    vi.advanceTimersByTime(600)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('keeps overlapping write blockers independent', async () => {
    const finish: (() => void)[] = []
    write.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish.push(resolve)
        }),
    )
    preferences.saveNow({ scope: 'one' })
    preferences.save({ scope: 'two' })
    expect(blockers.size).toBe(2)
    finish[0]()
    await settle()
    expect(blockers.size).toBe(1)
    vi.advanceTimersByTime(600)
    finish[1]()
    await settle()
    expect(blockers.size).toBe(0)
  })

  it('never copies another profile preferences into a new account', async () => {
    read.mockResolvedValue(saved({ scope: 'private-project' }))
    preferences.adopt(await preferences.beginBoot())
    preferences.save({ view: 'roadmap' })
    profileId = 'person-b'
    expect(preferences.load()).toEqual({})
    vi.advanceTimersByTime(600)
    expect(write).not.toHaveBeenCalled()
    expect(blockers.size).toBe(0)
    preferences.saveNow({ view: 'kanban' })
    expect(write).toHaveBeenCalledExactlyOnceWith('person-b', { view: 'kanban' })
    await settle()
  })

  it('disposes pending saves and rejects an old boot without clearing other accounts', async () => {
    read.mockResolvedValue(saved({ view: 'roadmap' }))
    const boot = await preferences.beginBoot()
    storage.set('planner.ui.v1:person-b', '{}')
    preferences.save({ view: 'kanban' })
    preferences.dispose(['person-a'])
    preferences.adopt(boot)
    vi.advanceTimersByTime(600)
    expect(preferences.load()).toEqual({})
    expect(blockers.size).toBe(0)
    expect(write).not.toHaveBeenCalled()
    expect(storage.has('planner.ui.v1:person-b')).toBe(true)
  })

  it('retains local preferences through read/write failures and malformed browser values', async () => {
    for (const invalid of ['broken json', '4', '[]', 'null']) {
      storage.set('planner.ui.v1:person-a', invalid)
      expect(preferences.load()).toEqual({})
    }
    read.mockRejectedValue(new Error('Offline'))
    write.mockRejectedValue(new Error('Offline'))
    preferences.adopt(await preferences.beginBoot())
    preferences.saveNow({ view: 'kanban' })
    await settle()
    expect(preferences.load()).toEqual({ view: 'kanban' })
    expect(blockers.size).toBe(0)
    expect(console.warn).toHaveBeenCalledTimes(2)
  })
})
