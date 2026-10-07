/* External curation proposals are references, not downloaded/approved images.
 * No network, database, or credential access belongs in these validators.
 * A canonical Unsplash URL proves neither that the photo exists nor that it
 * uses the standard free license; acquisition and human review are separate.
 */
import { badRequest } from './functions'
import { validateCalendarDay } from './panorama'

export const CURATION_BODY_LIMIT_BYTES = 16 * 1024
export const CURATION_TOKEN_PREFIX = 'qvc_'

export type CurationSubmission = {
  source_url: string
  source_id: string
  day: string
  title?: string
  creator?: string
  reason?: string
}

export type CurationReview = {
  decision: 'approved' | 'declined'
  reason: string
  day?: string
}

function objectInput(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw badRequest('send a JSON object')
  return input as Record<string, unknown>
}

function textField(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string') throw badRequest(`${field} must be text`)
  const text = value.trim()
  if (!text) throw badRequest(`${field} cannot be blank`)
  if (text.length > limit) throw badRequest(`${field} must be at most ${limit} characters`)
  return text
}

function annualDay(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:W\d{2}|\d{2}-\d{2})$/.test(value))
    throw badRequest('use a recurring week in W01–W53 format; legacy MM-DD dates are also accepted')
  return validateCalendarDay(value)
}

export function parseUnsplashReference(
  value: unknown,
): Pick<CurationSubmission, 'source_url' | 'source_id'> {
  if (typeof value === 'string' && /\p{Cc}/u.test(value))
    throw badRequest('url cannot contain control characters')
  const url = textField(value, 'url', 2048)
  // Inspect the original path rather than URL.pathname: URL parsing normalizes
  // traversal, backslashes, default ports and some control characters away.
  // Query/fragment data is discarded without being decoded or fetched.
  const match =
    /^https:\/\/(?:www\.)?unsplash\.com\/photos\/([A-Za-z0-9_-]+)\/?(?:[?#][\s\S]*)?$/.exec(url)
  if (!match)
    throw badRequest(
      'use an HTTPS Unsplash photo page URL, such as https://unsplash.com/photos/PHOTO_ID',
    )
  const segment = match[1]
  const photoId = segment.slice(-11)
  if (
    !/^[A-Za-z0-9_-]{11}$/.test(photoId) ||
    (segment.length !== 11 &&
      (segment.length < 13 ||
        segment[segment.length - 12] !== '-' ||
        !/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(segment.slice(0, -12))))
  )
    throw badRequest('the Unsplash photo URL must end with its 11-character photo ID')
  return {
    source_url: `https://unsplash.com/photos/${photoId}`,
    source_id: `unsplash:${photoId}`,
  }
}

/** Agent-supplied URL + recurring date. Unknown fields are not copied into the
 * result; in particular, agents cannot smuggle approval/ownership fields. */
export function parseCurationSubmission(input: unknown): CurationSubmission {
  const values = objectInput(input)
  return {
    ...parseUnsplashReference(values.url),
    day: annualDay(values.date),
    ...(values.title === undefined ? {} : { title: textField(values.title, 'title', 300) }),
    ...(values.creator === undefined ? {} : { creator: textField(values.creator, 'creator', 300) }),
    ...(values.reason === undefined ? {} : { reason: textField(values.reason, 'reason', 2000) }),
  }
}

/** An agent precheck is distinct from the library's human approval status. */
export function parseCurationReview(input: unknown): CurationReview {
  const values = objectInput(input)
  if (values.decision !== 'approved' && values.decision !== 'declined')
    throw badRequest('decision must be approved or declined')
  return {
    decision: values.decision,
    reason: textField(values.reason, 'reason', 2000),
    ...(values.day === undefined ? {} : { day: annualDay(values.day) }),
  }
}
