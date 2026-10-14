/* Pure rules behind the operator's invitation dialogs (components/InviteDialogs.tsx).
   The server repeats every check in convex/adminOrgs.ts. These let a dialog
   point at the row to fix before anything is sent. */
import { addCalendarMonths } from '../../convex/lib/billingAccess'
import type { InviteRole, PeopleCheck, PersonInput } from './api'

/* convex/model/people.ts EMAIL_SHAPE, copied so the console bundle does not
   load server modules. invites.test.ts keeps the two equal. */
export const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/* The server allows an address of at most 40 characters
   (convex/model/orgs.ts SLUG_MAX), a name of at most 80 and at most 50
   people in one request. */
export const ADDRESS_MAX = 40
export const NAME_MAX = 80
export const MAX_PEOPLE = 50

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

/* The server's normalization (convex/model/people.ts cleanName and normalizeEmail). */
export const cleanName = (raw: string) => raw.replace(/\s+/g, ' ').trim()
export const cleanEmail = (raw: string) => raw.trim().toLowerCase()

export const isBlankRow = (row: PersonDraft) => row.name.trim() === '' && row.email.trim() === ''

/* A row with a name and a well-formed address. Add person waits for this on row 1. */
export const isCompleteRow = (row: PersonDraft) =>
  cleanName(row.name) !== '' && EMAIL_SHAPE.test(cleanEmail(row.email))

/* Typing in the address field. Organization addresses are lowercase, and the
   server refuses anything longer than 40 characters. */
export const cleanAddress = (raw: string) => raw.toLowerCase().slice(0, ADDRESS_MAX)

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
    const email = cleanEmail(row.email)
    const shaped = EMAIL_SHAPE.test(email)
    const repeated = shaped && seen.has(email)
    if (shaped) seen.add(email)
    people.push({ name, email, role: row.role })
    if (name === '') return { message: 'Add a name.', field: 'name', incomplete: true }
    if (email === '') return { message: 'Add an email address.', field: 'email', incomplete: true }
    if (!shaped) return { message: 'Enter a full email address.', field: 'email', incomplete: true }
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
