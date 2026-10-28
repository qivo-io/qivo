/* A settings field's draft, kept against the saved value it began from.

   A field shows its saved value and follows each new one until the person
   types. What they type is then a draft, with its base, the saved value it
   began from. A new saved value never replaces a draft. One that differs
   from the base, and from the value this session is saving, is a conflict
   the field shows until the person chooses Use saved or Keep mine. Keep
   mine makes the saved value the base, so the next save replaces it on
   purpose.

   A save sends the draft with its base as the value the person saw (the
   write's `expected`, convex/model/expected.ts), so the server refuses it
   when someone else changed the value first. The session's own value, from
   the store's paint or from the server, is no conflict: it becomes the base,
   and text typed after the save started stays as a draft against it. A
   refusal keeps the draft against the base the save began from.

   Values compare as the store saves them (DraftForm.same), so a draft that
   differs from the saved value only in spaces or case is no change. A draft
   belongs to one record and field (its key): a new key starts untouched,
   and the answer of a save made under another key changes nothing.

   draftReduce is the rule, pure; useSavedDraft holds it for one field. */

import { useId, useLayoutEffect, useReducer, useRef } from 'react'
import { asciiEmail } from '../../convex/lib/email'
import type { Writer } from '../store/fieldNotice'
import { cleanName } from './fieldLimits'
import { useUnsaved } from './leaveGuard'
import { useUpdateBlocker } from './updateSafety'

/** How a field shows its saved values and compares typed texts. */
export type DraftForm<T> = {
  /** The text the input shows for saved value `value`. */
  text: (value: T) => string
  /** Whether texts `a` and `b` save as the same value. */
  same: (a: string, b: string) => boolean
}

/** A saved value that changed elsewhere while the field held a draft, and
    who wrote it when a refused save said so (null when unknown). */
export type DraftConflict<T> = { value: T; by: Writer }

/** One field's draft. */
export type DraftState<T> = {
  /** The record and field the draft belongs to. */
  key: string
  /** The latest saved value. */
  saved: T
  /** The text typed, or null while the field shows its saved value. */
  draft: string | null
  /** The saved value the draft began from: `saved` while untouched. */
  base: T
  /** The saves sent and not yet seen as a saved value, oldest first. */
  sending: { seq: number; value: T }[]
  /** The number of the newest save. A refusal of an older one leaves the
      draft to the newer save, which carries newer text. */
  seq: number
  /** The number of the newest save whose draft the person dropped, which
      a refusal then does not bring back. */
  dropped: number
  conflict: DraftConflict<T> | null
  /** Who wrote the value a refused save found, until that value shows.
      Undefined when no refusal waits. */
  refusedBy: Writer | undefined
  /** The base and values of older saves refused while a newer one was in
      flight. The newer save began from their value, which the server never
      stored, so its refusal goes back to the oldest one's base. */
  chained: { seen: T; values: T[] } | null
}

/** What changes a field's draft. */
type DraftEvent<T> =
  /** The store shows a new saved value. */
  | { type: 'saved'; value: T }
  /** The person typed. */
  | { type: 'edit'; text: string }
  /** Save `seq` of the draft went out, to store `value`. */
  | { type: 'send'; seq: number; value: T }
  /** The server took save `seq`, sent from base `seen`. */
  | { type: 'accepted'; seq: number; value: T; seen: T }
  /** The server refused save `seq` of `value` from `seen`. `by` is set for a
      refusal over a value someone else wrote first (field_changed). */
  | { type: 'refused'; seq: number; value: T; seen: T; by?: Writer }
  /** Use saved, a Discard or Escape: the draft goes, and with it any save
      in flight, whose refusal then brings nothing back. */
  | { type: 'discard' }
  /** The field puts the saved value back without the person asking, for a
      draft that reads as it, such as a name with a space more, or an empty
      name: it shows the saved value's own text. */
  | { type: 'showSaved' }
  /** Keep mine: the saved value becomes the base. */
  | { type: 'keepMine' }

/** An event for the draft of record and field `key`. */
export type DraftAction<T> = DraftEvent<T> & { key: string }

/** A field's state for record and field `key` with `saved` stored. */
export const draftStart = <T>(key: string, saved: T): DraftState<T> => ({
  key,
  saved,
  draft: null,
  base: saved,
  sending: [],
  seq: 0,
  dropped: 0,
  conflict: null,
  refusedBy: undefined,
  chained: null,
})

/** The text a field in state `s` shows. */
export const draftText = <T>(s: DraftState<T>, form: DraftForm<T>): string =>
  s.draft ?? form.text(s.saved)

/** Whether the field in state `s` holds typed text that is not saved: a
    draft that differs from its base, or one that waits on a conflict. */
export const draftUnsaved = <T>(s: DraftState<T>, form: DraftForm<T>): boolean =>
  s.draft !== null && (s.conflict !== null || !form.same(s.draft, form.text(s.base)))

