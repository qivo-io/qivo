import type { FunctionReturnType } from 'convex/server'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api } from '../convex/_generated/api'
import {
  type CanvasImageQuality,
  type CanvasImageState,
  createCanvasImageLoader,
  decodeCanvasImage,
} from './lib/appearance'
import { browserBackendUrl, configuredConvexDeploymentUrl } from './lib/backendUrl'
import {
  type BackgroundSelection,
  backgroundCacheScope,
  createBackgroundImageCache,
} from './lib/backgroundImageCache'
import { watchCanvasWeek } from './lib/canvasWeek'
import { convex } from './lib/convex'
import { watchDemoCanvas } from './lib/demoCanvas'
import { DEMO_MODE } from './lib/demoMode'
import { type AppearancePreferences, P } from './store/planner'

type DailyImage = NonNullable<FunctionReturnType<typeof api.appearance.dailyImage>>
type ImageLease = NonNullable<FunctionReturnType<typeof api.appearance.mintCustomUrl>>
type AppearanceState = {
  mode: AppearancePreferences['mode']
  /** 'none' when the account chose No image as its Canvas background. */
  backgroundStatus: 'loading' | 'ready' | 'unavailable' | 'none'
  backgroundQuality: CanvasImageQuality | null
  backgroundUrl: string | null
  dailyImage: DailyImage | null
}

const AppearanceContext = createContext<AppearanceState>({
  mode: 'blue',
  backgroundStatus: 'loading',
  backgroundQuality: null,
  backgroundUrl: null,
  dailyImage: null,
})

export const useAppearance = () => useContext(AppearanceContext)

function usePrivateImage(imageId: string | null, previewVersion: number | null) {
  const [lease, setLease] = useState<(ImageLease & { previewVersion: number | null }) | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    if (!imageId) {
      setLease(null)
      return
    }
    let active = true
    let renewing = false
    let expiresAt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // A new or regenerated derivative remints the lease for the same image;
    // keep its valid original URL painted while the new pair is resolved.
    setLease((current) => (current?.image_id === imageId ? current : null))
    const renew = async () => {
      if (!active || renewing) return
      renewing = true
      clearTimeout(timer)
      try {
        const result = await P.mintAppearanceImageUrl()
        if (!active) return
        if (!result || result.image_id !== imageId) {
          setLease(null)
          setFailed(true)
          return
        }
        expiresAt = result.expires_at
        setLease({ ...result, previewVersion })
        setFailed(false)
        timer = setTimeout(() => void renew(), Math.max(1000, expiresAt - Date.now() - 60_000))
      } catch {
        if (!active) return
        setLease(null)
        setFailed(true)
        expiresAt = 0
        timer = setTimeout(() => void renew(), 60_000)
      } finally {
        renewing = false
      }
    }
    const resume = () => {
      if (document.visibilityState === 'visible' && expiresAt < Date.now() + 60_000) void renew()
    }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('focus', resume)
    void renew()
    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('focus', resume)
    }
  }, [imageId, previewVersion])
  return {
    lease: lease?.image_id === imageId && lease.expires_at > Date.now() ? lease : null,
    failed,
  }
}

/** Mounted after socket authentication, before workspace initialization, and
 * kept mounted through loading, view, scope and settings changes. The weekly
 * image follows UTC week boundaries without reloading the planner. */
