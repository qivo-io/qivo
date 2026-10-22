/* Shared weekly calendar and ingestion bounds. Legacy MM-DD keys remain accepted. */
import { v } from 'convex/values'
import { badRequest } from './functions'
import { limitedText } from './limitRules'
import { LIMITS } from './limits'
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

/** An image's credits as the library stores them: trimmed, with an empty
 * location left out. Refuses a missing title or creator, and a credit over
 * its limit (LIMITS.imageTitle, imageCreator, imageLocation) with the
 * limit's sentence. */
export function imageCredits(raw: { title: string; creator: string; location?: string }): {
  title: string
  creator: string
  location: string | undefined
} {
  const title = limitedText(LIMITS.imageTitle, raw.title)
  const creator = limitedText(LIMITS.imageCreator, raw.creator)
  if (!title || !creator) throw badRequest('provide the image title and creator')
  const location = limitedText(LIMITS.imageLocation, raw.location ?? '') || undefined
  return { title, creator, location }
}