/** State `s` after action `a`. An action for another key changes nothing. */
export function draftReduce<T>(
  s: DraftState<T>,
  a: DraftAction<T>,
  form: DraftForm<T>,
): DraftState<T> {
  if (a.key !== s.key) return s
  const reads = (text: string, value: T) => form.same(text, form.text(value))
  const same = (x: T, y: T) => reads(form.text(x), y)
  // the draft goes, and the field shows `saved` again
  const untouched = (next: DraftState<T>): DraftState<T> => ({
    ...next,
    draft: null,
    base: next.saved,
    conflict: null,
    refusedBy: undefined,
  })
  switch (a.type) {
    case 'saved': {
      const next = { ...s, saved: a.value }
      // the session's own value, painted or delivered
      let own = s.sending.length - 1
      while (own >= 0 && !same(s.sending[own].value, a.value)) own--
      if (own >= 0) {
        const mine = { ...next, sending: s.sending.slice(own + 1) }
        // an older save of this session: the newer one answers for the draft
        if (own < s.sending.length - 1) return mine
        const acked = {
          ...mine,
          base: a.value,
          conflict: null,
          refusedBy: undefined,
          chained: null,
        }
        return s.draft !== null && reads(s.draft, a.value) ? untouched(acked) : acked
      }
      // an untouched field follows, as does a draft that reads as the new
      // value, which it then simply is, or as its base, unless a conflict
      // waits: then only Use saved or Keep mine lets the draft go
      if (
        s.draft === null ||
        reads(s.draft, a.value) ||
        (s.conflict === null && reads(s.draft, s.base))
      )
        return untouched(next)
      // back to the value the draft began from: nothing conflicts now
      if (same(a.value, s.base)) return { ...next, base: a.value, conflict: null }
      return {
        ...next,
        conflict: { value: a.value, by: s.refusedBy ?? null },
        refusedBy: undefined,
      }
    }
    case 'edit':
      // a draft begins from the saved value on screen
      return { ...s, draft: a.text, base: s.draft === null ? s.saved : s.base }
    case 'send':
      return { ...s, sending: [...s.sending, { seq: a.seq, value: a.value }], seq: a.seq }
    case 'accepted': {
      const sending = s.sending.filter((sent) => sent.seq !== a.seq)
      // already seen as a saved value, or an older save
      if (sending.length === s.sending.length || a.seq !== s.seq) return { ...s, sending }
      const next = { ...s, sending, base: a.value, chained: null }
      if (s.draft === null || !reads(s.draft, a.value)) return next
      // nothing typed since: a later value shows as it comes, and until the
      // server's value arrives the field keeps showing the saved text
      return same(s.saved, a.seen) ? next : untouched(next)
    }
    case 'refused': {
      const sending = s.sending.filter((sent) => sent.seq !== a.seq)
      if (a.seq <= s.dropped) return { ...s, sending }
      // an older save: the newer one began from its value and answers for
      // the draft, going back to the oldest refused save's base
      if (a.seq !== s.seq) {
        const chained = s.chained ?? { seen: a.seen, values: [] }
        return { ...s, sending, chained: { ...chained, values: [...chained.values, a.value] } }
      }
      const seen = s.chained ? s.chained.seen : a.seen
      const own = [a.value, ...(s.chained?.values ?? [])]
      const draft = s.draft ?? form.text(a.value)
      const next = {
        ...s,
        sending,
        draft,
        base: seen,
        conflict: null,
        refusedBy: undefined,
        chained: null,
      }
      // the value the server keeps may show already; the session's own
      // value, still painted, is not it
      if (
        !same(s.saved, seen) &&
        !own.some((value) => same(s.saved, value)) &&
        !reads(draft, s.saved)
      )
        return { ...next, conflict: { value: s.saved, by: a.by ?? null } }
      return { ...next, refusedBy: a.by }
    }
    case 'discard':
      return untouched({ ...s, sending: [], dropped: s.seq, chained: null })
    case 'showSaved':
      return s.draft === null ? s : untouched(s)
    case 'keepMine':
      return { ...s, base: s.saved, conflict: null, refusedBy: undefined }
  }
}

/** What a field gives the store with a save, and tells the field of its
    answer. Each answer counts once: the first of keepDraft, keepUnsaved,
    accepted and refused. */
export type DraftSave<T> = {
  /** The base the save began from, which goes out as the value seen. */
  seen: T
  /** For the store's keepDraft: the server refused because someone else
      changed the value first, written by `by`. True while the field still
      holds the draft. */
  keepDraft: (shown?: unknown, by?: Writer) => boolean
  /** For the store's keepUnsaved: any other refusal. */
  keepUnsaved: () => void
  /** For a save the field awaits: the server took it. */
  accepted: () => void
  /** For a save the field awaits: the server refused it. */
  refused: () => void
  /** The store's options for the save of the row's field `field`: `seen`
      keyed by that field, with keepDraft and keepUnsaved. */
  as: (field: string) => {
    seen: Record<string, T>
    keepDraft: (shown?: unknown, by?: Writer) => boolean
    keepUnsaved: () => void
  }
}

