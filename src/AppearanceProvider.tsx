import type { FunctionReturnType } from 'convex/server'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { api } from '../convex/_generated/api'
import { type CanvasImageState, createCanvasImageLoader, decodeCanvasImage } from './lib/appearance'
import {
  AppearanceContext,
  type BackgroundPreview,
  type DailyImage,
  NO_PREVIEW,
} from './lib/appearanceContext'
import { browserBackendUrl, configuredConvexDeploymentUrl } from './lib/backendUrl'
import {
  BackgroundChanged,
  type BackgroundSelection,
  backgroundCacheScope,
  createBackgroundImageCache,
} from './lib/backgroundImageCache'
import { watchCanvasWeek } from './lib/canvasWeek'
import { convex } from './lib/convex'
import { watchDemoCanvas } from './lib/demoCanvas'
import { DEMO_MODE } from './lib/demoMode'
import { syncStatus } from './lib/syncStatus'
import { useViewVisibility, watchVisibility } from './lib/viewVisibility'
import { type AppearancePreferences, P } from './store/planner'

type ImageLease = NonNullable<FunctionReturnType<typeof api.appearance.mintCustomUrl>>

/* The custom background's lease, renewed a minute before it ends. While
   the page is hidden its timer stops (lib/viewVisibility.ts, by visibility
   and not focus), and on return it renews once if it is due. A lease
   already shown stays for display while its renewal is due or on its way,
   past its end too, so the background never goes away for a renewal, and
   the provider starts no new fetch with its URL once it has ended. A
   failed renewal keeps it too and sets `renewalFailed` until a renewal
   answers, so Settings can show its preview as unavailable once it has
   ended, or while a new derivative version has no lease of its own. The
   flag holds only for the image, derivative version and attempt whose
   renewal failed, so a change of any of them never shows the old failure.
   A refusal, no image or another image, drops it. A new `attempt` asks
   for the lease again at once, as Settings' Reload preview does after a
   refusal or a failure. */
function usePrivateImage(imageId: string | null, previewVersion: number | null, attempt: number) {
  const [lease, setLease] = useState<(ImageLease & { previewVersion: number | null }) | null>(null)
  const [failed, setFailed] = useState(false)
  // the inputs whose renewal failed, as `run` names them
  const run = `${imageId}:${previewVersion}:${attempt}`
  const [renewalFailedRun, setRenewalFailedRun] = useState<string | null>(null)
  const shown = useRef<string | null>(null)
  useEffect(() => {
    setFailed(false)
    setRenewalFailedRun(null)
    if (!imageId) {
      shown.current = null
      setLease(null)
      return
    }
    let active = true
    let renewing = false
    let hidden = false
    let expiresAt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // A new or regenerated derivative remints the lease for the same image;
    // keep its valid original URL painted while the new pair is resolved.
    if (shown.current !== imageId) shown.current = null
    setLease((current) => (current?.image_id === imageId ? current : null))
    const schedule = (ms: number) => {
      clearTimeout(timer)
      if (!hidden) timer = setTimeout(() => void renew(), ms)
    }
    const renew = async () => {
      if (!active || renewing || hidden) return
      renewing = true
      clearTimeout(timer)
      try {
        const result = await P.mintAppearanceImageUrl()
        if (!active) return
        if (!result || result.image_id !== imageId) {
          shown.current = null
          setLease(null)
          setFailed(true)
          setRenewalFailedRun(null)
          return
        }
        expiresAt = result.expires_at
        shown.current = imageId
        setLease({ ...result, previewVersion })
        setFailed(false)
        setRenewalFailedRun(null)
        schedule(Math.max(1000, expiresAt - Date.now() - 60_000))
      } catch {
        if (!active) return
        if (shown.current !== imageId) {
          setLease(null)
          setFailed(true)
          expiresAt = 0
        } else setRenewalFailedRun(run)
        schedule(60_000)
      } finally {
        renewing = false
      }
    }
    const stop = watchVisibility(({ visible }) => {
      hidden = !visible
      if (hidden) clearTimeout(timer)
      else if (expiresAt < Date.now() + 60_000) void renew()
      else schedule(Math.max(1000, expiresAt - Date.now() - 60_000))
    })
    return () => {
      active = false
      clearTimeout(timer)
      stop()
    }
    // attempt asks again after a refusal or a failure
  }, [imageId, previewVersion, attempt])
  return {
    lease: lease?.image_id === imageId ? lease : null,
    failed,
    renewalFailed: renewalFailedRun === run,
  }
}

/** Mounted after socket authentication, before workspace initialization, and
 * kept mounted through loading, view, scope and settings changes. The weekly
 * image follows UTC week boundaries without reloading the planner.
 *
 * It also serves Settings › Appearance's preview of the selected background
 * (lib/appearanceContext.ts usePreview), read only while Settings asks: the
 * shared cache's copy of the derivative once its bytes decode, else the
 * derivative fetched into it with a signal that detaches Settings alone
 * when it closes, or for a
 * weekly image without a derivative the image the canvas shows. It never
 * fetches an original for a preview. While the page is hidden the weekly
 * image's read (the demo's public feed poll in the demo) and the custom
 * lease's renewal pause, keeping the background and the last answer.
 *
 * The account's appearance (appearance.get) is read here alone, on the
 * live transport and outside the visibility gate, since the theme and
 * background the app paints must be right the moment a page shows. The
 * provider hands it to Settings › Appearance with its state, whether it
 * is current (it arrived on the socket's newest connection and the socket
 * is up) and a Try again that has the server run it afresh, so the page
 * holds no read of its own. */
