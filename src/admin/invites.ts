/* Pure rules behind the operator's invitation dialogs (components/InviteDialogs.tsx).
   The server repeats every check in convex/adminOrgs.ts. These let a dialog
   point at the row to fix before anything is sent. */
import { cleanName, limitSentence, overLimit } from '@/lib/fieldLimits'
import { addCalendarMonths } from '../../convex/lib/billingAccess'
import { asciiEmail, cleanEmail } from '../../convex/lib/email'
import { LIMITS } from '../../convex/lib/limits'
import type { InviteRole, PeopleCheck, PersonInput } from './api'

/* The complimentary months offered while creating an organization. */
export const FREE_MONTHS = 6

/* One person row in a dialog. `id` keys the row while rows come and go. */
export type PersonDraft = { id: number; name: string; email: string; role: InviteRole }

/* A row's problem, worded for the line under it. `field` is the input to mark
   invalid. An incomplete row is reported once the operator leaves it, so a
   row being typed into stays quiet. Conflicts are reported at once. */
export type RowIssue = { message: string; field: 'name' | 'email'; incomplete: boolean }

export type PeopleReview = {
  /* One entry per row. Null for a row that is fine or blank. */
  issues: (RowIssue | null)[]
  /* The rows to send, blank rows left out, names and addresses cleaned. */
  people: PersonInput[]
  /* True when no row has an issue. */
  ready: boolean
}

/* The server's normalization: convex/model/people.ts cleanName (the app's
   copy is in lib/fieldLimits.ts), and for addresses convex/lib/email.ts,
   whose asciiEmail lowercases and writes a Unicode domain as punycode, and
   whose cleanEmail also checks the result. */
export { asciiEmail, cleanEmail, cleanName }

/* Why a typed name cannot be sent, or '' when it can. */
export function nameProblem(raw: string): string {
  const name = cleanName(raw)
  if (name === '') return 'Add a name.'
  return overLimit(LIMITS.personName, name) ? limitSentence(LIMITS.personName) : ''
}

/* Why a typed address cannot be sent, or '' when cleanEmail takes it. */
export function emailProblem(raw: string): string {
  if (raw.trim() === '') return 'Add an email address.'
  if (asciiEmail(raw).length > LIMITS.email.max) return limitSentence(LIMITS.email)
  return cleanEmail(raw) === null ? 'Enter a full email address.' : ''
}

export const isBlankRow = (row: PersonDraft) => row.name.trim() === '' && row.email.trim() === ''

/* A row with a name and a well-formed address. Add person waits for this on row 1. */
export const isCompleteRow = (row: PersonDraft) =>
  nameProblem(row.name) === '' && emailProblem(row.email) === ''

/* Typing in the address field. Organization addresses are lowercase; one
   longer than the server takes is kept and refused (addressIssue). */
export const cleanAddress = (raw: string) => raw.toLowerCase()

/* The sentence under a typed organization address that is longer than the
   server takes, or ''. */
export const addressIssue = (slug: string) =>
  overLimit(LIMITS.slug, slug) ? limitSentence(LIMITS.slug) : ''

/* checkAddress reason codes, as the sentence under the address field. */
export function addressMessage(reason: string): string {
  if (reason === 'slug_taken') return 'That address is taken. Choose another.'
  if (reason === 'slug_reserved') return 'That address is reserved. Choose another.'
  return 'Use lowercase letters, digits and single hyphens.'
}

/* Checks every row the way the server will. `adminFirst` is the server's
   admin-first rule for an organization without an active org admin. The
   first person sent must then be an org admin. `checks` holds checkPeople
   results by cleaned address. Blank rows are ignored. */
export function reviewPeople(
  rows: readonly PersonDraft[],
  opts: { adminFirst: boolean; checks: ReadonlyMap<string, PeopleCheck> },
): PeopleReview {
  const firstFilled = rows.findIndex((row) => !isBlankRow(row))
  const seen = new Set<string>()
  const people: PersonInput[] = []
  const issues = rows.map((row, i): RowIssue | null => {
    if (isBlankRow(row)) {
      const adminMissing =
        i === 0 && opts.adminFirst && firstFilled > 0 && rows[firstFilled].role !== 'admin'
      return adminMissing
        ? { message: 'Fill in the org admin first.', field: 'name', incomplete: false }
        : null
    }
    const name = cleanName(row.name)
    const email = asciiEmail(row.email)
    const shaped = cleanEmail(row.email) !== null
    const repeated = shaped && seen.has(email)
    if (shaped) seen.add(email)
    people.push({ name, email, role: row.role })
    const named = nameProblem(row.name)
    if (named) return { message: named, field: 'name', incomplete: name === '' }
    const addressed = emailProblem(row.email)
    if (addressed)
      return {
        message: addressed,
        field: 'email',
        // a blank or half-typed address waits; one too long is said at once
        incomplete: email.length <= LIMITS.email.max,
      }
    if (repeated)
      return { message: 'This address is listed twice.', field: 'email', incomplete: false }
    const conflict = conflictMessage(opts.checks.get(email))
    return conflict ? { message: conflict, field: 'email', incomplete: false } : null
  })
  return { issues, people, ready: issues.every((issue) => issue === null) }
}

/* Why a checked address cannot be invited here, or '' when it can. The
   server refuses both cases, and guests are invited from project settings. */
export function conflictMessage(check: PeopleCheck | undefined): string {
  if (check?.in_org) return 'Already has a seat in this organization.'
  if (check?.home_org_name)
    return `Already belongs to ${check.home_org_name}, so they can only join as a guest. An org admin can invite them from project settings.`
  return ''
}

const invites = (n: number) => `${n} invite${n === 1 ? '' : 's'}`

/* The New organization dialog's submit label for `n` people. */
export const createLabel = (n: number) =>
  n === 0 ? 'Create organization' : `Create and send ${invites(n)}`

/* The Invite people dialog's submit label for `n` people. */
export const sendLabel = (n: number) => (n === 0 ? 'Send invites' : `Send ${invites(n)}`)

/* When complimentary access chosen at `now` ends, as the server computes it
   (convex/model/billing.ts grantComplimentaryMonths for a new organization). */
export const freeUntil = (now: Date) => addCalendarMonths(now.toISOString(), FREE_MONTHS)
