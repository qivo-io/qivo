/* Account appearance is applied live by the app's AppearanceProvider. */
import { ConvexError } from 'convex/values'
import { ImageIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  manualImageDimensions,
  manualImageRequirements,
  validateManualImageFile,
  validatePanoramaDimensions,
} from '../../convex/lib/panoramaImage'
import { SettingsGroup } from '../components/settingsPage'
import { ThemeSelector } from '../components/ThemeSelector'
import { useAppearance, usePreview } from '../lib/appearanceContext'
import { assertDemoFileSize, DEMO_FILE_MIB } from '../lib/demoMode'
import { useUnsaved } from '../lib/leaveGuard'
import { useUpdateBlocker } from '../lib/updateSafety'
import { type AppearancePreferences, P } from '../store/planner'

/* Image of the week gets the same thumbnail frame a custom upload gets
   (deviation #237), from the provider's preview (lib/appearanceContext.ts
   usePreview): the small copy Qivo made of the week's image, read from the
   shared background cache, or where the week's image has none the image
   the canvas already shows. Settings never fetches the original for it.
   Settings and the renderer subscribe to the preference independently, so
   the thumbnail and the credit under it appear once the local selection
   and the painted background agree. */
function WeeklyPreview({ preferences }: { preferences: AppearancePreferences }) {
  const { dailyImage } = useAppearance()
  const { preview, retry } = usePreview()
  const [broken, setBroken] = useState<string | null>(null)
  if (preferences.image_source !== 'daily') return null
  const ours = preview.key?.startsWith('daily:') ?? false
  const url = ours && preview.status === 'ready' && preview.url !== broken ? preview.url : null
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
            onError={() => {
              setBroken(url)
              retry()
            }}
          />
        ) : (
          <span className="flex aspect-video items-center justify-center gap-2 p-4 text-sm text-text-2">
            <ImageIcon className="size-5 shrink-0" aria-hidden="true" />
            {ours && preview.status === 'loading' ? 'Loading preview…' : 'Preview unavailable.'}
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

/* The sentence of a failed appearance change, with its first letter
   capitalized, since server refusals start lowercase. */
function errorText(error: unknown): string {
  let message = error instanceof Error ? error.message : 'Could not save appearance.'
  if (error instanceof ConvexError && typeof error.data === 'object' && error.data !== null) {
    const data = (error.data as { message?: unknown }).message
    if (typeof data === 'string') message = data
  }
  return message.charAt(0).toUpperCase() + message.slice(1)
}

/** What Settings says in place of a preview the demo's full storage left no
    room for, which the demo makes once 1 MiB is free
    (convex/schema.ts custom_backgrounds.preview_skipped). */
const PREVIEW_SKIPPED =
  "No preview yet, because the demo's file storage is full. Qivo makes one once 1 MiB is free, and your background still shows."

async function inspectFile(file: File) {
  // the demo's smaller limit first, so a large pick names the one that applies
  assertDemoFileSize(file.size)
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

/* The custom image's preview from the provider's preview
   (lib/appearanceContext.ts usePreview), shown only for this image and
   its preview version. Settings mints no URL of its own: the provider's
   lease and shared background cache serve the canvas and this preview
   alike, and the preview's read stops when the page closes. */
function PrivatePreview({ image }: { image: NonNullable<AppearancePreferences['custom_image']> }) {
  const { preview, retry } = usePreview()
  const [error, setError] = useState('')
  const recoveries = useRef(0)
  const ours =
    preview.key === `custom:${image.id}` &&
    preview.previewVersion ===
      (image.preview_version === null ? null : String(image.preview_version))
  const url = image.preview_ready && ours && preview.status === 'ready' ? preview.url : null
  // a new preview read starts clean
  useEffect(() => {
    if (url) setError('')
  }, [url])
  const message =
    error ||
    (!image.preview_ready
      ? image.preview_skipped
        ? PREVIEW_SKIPPED
        : 'Preparing preview…'
      : ours && preview.status === 'unavailable'
        ? 'Preview unavailable.'
        : 'Loading preview…')
  return (
    <div className="space-y-2">
      <div className="max-w-72 overflow-hidden rounded-md border border-border bg-surface-2">
        {url && !error ? (
          <img
            data-appearance-preview
            src={url}
            alt="Your custom background"
            className="block h-auto w-full"
            onLoad={() => {
              recoveries.current = 0
            }}
            onError={() => {
              // One fresh read recovers a briefly failed request; persistent
              // failures wait for an explicit retry.
              if (recoveries.current === 0) {
                recoveries.current++
                retry()
              } else setError('Could not load preview.')
            }}
          />
        ) : (
          <span className="flex aspect-video items-center justify-center gap-2 p-4 text-sm text-text-2">
            <ImageIcon className="size-5 shrink-0" aria-hidden="true" />
            {message}
          </span>
        )}
      </div>
      <p className="break-words text-xs text-text-2">
        {image.name}, {image.width} × {image.height},{' '}
        {image.byte_size < 1024 * 1024
          ? `${(image.byte_size / 1024).toFixed(1)} KB`
          : `${(image.byte_size / 1024 / 1024).toFixed(1)} MB`}
      </p>
      {(error || (image.preview_ready && ours && preview.status === 'unavailable')) && (
        <Button
          type="button"
          onClick={() => {
            recoveries.current = 0
            setError('')
            retry()
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
  // an image on its way to the server is lost if the page closes
  useUnsaved(uploading, 'background image')
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
                      {manualImageRequirements(DEMO_FILE_MIB)}
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
            <p role="status" className="mt-4 text-sm text-text-2">
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
