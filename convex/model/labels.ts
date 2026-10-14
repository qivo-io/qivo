/* Shared label rules. Every write to the organization's label list goes
 * through these checks, so the app and the machine surfaces agree on who may
 * change labels and what a stored name or color may be. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { canManageOrgLabels, canWriteOrgLabels } from '../lib/access'
import { badRequest, forbidden } from '../lib/functions'

/** Refuses a caller who may not add labels to the organization's list. */
export async function assertLabelCreator(ctx: QueryCtx, me: Doc<'profiles'>): Promise<void> {
  if (!(await canWriteOrgLabels(ctx, me))) {
    throw forbidden('no label access in this organization')
  }
}

/** Refuses a caller who may not rename, recolor or delete labels. Checked
 * before any label lookup, so a refusal says nothing about which ids exist. */
export function assertLabelManager(me: Doc<'profiles'>): void {
  if (!canManageOrgLabels(me)) {
    throw forbidden('only organization admins can rename, recolor or delete labels')
  }
}

/** Trims the name and refuses it when blank or longer than 40 codepoints
 * (0010's CHECK, Postgres char_length semantics). */
export function labelName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw badRequest('a label name cannot be blank')
  if ([...name].length > 40) throw badRequest('a label name is at most 40 characters')
  return name
}

/** True for a `#rrggbb` color, in either case. Clients render the stored
 * value as a CSS background, so nothing else may be stored. */
export function isLabelColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

/** The color as given, refused unless it is `#rrggbb`. */
export function labelColor(raw: string): string {
  if (!isLabelColor(raw)) {
    throw badRequest('a label color must be # followed by six hex digits, like #4C9AFF')
  }
  return raw
}

/** The palette's gray, sent in place of a stored color that breaks the rule. */
const FALLBACK_LABEL_COLOR = '#8A8F98'

/** The color to send a client. Rows saved before the `#rrggbb` rule may hold
 * any text, so every read that hands a label to a client uses this and sends
 * gray instead. The stored value stays until an admin recolors the label. */
export function shownLabelColor(stored: string): string {
  return isLabelColor(stored) ? stored : FALLBACK_LABEL_COLOR
}