/** A field's draft on the model above, for record and field `key` with
    `saved` stored. While the field holds typed text it holds the close
    warning's lease, named `what`, whose Discard drops the draft, and holds
    back a version reload. A save in flight holds both through the store
    (lib/updateSafety beginUpdateBlock and Convex's own count). `off`, for
    a disabled field, shows the saved value and holds nothing. */
export function useSavedDraft<T>(
  key: string,
  saved: T,
  form: DraftForm<T>,
  what = 'text',
  off = false,
) {
  const [state, dispatch] = useReducer(
    (s: DraftState<T>, a: DraftAction<T> | { type: 'reset'; key: string; value: T }) =>
      a.type === 'reset' ? draftStart(a.key, a.value) : draftReduce(s, a, form),
    undefined,
    () => draftStart(key, saved),
  )
  // another record starts untouched; a new saved value goes through the
  // rule, after any answer the store gave meanwhile
  if (state.key !== key) dispatch({ type: 'reset', key, value: saved })
  else if (!Object.is(state.saved, saved)) dispatch({ type: 'saved', key, value: saved })
  // the key the field shows now, and its state, for a late answer to a
  // save made earlier
  const shown = useRef({ key, mounted: true })
  const latest = useRef(state)
  useLayoutEffect(() => {
    latest.current = state
  })
  useLayoutEffect(() => {
    shown.current = { key, mounted: true }
    return () => {
      shown.current = { key, mounted: false }
    }
  }, [key])
  const seq = useRef(0)
  const unsaved = !off && draftUnsaved(state, form)
  useUnsaved(unsaved, what, undefined, () => dispatch({ type: 'discard', key: shown.current.key }))
  useUpdateBlocker(unsaved)
  const conflictId = useId()
  return {
    /** What the input shows. */
    text: off ? form.text(saved) : draftText(state, form),
    /** Whether the field holds typed text that is not saved. */
    unsaved,
    /** The saved value that changed while the person typed, until they
        choose Use saved or Keep mine. */
    conflict: off ? null : state.conflict,
    /** The id of the conflict's line, for the input's aria-describedby. */
    conflictId,
    /** Whether `text` saves as the saved value. */
    isSaved: (text: string) => form.same(text, form.text(saved)),
    edit: (text: string) => dispatch({ type: 'edit', key, text }),
    /** Use saved: the draft goes, and a refusal of a save in flight brings
        nothing back. */
    discard: () => dispatch({ type: 'discard', key }),
    /** For a draft the field puts back without the person asking, such as
        one that reads as the saved value: it shows the saved text. */
    showSaved: () => dispatch({ type: 'showSaved', key }),
    keepMine: () => dispatch({ type: 'keepMine', key }),
    /** Starts a save of the draft as `value` and answers what the store
        call takes. Call it only for a save the store sends. */
    save: (value: T): DraftSave<T> => {
      const n = ++seq.current
      const seen = state.base
      dispatch({ type: 'send', key, seq: n, value })
      let answered = false
      // whether the field still shows this save's draft, for the notice
      const answer = (a: DraftAction<T>) => {
        if (answered) return false
        answered = true
        dispatch(a)
        return shown.current.mounted && shown.current.key === key && n > latest.current.dropped
      }
      const keepDraft = (_shown?: unknown, by?: Writer) =>
        answer({ type: 'refused', key, seq: n, value, seen, by: by ?? null })
      const keepUnsaved = () => {
        answer({ type: 'refused', key, seq: n, value, seen })
      }
      return {
        seen,
        keepDraft,
        keepUnsaved,
        accepted: () => {
          answer({ type: 'accepted', key, seq: n, value, seen })
        },
        refused: keepUnsaved,
        as: (field) => ({ seen: { [field]: seen }, keepDraft, keepUnsaved }),
      }
    },
  }
}

/** A field's draft, as useSavedDraft answers it. */
export type SavedDraft<T> = ReturnType<typeof useSavedDraft<T>>

/* --- the stored forms the settings fields compare in */

/** A text the store trims, such as an organization or team name. */
export const TRIMMED: DraftForm<string> = {
  text: (value) => value,
  same: (a, b) => a.trim() === b.trim(),
}

/** A person's name, with runs of spaces collapsed (cleanName). */
export const PERSON_NAME: DraftForm<string> = {
  text: (value) => value,
  same: (a, b) => cleanName(a) === cleanName(b),
}

/** An organization's address, which the store trims and lowercases. */
export const ADDRESS: DraftForm<string> = {
  text: (value) => value,
  same: (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase(),
}

/** An email address as the server stores it (asciiEmail), so case or a
    domain written in Unicode is no change. Unset shows as empty. */
export const EMAIL: DraftForm<string | null | undefined> = {
  text: (value) => value || '',
  same: (a, b) => asciiEmail(a) === asciiEmail(b),
}

/** A whole number that shows `fallback` while unset, such as plannable
    hours. Texts compare as the numbers they are, so 40 and 40.0 are one. */
export function wholeNumber<T extends number | null | undefined>(fallback: number): DraftForm<T> {
  return {
    text: (value) => String(value || fallback),
    same: (a, b) =>
      a.trim() === b.trim() || (a.trim() !== '' && b.trim() !== '' && Number(a) === Number(b)),
  }
}