export function AppearanceProvider({
  children,
  accountId,
}: {
  children: ReactNode
  accountId?: string
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  useEffect(() => watchCanvasWeek(setDate), [])
  // the weekly image's read and the custom lease pause while the page is
  // hidden; the background and the last answer stay
  const { visible: pageVisible } = useViewVisibility()
  const [preferences, setPreferences] = useState<AppearancePreferences | null>(null)
  // the read's failure, undefined while it has none
  const [preferencesError, setPreferencesError] = useState<unknown>(undefined)
  const preferencesFailed = preferencesError !== undefined
  // whether the latest answer arrived on the socket's newest connection
  const [preferencesArrived, setPreferencesArrived] = useState(false)
  // Try again's count, which subscribes the read afresh
  const [preferencesAttempt, setPreferencesAttempt] = useState(0)
  // from Try again until its read answers, while the page shows Loading
  // instead of the failure; the failure itself stays for every other
  // reader (usesDaily and the background), so nothing behind the page
  // moves until the new answer arrives
  const [preferencesRetrying, setPreferencesRetrying] = useState(false)
  const socketDown = useSyncExternalStore(syncStatus.subscribeDown, syncStatus.down, () => false)
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
  const [initialMode] = useState<AppearancePreferences['mode']>(() =>
    document.documentElement.dataset.appearance === 'light' ? 'light' : 'dark',
  )
  const mode = preferences?.mode ?? initialMode
  // The theme only chooses the palette; every theme paints the Canvas image.
  const usesDaily = !preferencesFailed && preferences?.image_source === 'daily'

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    // the newest connection a transition named, and the one the latest
    // answer came on, null for one read at once from a joined watch
    let newest = 0
    let came: number | null | undefined
    setPreferencesArrived(false)
    try {
      unsubscribe = P.watchAppearance(
        (result, connection) => {
          if (!active) return
          came = connection
          if (connection !== null && connection > newest) newest = connection
          if ('value' in result) {
            setPreferences(result.value)
            setPreferencesError(undefined)
          } else setPreferencesError(result.error)
          setPreferencesRetrying(false)
          setPreferencesArrived(true)
        },
        (connection) => {
          if (!active || connection <= newest) return
          const first = newest === 0
          newest = connection
          if (came === null && first) came = connection
          // after a reconnect the answer held is not current until it
          // arrives again
          if (came !== undefined && came !== connection) setPreferencesArrived(false)
        },
        // Try again has the server run it afresh, so no failure Convex
        // kept answers it
        { fresh: preferencesAttempt > 0 },
      )
    } catch (error) {
      setPreferencesError(error)
      setPreferencesRetrying(false)
    }
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [preferencesAttempt])
  const retryPreferences = useCallback(() => {
    setPreferencesRetrying(true)
    setPreferencesAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!usesDaily) {
      setDailyImage(null)
      setDailyLoaded(false)
      return
    }
    // hidden: no subscription (nor the demo's poll), the last answer stays
    if (!pageVisible) return
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
  }, [date, usesDaily, pageVisible])

  const customId =
    !preferencesFailed && preferences?.image_source === 'custom'
      ? (preferences.custom_image?.id ?? null)
      : null
  // Settings' Reload preview after the custom lease was refused or failed,
  // or its renewal failed
  const [leaseAttempt, setLeaseAttempt] = useState(0)
  const {
    lease: privateImage,
    failed: privateFailed,
    renewalFailed,
  } = usePrivateImage(customId, preferences?.custom_image?.preview_version ?? null, leaseAttempt)
  // the custom image the preferences name, whether or not its lease came
  const customSelection = useMemo<BackgroundSelection | null>(
    () =>
      customId
        ? {
            key: `custom:${customId}`,
            previewVersion:
              preferences?.custom_image?.preview_version == null
                ? null
                : String(preferences.custom_image.preview_version),
          }
        : null,
    [customId, preferences],
  )
  const selection = useMemo<BackgroundSelection | null | undefined>(() => {
    if (preferencesFailed) return null
    if (!preferences) return undefined
    if (preferences.image_source === 'none') return null
    if (preferences.image_source === 'custom') return privateFailed ? null : customSelection
    if (!dailyLoaded) return undefined
    return dailyImage?.image_url
      ? {
          key: `daily:${dailyImage.id}`,
          // Library storage URLs identify immutable bytes; never persist a bearer URL.
          previewVersion: dailyImage.preview_url ? new URL(dailyImage.preview_url).pathname : null,
        }
      : null
  }, [preferences, preferencesFailed, customSelection, privateFailed, dailyLoaded, dailyImage])
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
  // Settings' preview of the selection, read while someone asks for it
  const [previewAsks, setPreviewAsks] = useState(0)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [preview, setPreview] = useState<BackgroundPreview>(NO_PREVIEW)
  const wantPreview = useCallback(() => {
    setPreviewAsks((n) => n + 1)
    return () => setPreviewAsks((n) => n - 1)
  }, [])
  // a refused or failed custom lease, or one whose renewal failed, is
  // asked for again too
  const leaseFailed = useRef(false)
  leaseFailed.current = privateFailed || renewalFailed
  const retryPreview = useCallback(() => {
    setPreviewAttempt((n) => n + 1)
    if (leaseFailed.current) setLeaseAttempt((n) => n + 1)
  }, [])
  const previewWanted = previewAsks > 0
  // A custom image whose lease was refused or failed has no selection, but
  // its preview is still that image's: unavailable, with Reload preview.
  const previewSelection =
    selection ?? (preferences?.image_source === 'custom' ? customSelection : null)
  const previewKey = previewSelection?.key ?? null
  const previewVersion = previewSelection?.previewVersion ?? null
  const customPreview = previewKey?.startsWith('custom:') ?? false
  // the custom lease of this derivative version, else none yet
  const customLease =
    customPreview &&
    privateImage &&
    privateImage.previewVersion === (preferences?.custom_image?.preview_version ?? null)
      ? privateImage
      : null
  const derivative = customPreview
    ? (customLease?.preview_url ?? null)
    : (dailyImage?.preview_url ?? null)
  const leaseEnd = customLease?.expires_at ?? null
  const canvasUrl = visible && visible.key === previewKey ? visible.url : null
  // What the preview is now, or the derivative to read into the cache. Only
  // the values a case uses go into it, so a canvas that loads on or a
  // background status that changes never restarts a read of a derivative.
  const plan: { read: string | null; status: BackgroundPreview['status']; url: string | null } =
    selection === undefined
      ? { read: null, status: 'loading', url: null }
      : !previewKey
        ? { read: null, status: 'unavailable', url: null }
        : customPreview && privateFailed
          ? { read: null, status: 'unavailable', url: null }
          : customPreview && !customLease
            ? // The lease of this version is on its way, or its mint failed
              // while the lease of an older version stays shown.
              { read: null, status: renewalFailed ? 'unavailable' : 'loading', url: null }
            : derivative
              ? { read: derivative, status: 'loading', url: null }
              : // A weekly image without a derivative shows the image the
                // canvas shows; Settings never fetches an original for one.
                !customPreview && canvasUrl
                ? { read: null, status: 'ready', url: canvasUrl }
                : {
                    read: null,
                    status:
                      !customPreview && backgroundStatus === 'loading' ? 'loading' : 'unavailable',
                    url: null,
                  }
  useEffect(() => {
    if (!previewWanted) {
      setPreview(NO_PREVIEW)
      return
    }
    const show = (status: BackgroundPreview['status'], url: string | null) =>
      setPreview({ status, url, key: previewKey, previewVersion })
    const derivativeUrl = plan.read
    if (!derivativeUrl || !previewKey) return show(plan.status, plan.url)
    // A custom lease that has ended reads nothing with its URL. Its preview
    // loads while its renewal is due, and is unavailable, with Reload
    // preview, once the renewal failed.
    if (leaseEnd !== null && leaseEnd <= Date.now())
      return show(renewalFailed ? 'unavailable' : 'loading', null)
    // the demo keeps no cache: the derivative itself
    if (!cache) return show('ready', derivativeUrl)
    const selected = { key: previewKey, previewVersion }
    const controller = new AbortController()
    let active = true
    show('loading', null)
    void (async () => {
      const restored = await cache.restorePreview().catch(() => null)
      if (!active) return
      if (restored?.key === previewKey && restored.previewVersion === previewVersion)
        return show('ready', restored.url)
      try {
        const url = await cache.resolve(derivativeUrl, selected, 'preview', controller.signal)
        if (active) show('ready', url)
      } catch (error) {
        if (!active || controller.signal.aborted || error instanceof BackgroundChanged) return
        // Storage or fetch restrictions must not hide a preview the page
        // can load as a plain image: the derivative, never the original.
        show('ready', derivativeUrl)
      }
    })()
    return () => {
      active = false
      controller.abort()
    }
    // previewAttempt asks again after a failure
  }, [
    previewWanted,
    previewAttempt,
    previewKey,
    previewVersion,
    plan.read,
    plan.status,
    plan.url,
    leaseEnd,
    renewalFailed,
    cache,
  ])
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
        preferences,
        preferencesState: preferencesFailed
          ? preferencesRetrying
            ? 'retrying'
            : 'failed'
          : preferences
            ? 'ok'
            : 'loading',
        ...(preferencesFailed ? { preferencesError } : {}),
        preferencesCurrent: preferencesArrived && !socketDown,
        retryPreferences,
        mode,
        backgroundStatus,
        backgroundQuality,
        backgroundUrl: visible?.url ?? null,
        dailyImage: displayedDaily,
        preview,
        wantPreview,
        retryPreview,
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
