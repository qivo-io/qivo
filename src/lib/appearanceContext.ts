/* The Canvas appearance AppearanceProvider resolves (theme mode and
   background image), for the views that paint it. */
import type { FunctionReturnType } from 'convex/server'
import { createContext, useContext } from 'react'
import type { api } from '../../convex/_generated/api'
import type { AppearancePreferences } from '../store/planner'
import type { CanvasImageQuality } from './appearance'

export type DailyImage = NonNullable<FunctionReturnType<typeof api.appearance.dailyImage>>
type AppearanceState = {
  mode: AppearancePreferences['mode']
  /** 'none' when the account chose No image as its Canvas background. */
  backgroundStatus: 'loading' | 'ready' | 'unavailable' | 'none'
  backgroundQuality: CanvasImageQuality | null
  backgroundUrl: string | null
  dailyImage: DailyImage | null
}

export const AppearanceContext = createContext<AppearanceState>({
  mode: 'dark',
  backgroundStatus: 'loading',
  backgroundQuality: null,
  backgroundUrl: null,
  dailyImage: null,
})

/** The appearance the nearest AppearanceProvider resolved. */
export const useAppearance = () => useContext(AppearanceContext)
