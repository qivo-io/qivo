/* What the server-read pickers say at the end of their lists, and their
   Escape rule, beside the parts that show them (pickerParts.tsx). */
import { sentence } from '../lib/fieldLimits'

/** The answer of a picker's read with no rows, or of one that failed it. */
export type HeldPick = { state: string; message?: string }

/** What a picker's list says at its end, in its own words. */
export type ChoiceWords = {
  /** the line for `held`, a read with no rows, such as not ready or a
      refusal with the server's sentence */
  held: (held: HeldPick | undefined) => string
  /** a failed read, beside Try again */
  failed: string
  /** a batch the read budget stopped, beside Load more */
  stopped: string
  /** the real end of the list without a search and with no row */
  empty: string
  /** the real end of a search with no row */
  none: string
}

/** What a people or access picker says of `held`, a read with no rows:
    the server's sentence for a refusal, and its other states in the
    picker's words. */
export function heldLine(held: HeldPick | undefined, people: boolean) {
  if (held?.state === 'refused' && held.message) return sentence(held.message)
  if (held?.state === 'unavailable' || held?.state === 'archived')
    return 'This project is no longer available.'
  return people ? "People can't be listed yet." : "Teams and people can't be listed yet."
}

/** The Add team or user picker's words, which the New project dialog's
    Project access shares. */
export const ACCESS_WORDS: ChoiceWords = {
  held: (held) => heldLine(held, false),
  failed: "Couldn't load teams and people.",
  stopped: 'Showing the teams and people found so far.',
  empty: 'No teams or people to add.',
  none: 'Nothing matches.',
}

/** The Add member picker's words on a team's page. A team that is gone
    says so in its own words, since heldLine speaks of a project. */
export const MEMBER_WORDS: ChoiceWords = {
  held: (held) =>
    held?.state === 'unavailable' ? 'This team is no longer available.' : heldLine(held, true),
  failed: "Couldn't load people.",
  stopped: 'Showing the people found so far.',
  empty: 'Nobody else can join this team.',
  none: 'No people match.',
}

/** A Lead field's words. */
export const LEAD_WORDS: ChoiceWords = {
  held: (held) => heldLine(held, true),
  failed: "Couldn't load people.",
  stopped: 'Showing the people found so far.',
  empty: 'No one can lead it.',
  none: 'Nothing matches.',
}

/** Keeps a picker's popover open on an Escape in its search box, marked
    `probe`, while the box holds text, which the box then clears. */
export const escapeClearsFirst = (probe: string) => (event: KeyboardEvent) => {
  const field = event.target
  if (field instanceof HTMLInputElement && field.matches(`[${probe}]`))
    if (field.value !== '') event.preventDefault()
}