export function AppearanceProvider({
  children,
  accountId,
}: {
  children: ReactNode
  accountId?: string
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  useEffect(() => watchCanvasWeek(setDate), [])
  const [preferences, setPreferences] = useState<AppearancePreferences | null>(null)
  const [preferencesFailed, setPreferencesFailed] = useState(false)
  const [dailyImage, setDailyImage] = useState<DailyImage | null>(null)
  const [dailyLoaded, setDailyLoaded] = useState(false)
  const [background, setBackground] = useState<CanvasImageState>({
    status: 'loading',
    image: null,
    quality: null,
  })
  const cache = useMemo(
    () =>
      accountId && !DEMO_MODE
        ? createBackgroundImageCache(
            backgroundCacheScope(configuredConvexDeploymentUrl(), accountId),
            { validate: decodeCanvasImage },
          )
        : null,
    [accountId],
  )
  const [restored, setRestored] = useState<(BackgroundSelection & { url: string }) | null>(null)
  const restorationVersion = useRef(0)
  const loader = useMemo(
    () =>
      createCanvasImageLoader(async (url, image, quality) => {
        let resolved = url
        if (cache && image) {
          try {
            resolved = await cache.resolve(
              url,
              { key: image.key, previewVersion: image.previewVersion ?? null },
              quality,
            )
          } catch {
            // Storage/fetch restrictions must not prevent a normal image load.
          }
        }
        try {
          await decodeCanvasImage(resolved)
        } catch (error) {
          if (!cache || !image || resolved === url) throw error
          cache.reject({ key: image.key, previewVersion: image.previewVersion ?? null }, quality)
          // Cached corruption must not pin a broken image across reloads.
          await decodeCanvasImage(url)
          return url
        }
        return resolved
      }, setBackground),
    [cache],
  )
  useEffect(() => {
    let active = true
    const version = restorationVersion.current
    if (cache)
      void cache.restoreFull().then(async (image) => {
        if (!image || !active) return
        try {
          await decodeCanvasImage(image.url)
          if (active && restorationVersion.current === version) setRestored(image)
        } catch {
          // A damaged cached original is not a reason to block fresh delivery.
        }
      })
    return () => {
      active = false
      cache?.dispose()
    }
  }, [cache])
  const [initialMode] = useState<AppearancePreferences['mode']>(() => {
    const mode = document.documentElement.dataset.appearance
    return mode === 'dark' || mode === 'light' ? mode : 'blue'
  })
  const mode = preferences?.mode ?? initialMode
  // The theme only chooses the palette; every theme paints the Canvas image.
  const usesDaily = !preferencesFailed && preferences?.image_source === 'daily'

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    const fail = () => {
      if (active) setPreferencesFailed(true)
    }
    try {
      unsubscribe = P.watchAppearance((value) => {
        if (!active) return
        setPreferences(value)
        setPreferencesFailed(false)
      }, fail)
    } catch {
      fail()
    }
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    if (!usesDaily) {
      setDailyImage(null)
      setDailyLoaded(false)
      return
    }
    let active = true
    let unsubscribe: (() => void) | undefined
    const receive = (value: DailyImage | null) => {
      if (!active) return
      setDailyImage(
        value
          ? {
              ...value,
              image_url: value.image_url ? browserBackendUrl(value.image_url) : null,
              preview_url: value.preview_url ? browserBackendUrl(value.preview_url) : null,
            }
          : null,
      )
      setDailyLoaded(true)
    }
    try {
      unsubscribe = DEMO_MODE
        ? watchDemoCanvas(date, receive)
        : convex.onUpdate(api.appearance.dailyImage, { date }, receive, () => receive(null))
    } catch {
      receive(null)
    }
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [date, usesDaily])

  const customId =
    !preferencesFailed && preferences?.image_source === 'custom'
      ? (preferences.custom_image?.id ?? null)
      : null
  const { lease: privateImage, failed: privateFailed } = usePrivateImage(
    customId,
    preferences?.custom_image?.preview_version ?? null,
  )
  const selection = useMemo<BackgroundSelection | null | undefined>(() => {
    if (preferencesFailed) return null
    if (!preferences) return undefined
    if (preferences.image_source === 'none') return null
    if (preferences.image_source === 'custom')
      return customId && !privateFailed
        ? {
            key: `custom:${customId}`,
            previewVersion:
              preferences.custom_image.preview_version === null
                ? null
                : String(preferences.custom_image.preview_version),
          }
        : null
    if (!dailyLoaded) return undefined
    return dailyImage?.image_url
      ? {
          key: `daily:${dailyImage.id}`,
          // Library storage URLs identify immutable bytes; never persist a bearer URL.
          previewVersion: dailyImage.preview_url ? new URL(dailyImage.preview_url).pathname : null,
        }
      : null
  }, [preferences, preferencesFailed, customId, privateFailed, dailyLoaded, dailyImage])
  useEffect(() => {
    if (selection === undefined) return
    restorationVersion.current++
    setRestored((current) => (selection && current?.key === selection.key ? current : null))
    cache?.select(selection)
  }, [cache, selection])
  const candidate = useMemo(() => {
    if (!preferences || preferencesFailed || preferences.image_source === 'none') return null
    if (preferences.image_source === 'custom') {
      return privateImage
        ? {
            key: `custom:${privateImage.image_id}`,
            url: privateImage.url,
            previewUrl:
              privateImage.previewVersion === preferences.custom_image?.preview_version
                ? privateImage.preview_url
                : null,
            ...(cache && selection
              ? { fullVersion: selection.key, previewVersion: selection.previewVersion }
              : {}),
          }
        : null
    }
    return dailyImage?.image_url
      ? {
          key: `daily:${dailyImage.id}`,
          url: dailyImage.image_url,
          previewUrl: dailyImage.preview_url,
          ...(cache && selection
            ? { fullVersion: selection.key, previewVersion: selection.previewVersion }
            : {}),
        }
      : null
  }, [preferences, preferencesFailed, privateImage, dailyImage, cache, selection])
  useEffect(() => loader.set(candidate, { previewFallback: true }), [loader, candidate])
  useEffect(() => () => loader.dispose(), [loader])

  // Guard on the live selection during render: withdrawal and source changes
  // hide a decoded image immediately, before the loader effect has run.
  const restoredMatches =
    restored &&
    !preferencesFailed &&
    selection !== null &&
    (!preferences || restored.key.startsWith(`${preferences.image_source}:`)) &&
    (selection === undefined || selection.key === restored.key)
  const liveImage =
    candidate?.key === background.image?.key &&
    (!cache ||
      background.quality !== 'preview' ||
      candidate.previewVersion === background.image.previewVersion)
      ? background.image
      : null
  const usingRestored =
    !liveImage && restoredMatches && (!candidate || background.status === 'loading')
  const visible = liveImage || (usingRestored ? restored : null)
  const backgroundQuality = usingRestored ? 'full' : visible ? background.quality : null
  const backgroundStatus =
    !preferencesFailed && preferences?.image_source === 'none'
      ? 'none'
      : visible
        ? 'ready'
        : !preferencesFailed &&
            (!preferences || (preferences.image_source === 'daily' && !dailyLoaded))
          ? 'loading'
          : candidate
            ? background.status
            : 'unavailable'
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.appearance = mode
    root.dataset.backgroundState = backgroundStatus
    root.dataset.backgroundQuality = backgroundQuality || 'none'
    root.classList.toggle('dark', mode !== 'light')
    root.style.colorScheme = mode === 'light' ? 'light' : 'dark'
  }, [mode, backgroundStatus, backgroundQuality])
  useEffect(() => {
    if (!preferences || preferencesFailed) return
    try {
      localStorage.setItem('qivo-appearance-mode', preferences.mode)
    } catch {
      // Storage can be disabled; account preferences still work normally.
    }
  }, [preferences, preferencesFailed])
  useLayoutEffect(
    () => () => {
      const root = document.documentElement
      delete root.dataset.appearance
      delete root.dataset.backgroundState
      delete root.dataset.backgroundQuality
      root.classList.remove('dark')
      root.style.removeProperty('color-scheme')
    },
    [],
  )
  const displayedDaily = visible?.key.startsWith('daily:') ? dailyImage : null
  return (
    <AppearanceContext.Provider
      value={{
        mode,
        backgroundStatus,
        backgroundQuality,
        backgroundUrl: visible?.url ?? null,
        dailyImage: displayedDaily,
      }}
    >
      <div className="appearance-background" aria-hidden="true" data-background-date={date}>
        {visible && (
          <img
            key={`${visible.key}:${visible.url}`}
            data-appearance-background
            data-background-quality={backgroundQuality}
            data-background-restored={usingRestored ? 'true' : undefined}
            src={visible.url}
            alt=""
            draggable={false}
            onError={() => loader.failed(visible)}
          />
        )}
      </div>
      {children}
    </AppearanceContext.Provider>
  )
}
