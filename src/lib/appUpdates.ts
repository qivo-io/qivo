export type AppUpdateState = {
  available: boolean
  blocked: boolean
  reloading: boolean
  automaticPaused: boolean
}

type Options = {
  buildId: string
  fetchVersion: () => Promise<unknown>
  isBlocked: () => boolean
  isVisible: () => boolean
  reload: () => void
  onChange: (state: AppUpdateState) => void
  now?: () => number
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}

export const UPDATE_QUIET_MS = 5_000
export const UPDATE_RELOAD_KEY = 'qivo:update-reload'

export function createAppUpdateMonitor(options: Options) {
  const now = options.now ?? Date.now
  let target: string | null = null
  let quietSince = now()
  let reloading = false
  let disposed = false
  let automaticPaused = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let checking: Promise<void> | undefined

  const publish = () => {
    if (!disposed)
      options.onChange({
        available: target !== null,
        blocked: options.isBlocked(),
        reloading,
        automaticPaused,
      })
  }
  const cancelTimer = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const reload = (manual: boolean) => {
    if (disposed || !target || reloading) return
    if (options.isBlocked() || !options.isVisible()) {
      publish()
      return
    }
    if (!manual && automaticPaused) return
    try {
      options.storage?.setItem(UPDATE_RELOAD_KEY, `${options.buildId}:${target}`)
    } catch {
      // Without a durable tab-local attempt marker, require an explicit click
      // rather than risk a reload loop when a proxy serves inconsistent builds.
      if (!manual) {
        automaticPaused = true
        publish()
        return
      }
    }
    cancelTimer()
    reloading = true
    publish()
    options.reload()
  }
  const reconsider = () => {
    if (disposed || reloading) return
    cancelTimer()
    publish()
    if (!target || automaticPaused || options.isBlocked() || !options.isVisible()) return
    timer = setTimeout(
      () => {
        timer = undefined
        // The decision is made against live state, never the state captured by
        // the earlier version response or React render.
        if (now() - quietSince < UPDATE_QUIET_MS) reconsider()
        else reload(false)
      },
      Math.max(0, UPDATE_QUIET_MS - (now() - quietSince)),
    )
  }
  const activity = () => {
    quietSince = now()
    reconsider()
  }
  const check = (): Promise<void> => {
    if (disposed || reloading) return Promise.resolve()
    if (checking) return checking
    checking = (async () => {
      // Normalize even a synchronous fetch adapter failure to a later turn,
      // so finally cannot clear the slot before this assignment completes.
      await Promise.resolve()
      try {
        const value = await options.fetchVersion()
        if (disposed || !value || typeof value !== 'object' || !('buildId' in value)) return
        const id = value.buildId
        if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(id)) return
        const next = id === options.buildId ? null : id
        if (target !== next) {
          target = next
          quietSince = now()
          automaticPaused = false
          if (target) {
            try {
              automaticPaused =
                options.storage?.getItem(UPDATE_RELOAD_KEY) === `${options.buildId}:${target}`
            } catch {
              automaticPaused = true
            }
          }
        }
        reconsider()
      } catch {
        // Offline, a failed deploy, HTML fallbacks and proxy errors are not
        // evidence of a new version. A later poll/focus retries normally.
      } finally {
        checking = undefined
      }
    })()
    return checking
  }
  return {
    check,
    reconsider,
    activity,
    reloadNow: () => reload(true),
    dispose: () => {
      disposed = true
      cancelTimer()
    },
  }
}
