/* Account appearance is applied live by the app's AppearanceProvider. */
import { ConvexError } from 'convex/values'
import { ImageIcon, LoaderCircle } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  MANUAL_IMAGE_REQUIREMENTS,
  manualImageDimensions,
  validateManualImageFile,
  validatePanoramaDimensions,
} from '../../convex/lib/panoramaImage'
import { useAppearance } from '../AppearanceProvider'
import { SettingsGroup } from '../components/settingsPage'
import { ThemeSelector } from '../components/ThemeSelector'
import { useUpdateBlocker } from '../lib/updateSafety'
import { type AppearancePreferences, P } from '../store/planner'

/* Image of the week gets the same thumbnail frame a custom upload gets
   (deviation #237), drawn from the renderer's own delivery: the provider
   subscribes to the week's image while it is the Canvas choice, and Settings and
   the renderer subscribe to the preference independently, so the thumbnail and
   the credit under it appear once the local selection and the painted
   background agree. The compressed derivative is the thumbnail, as it is for a
   custom image; the original stands in only when the week's image has none. */
function WeeklyPreview({ preferences }: { preferences: AppearancePreferences }) {
  const { dailyImage, backgroundStatus } = useAppearance()
  const [broken, setBroken] = useState<string[]>([])
  if (preferences.image_source !== 'daily') return null
  const url =
    [dailyImage?.preview_url, dailyImage?.image_url].find(
      (candidate) => candidate && !broken.includes(candidate),
    ) || null
  const title = dailyImage?.title?.trim()
  const location = dailyImage?.location?.trim()
  const creator = dailyImage?.creator?.trim()
  return (
    <div className="space-y-2">
      <div className="max-w-72 overflow-hidden rounded-md border border-border bg-surface-2">
        {url ? (
          <img
            data-appearance-weekly-preview
            src={url}
            alt="This week's background"
            className="block h-auto w-full"
            onError={() => setBroken((list) => [...list, url])}
          />
        ) : (
          <span className="flex aspect-video items-center justify-center gap-2 p-4 text-sm text-text-2">
            <ImageIcon className="size-5 shrink-0" aria-hidden="true" />
            {dailyImage || backgroundStatus === 'unavailable'
              ? 'Preview unavailable.'
              : 'Loading preview…'}
          </span>
        )}
      </div>
      {(title || location || creator) && (
        <div data-appearance-image-details className="space-y-1 text-sm text-text-2">
          {title && <p className="font-medium text-text-1">{title}</p>}
          {location && <p>{location}</p>}
          {creator && <p>{creator}</p>}
        </div>
      )}
    </div>
  )
}

