/* The app's reading of the limits registry (convex/lib/limits.ts). A text
   counts as the server counts it, UTF-16 code units after trimming, so a
   field and the store refuse exactly what the server would. */

import { grouped, type Limit, outsideWhole, overText } from '../../convex/lib/limits'

/** Whether `value`, trimmed as the server trims it, is over `limit`. A Save
    button stays disabled while this holds. */
export const overLimit = (limit: Limit, value: string): boolean => overText(limit, value.trim())

/** A person name as the server stores and counts it. */
export { cleanName } from '../../convex/lib/limits'

/** Whether a field shows its count: from 90 percent of the cap, and always
    when over it. `count` is the trimmed length. */
export const nearLimit = (limit: Limit, count: number): boolean => count >= limit.max * 0.9

/** "245/255": a trimmed length and the cap, as a field's counter shows them. */
export const countText = (limit: Limit, count: number): string =>
  `${grouped(count)}/${grouped(limit.max)}`

/** A typed number as a whole number within `limit`, or null when it is not
    one, such as 0, 169 or 37.5 for plannable hours. */
export const wholeIn = (limit: Limit, raw: string): number | null => {
  const n = Number(raw)
  return raw.trim() === '' || outsideWhole(limit, n) ? null : n
}

/** A server message as a sentence the app shows: capitalized and ending with
    a period. Registry refusals and `rule` refusals start lowercase. */
export const sentence = (message: string): string =>
  message.charAt(0).toUpperCase() + message.slice(1) + (/[.!?]$/.test(message) ? '' : '.')

/** `limit`'s refusal as the app shows it, the same words the server's `rule`
    refusal shows. */
export const limitSentence = (limit: Limit): string => sentence(limit.refusal)
