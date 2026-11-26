/* Remaining hours: empty clears, zero is a value, invalid text does not write.
   Number inputs sanitize malformed text to an empty value, so callers must
   also pass validity.badInput to avoid turning a parse failure into a clear.
   Finite negatives reach the server's typed refusal and shared rollback. */

export type RemainingPatch = { write: boolean; value: number | null }

/** The hours that text `raw` names: null where it is empty, undefined where
    it is not a number. One "," reads as the decimal point, as a keypad in a
    region that writes decimals with a comma types it. */
export function remainingNumber(raw: string | null | undefined): number | null | undefined {
  const s = String(raw == null ? '' : raw).trim()
  if (s === '') return null
  const commas = s.split(',').length - 1
  const value = Number(commas === 1 && !s.includes('.') ? s.replace(',', '.') : s)
  return Number.isFinite(value) ? value : undefined
}

/** Read a Remaining input's raw text against the stored value.
    `write: false` means leave the issue alone (unparseable or unchanged);
    otherwise `value` is the patch — `null` clears the field.
    `badInput` is the element's own verdict: text it could not parse, which
    it has already replaced with "" (see the header) — never a clear. */
export function remainingPatch(
  raw: string | null | undefined,
  current: number | null | undefined,
  badInput = false,
): RemainingPatch {
  if (badInput) return { write: false, value: null }
  const value = remainingNumber(raw)
  if (value === undefined) return { write: false, value: null }
  const cur = current == null ? null : current
  return { write: value !== cur, value }
}

/** The call sites' entry point: reads the value AND the element's parse
    verdict, so unparseable text can't masquerade as an emptied box. */
export function remainingPatchFromInput(
  el: { value: string; validity?: { badInput: boolean } },
  current: number | null | undefined,
): RemainingPatch {
  return remainingPatch(el.value, current, !!el.validity?.badInput)
}

/** Same rule for the create path, which wants `undefined` (no column value)
    rather than `null` (an explicit clear) when the box was left empty. */
export function remainingCreate(raw: string | null | undefined): number | undefined {
  const p = remainingPatch(raw, undefined)
  return p.value == null ? undefined : p.value
}

/** What the input should display for a stored value: a plain empty string
    when unset, so the placeholder shows — but `0` renders as "0". */
export function remainingValue(current: unknown): string | number {
  return current == null ? '' : (current as number)
}