function errorText(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === 'object' && error.data !== null) {
    const message = (error.data as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return error instanceof Error ? error.message : 'Could not save appearance.'
}

async function inspectFile(file: File) {
  validateManualImageFile(file.type, file.size)
  manualImageDimensions(new Uint8Array(await file.arrayBuffer()), file.type)
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    try {
      await image.decode()
    } catch {
      throw new Error('Invalid image. Choose another file.')
    }
    validatePanoramaDimensions(image.naturalWidth, image.naturalHeight)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function PrivatePreview({ image }: { image: NonNullable<AppearancePreferences['custom_image']> }) {
  const [preview, setPreview] = useState<{ imageId: string; url: string } | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const recoveries = useRef(0)
  useEffect(() => {
    let active = true
    let renewing = false
    let expiresAt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setPreview((current) => (image.preview_ready && current?.imageId === image.id ? current : null))
    setError('')
    if (!image.preview_ready) return
    const renew = async () => {
      if (!active || renewing) return
      renewing = true
      clearTimeout(timer)
      try {
        const result = await P.mintAppearanceImageUrl()
        if (!active) return
        if (!result || result.image_id !== image.id) {
          setPreview(null)
          setError('This image is no longer available.')
          return
        }
        expiresAt = result.expires_at
        setPreview(
          result.preview_url ? { imageId: result.image_id, url: result.preview_url } : null,
        )
        setError(result.preview_url ? '' : 'Preview unavailable.')
        timer = setTimeout(
          () => void renew(),
          Math.max(1000, result.expires_at - Date.now() - 60_000),
        )
      } catch {
        if (!active) return
        setPreview(null)
        setError('Could not load preview.')
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
  }, [image.id, image.preview_ready, image.preview_version, attempt])
  return (
    <div className="space-y-2">
      <div className="max-w-72 overflow-hidden rounded-md border border-border bg-surface-2">
        {image.preview_ready && preview?.imageId === image.id && !error ? (
          <img
            data-appearance-preview
            src={preview.url}
            alt="Your custom background"
            className="block h-auto w-full"
            onLoad={() => {
              recoveries.current = 0
            }}
            onError={() => {
              // One fresh signed URL recovers an expired or briefly failed
              // request; persistent failures wait for an explicit retry.
              if (recoveries.current === 0) {
                recoveries.current++
                setAttempt((value) => value + 1)
              } else setError('Could not load preview.')
            }}
          />
        ) : (
          <span className="flex aspect-video items-center justify-center gap-2 p-4 text-sm text-text-2">
            <ImageIcon className="size-5 shrink-0" aria-hidden="true" />
            {error || (image.preview_ready ? 'Loading preview…' : 'Preparing preview…')}
          </span>
        )}
      </div>
      <p className="break-words text-xs text-text-2">
        {image.name}, {image.width} × {image.height},{' '}
        {image.byte_size < 1024 * 1024
          ? `${(image.byte_size / 1024).toFixed(1)} KB`
          : `${(image.byte_size / 1024 / 1024).toFixed(1)} MB`}
      </p>
      {error && (
        <Button
          type="button"
          onClick={() => {
            recoveries.current = 0
            setAttempt((value) => value + 1)
          }}
        >
          Reload preview
        </Button>
      )}
    </div>
  )
}

export function AppearanceSettings() {
  const id = useId()
  const [preferences, setPreferences] = useState<AppearancePreferences | null>(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  useUpdateBlocker(busy || uploading)
  const [attempt, setAttempt] = useState(0)
  const alive = useRef(false)
  const uploadController = useRef<AbortController | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      uploadController.current?.abort()
    }
  }, [])
  useEffect(() => {
    let active = true
    setLoadError('')
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = P.watchAppearance(
        (value) => {
          if (!active) return
          setPreferences(value)
          setLoadError('')
        },
        (failure) => {
          if (active) setLoadError(errorText(failure))
        },
      )
    } catch (failure) {
      setLoadError(errorText(failure))
    }
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [attempt])
  const update = async (changes: Partial<Pick<AppearancePreferences, 'mode' | 'image_source'>>) => {
    if (!preferences || busy || loadError) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await P.setAppearance({
        mode: preferences.mode,
        image_source: preferences.image_source,
        ...changes,
      })
      if (!alive.current) return
      // The subscription owns displayed settings. An HTTP or mutation
      // acknowledgment must not overwrite a newer delivery from another tab.
      setNotice('Appearance saved.')
    } catch (failure) {
      if (alive.current) setError(errorText(failure))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const upload = async (file?: File) => {
    if (!file || busy || loadError || preferences?.image_source !== 'custom') return
    setBusy(true)
    setUploading(true)
    setError('')
    setNotice('')
    const controller = new AbortController()
    uploadController.current = controller
    try {
      await inspectFile(file)
      if (controller.signal.aborted) return
      await P.uploadAppearanceImage(file, controller.signal)
      if (!alive.current) return
      setNotice('Custom image saved.')
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) setError(errorText(failure))
    } finally {
      if (uploadController.current === controller) uploadController.current = null
      if (alive.current) {
        setBusy(false)
        setUploading(false)
      }
    }
  }
  const remove = async () => {
    if (!preferences?.custom_image || busy || loadError) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await P.removeAppearanceImage()
      if (!alive.current) return
      setNotice('Custom image removed. Image of the week is selected.')
    } catch (failure) {
      if (alive.current) setError(errorText(failure))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <div data-appearance-settings>
      {loadError ? (
        <div role="alert" data-appearance-error className="space-y-2 text-sm text-danger">
          <p>{loadError}</p>
          <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      ) : !preferences ? (
        <p role="status" data-appearance-loading className="text-sm text-text-2">
          Loading appearance…
        </p>
      ) : (
        <>
          <ThemeSelector
            value={preferences.mode}
            disabled={busy}
            onChange={(mode) => void update({ mode })}
          />
          <SettingsGroup legend="Canvas" data-appearance-image-controls="" disabled={busy}>
            {/* The controls stack is spaced inside its own wrapper: `space-y` on the
                fieldset would also pad below the legend, opening a gap above the
                first control. */}
            <div className="space-y-4">
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {(
                  [
                    ['daily', 'Image of the week'],
                    ['custom', 'Custom image'],
                    ['none', 'No image'],
                  ] as const
                ).map(([value, label]) => (
                  <Label
                    key={value}
                    title={
                      value === 'daily'
                        ? 'Updates on your first visit after midnight UTC.'
                        : undefined
                    }
                    className="flex min-h-8 items-center gap-2 text-sm"
                  >
                    <Input
                      type="radio"
                      name={`${id}-source`}
                      value={value}
                      checked={preferences.image_source === value}
                      data-appearance-source={value}
                      onChange={() => void update({ image_source: value })}
                    />
                    {label}
                  </Label>
                ))}
              </div>
              {preferences.image_source === 'custom' && (
                <div className="space-y-4">
                  {preferences.custom_image && (
                    <PrivatePreview
                      key={preferences.custom_image.id}
                      image={preferences.custom_image}
                    />
                  )}
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-upload`} className="text-sm">
                      {preferences.custom_image ? 'Replace your image' : 'Choose your image'}
                    </Label>
                    <Input
                      id={`${id}-upload`}
                      data-appearance-upload
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      aria-describedby={`${id}-requirements`}
                      className="bg-surface-1"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        void upload(file)
                      }}
                    />
                    <p id={`${id}-requirements`} className="text-sm text-text-2">
                      {MANUAL_IMAGE_REQUIREMENTS}
                    </p>
                  </div>
                  {preferences.custom_image && (
                    <Button type="button" data-appearance-remove onClick={() => void remove()}>
                      Remove custom image
                    </Button>
                  )}
                </div>
              )}
              <WeeklyPreview preferences={preferences} />
            </div>
          </SettingsGroup>
          {busy && (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-text-2">
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {uploading ? 'Checking and uploading image…' : 'Saving…'}
            </p>
          )}
          {error && (
            <p role="alert" data-appearance-error className="mt-4 text-sm text-danger">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="mt-4 text-sm text-text-2">
              {notice}
            </p>
          )}
        </>
      )}
    </div>
  )
}
