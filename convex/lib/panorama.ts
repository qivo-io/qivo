/* Shared weekly calendar and ingestion bounds. Legacy MM-DD keys remain accepted. */
import { v } from 'convex/values'
import { badRequest } from './functions'
import { calendarWeekForKey, calendarWeeks, isoWeekForDate } from './panoramaWeeks'

export { jpegDimensions, PANORAMA_MAX_BYTES } from './panoramaImage'

export const vPanoramaStatus = v.union(
  v.literal('pending'),
  v.literal('approved'),
  v.literal('removed'),
)

// Historical export names are retained for the existing function surface.
export const calendarDays = calendarWeeks

export function validateCalendarDay(day: string): string {
  try {
    calendarWeekForKey(day)
    return day
  } catch (error) {
    throw badRequest((error as Error).message)
  }
}

export function calendarDayForDate(date: string): string {
  try {
    return isoWeekForDate(date).week
  } catch (error) {
    throw badRequest((error as Error).message)
  }
}
