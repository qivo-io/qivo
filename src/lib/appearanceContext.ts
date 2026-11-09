/* The Canvas appearance AppearanceProvider resolves (theme mode and
   background image), for the views that paint it, the account's
   appearance as the provider reads it, which Settings › Appearance shows
   and edits without a read of its own, and the small preview of the
   selected background that the page shows. */
import type { FunctionReturnType } from 'convex/server'
import { createContext, useContext, useEffect } from 'react'
import type { api } from '../../convex/_generated/api'
import type { AppearancePreferences } from '../store/planner'
import type { CanvasImageQuality } from './appearance'

export type DailyImage = NonNullable<FunctionReturnType<typeof api.appearance.dailyImage>>

/** The selected background's preview: the small copy Qivo made of it, or
    for a weekly image without one the image the canvas shows. `key` and
    `previewVersion` name the selection it is of, so a view shows it only
    for the selection it shows. */
export type BackgroundPreview = {
  status: 'loading' | 'ready' | 'unavailable'
  url: string | null
  key: string | null
  previewVersion: string | null
}

type AppearanceState = {
  /** The account's appearance as the provider reads it (appearance.get),
      null before its first answer. */
  preferences: AppearancePreferences | null
  /** `loading` before the first answer, `failed` once the read failed,
      with its error, `retrying` from Try again after a failure until the
      new read answers, else `ok`. */
  preferencesState: 'loading' | 'ok' | 'failed' | 'retrying'
  preferencesError?: unknown
  /** Whether `preferences` is current, which it is once it arrived on the
      socket's newest connection while the socket is up. */
  preferencesCurrent: boolean
  /** Runs the provider's read again, as Try again does after a failure,
      so the server answers afresh. */
  retryPreferences: () => void
  mode: AppearancePreferences['mode']
  /** 'none' when the account chose No image as its Canvas background. */
  backgroundStatus: 'loading' | 'ready' | 'unavailable' | 'none'
  backgroundQuality: CanvasImageQuality | null
  backgroundUrl: string | null
  dailyImage: DailyImage | null
  preview: BackgroundPreview
  /** Asks for the preview while the caller is mounted; answers the way to
      stop asking. The provider reads it only while someone asks. */
  wantPreview: () => () => void
  /** Asks for the preview again, after a failure. */
  retryPreview: () => void
}

export const NO_PREVIEW: BackgroundPreview = {
  status: 'unavailable',
  url: null,
  key: null,
  previewVersion: null,
}

export const AppearanceContext = createContext<AppearanceState>({
  preferences: null,
  preferencesState: 'loading',
  preferencesCurrent: false,
  retryPreferences: () => {},
  mode: 'dark',
  backgroundStatus: 'loading',
  backgroundQuality: null,
  backgroundUrl: null,
  dailyImage: null,
  preview: NO_PREVIEW,
  wantPreview: () => () => {},
  retryPreview: () => {},
})

/** The appearance the nearest AppearanceProvider resolved. */
export const useAppearance = () => useContext(AppearanceContext)

/** The selected background's preview, which the provider reads from its
    shared cache while a view using this is mounted, and stops reading when
    the last one unmounts, as when Settings › Appearance closes. */
export function usePreview(): { preview: BackgroundPreview; retry: () => void } {
  const { preview, wantPreview, retryPreview } = useContext(AppearanceContext)
  useEffect(() => wantPreview(), [wantPreview])
  return { preview, retry: retryPreview }
}
