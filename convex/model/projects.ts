import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { badRequest } from '../lib/functions'
import { PROJECT_DESCRIPTION_MAX } from '../lib/projectLimits'
import { REVIEW_HOURS_MAX, resolveReviewHours, roundReviewHours } from '../lib/review'

/** Preserve the supplied text; null/omitted create values mean no description. */
export function projectDescription(value: string | null | undefined): string {
  const description = value ?? ''
  // String.length matches the browser's native textarea maxLength exactly.
  if (description.length > PROJECT_DESCRIPTION_MAX) {
    throw badRequest(`a project description must be ${PROJECT_DESCRIPTION_MAX} characters or fewer`)
  }
  return description
}

/** The stored project review time: null clears it (the project inherits
 * again), a value is kept to the 0.1 h grain within 0..REVIEW_HOURS_MAX. */
export function cleanReviewHours(v: number | null): number | undefined {
  if (v === null) return undefined
  if (!Number.isFinite(v) || v < 0 || v > REVIEW_HOURS_MAX) {
    throw badRequest(
      `review_hours must be a number of hours from 0 to ${REVIEW_HOURS_MAX}, or null`,
    )
  }
  return roundReviewHours(v)
}

/** The remaining time a task in this sub-project gets on entering Review:
 * its own setting, else its project's, else DEFAULT_REVIEW_HOURS. */
export async function reviewHoursFor(ctx: QueryCtx, project: Doc<'projects'>): Promise<number> {
  if (project.review_hours !== undefined) return project.review_hours
  const parent = project.parent_id ? await byId(ctx, 'projects', project.parent_id) : null
  return resolveReviewHours(undefined, parent?.review_hours)
}
