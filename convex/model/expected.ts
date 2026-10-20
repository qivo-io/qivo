/* The field check. An edit to an existing shared record may carry
 * `expected`, the values its sender last read for the fields the edit
 * changes. In the same transaction, before the first write, the record's core
 * compares each of them with what it stores (assertExpected). If someone
 * else changed one of those fields since, the core refuses the whole edit
 * with `conflict` and the reason FIELD_CHANGED, and writes nothing. Without
 * `expected` an edit saves as before. The app always sends it; REST and MCP
 * accept it as an optional field (parseExpected).
 *
 * The rule, for each key F: the edit is refused when the value seen differs
 * from the stored one AND the value the edit would store differs from it
 * too. So two people choosing the same value pass, a value changed and
 * changed back passes, and a person's own quick edits in a row pass, because
 * one client's mutations run in order. Values compare in their compare form
 * (Field.form), so a trimmed name or rounded hours never refuse falsely, and
 * in the form the caller's surface reads them (Field.stored with View). The
 * app sends a long text's print instead of the text (lib/fieldPrints.ts).
 *
 * Each record kind's table of fields lives beside its core (for example
 * model/issues.ts TASK_FIELDS), which reads its own stored forms. */

import { ConvexError, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { FIELD_CHANGED, printOf } from '../lib/fieldPrints'
import { badRequest, type FieldChange, type Refusal } from '../lib/functions'

export { FIELD_CHANGED }

/** Which surface reads the value: the app's snapshot, or a REST or MCP read. */
export type View = 'app' | 'machine'

/** The kind of record a refusal is about. */
export type FieldRecord = FieldChange['record']

/** What reading a stored form may need besides the row. */
export type Read = { ctx: QueryCtx; me: Doc<'profiles'>; view: View }

/** The values REST and MCP may send for a key, how a refusal says so, and
 * the key's JSON Schema in MCP's tool list. */
export type KeyType = {
  ok: (value: unknown) => boolean
  says: string
  schema: Readonly<Record<string, unknown>>
}

/** How the check treats one key of `expected` for one record kind. */
export type Field<Row> = {
  /** The REST and MCP request field that owns the key, for the sentences. */
  sends: string
  type: KeyType
  /** The compare form. Null, undefined and absent are all null. */
  form: (value: unknown) => unknown
  /** The stored value as the caller's surface reads it. Defaults to the
   * row's own field of the key's name. */
  stored?: (row: Row, read: Read) => unknown
  /** The app sends the print of the compare form instead of the value. */
  printed?: true
  /** The other key of a pair that must come together and compare as one
   * value (a task's parent_id and has_hidden_parent). The first key of the
   * pair carries `compare`. */
  pair?: string
  /** A rule of the request's shape across keys: a refusal sentence, or
   * undefined when `expected` keeps it. */
  shape?: (expected: Readonly<Record<string, unknown>>) => string | undefined
  /** A comparison of its own, for a pair: whether the seen value matches the
   * stored one, and whether the value the edit stores does. */
  compare?: (a: {
    row: Row
    read: Read
    expected: Readonly<Record<string, unknown>>
    next: Readonly<Record<string, unknown>>
  }) => Promise<{ seen: boolean; next: boolean }>
}

/** A record kind's keys, in the order the sentences list them. */
export type Fields<Row> = Readonly<Record<string, Field<Row>>>

/* --- compare forms and key types, shared by the record tables */

/** The compare form of a value that compares exactly. */
export const exact = (value: unknown): unknown => value ?? null

/** The compare form of an id: lowercase, null for unset. */
export const idForm = (value: unknown): unknown =>
  typeof value === 'string' && value !== '' ? value.toLowerCase() : null

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const orNull = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })

export const TEXT: KeyType = {
  ok: (v) => typeof v === 'string',
  says: 'a string',
  schema: { type: 'string' },
}
export const TEXT_OR_NULL: KeyType = {
  ok: (v) => v === null || typeof v === 'string',
  says: 'a string or null',
  schema: orNull({ type: 'string' }),
}
export const NUMBER: KeyType = {
  ok: (v) => typeof v === 'number' && Number.isFinite(v),
  says: 'a number',
  schema: { type: 'number' },
}
export const NUMBER_OR_NULL: KeyType = {
  ok: (v) => v === null || (typeof v === 'number' && Number.isFinite(v)),
  says: 'a number or null',
  schema: orNull({ type: 'number' }),
}
export const BOOLEAN: KeyType = {
  ok: (v) => typeof v === 'boolean',
  says: 'a boolean',
  schema: { type: 'boolean' },
}
/** One of `values`, or also null when `nullable`. */
export const oneOf = (values: readonly string[], nullable = false): KeyType => ({
  ok: (v) => (nullable && v === null) || (typeof v === 'string' && values.includes(v)),
  says: `one of ${values.join(', ')}${nullable ? ', or null' : ''}`,
  schema: nullable
    ? orNull({ type: 'string', enum: [...values] })
    : { type: 'string', enum: [...values] },
})
/** A uuid naming `what`, or null when `nullable`. */
export const uuidOf = (what: string, nullable: boolean): KeyType => ({
  ok: (v) => (nullable && v === null) || (typeof v === 'string' && UUID.test(v)),
  says: `a ${what} uuid${nullable ? ' or null' : ''}`,
  schema: nullable
    ? orNull({ type: 'string', format: 'uuid' })
    : { type: 'string', format: 'uuid' },
})

/** The validator of a parsed `expected` handed to an internal function
 * (parseExpected checks each key's type first). */
export const vExpected = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.null()),
)

/** The JSON Schema of an MCP tool's `expected` argument over `fields`. */
export const expectedSchema = <Row>(fields: Fields<Row>) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.type.schema])),
})

/** The keys of `fields` whose request field `body` sends. */
export const sentKeys = <Row>(fields: Fields<Row>, body: Readonly<Record<string, unknown>>) =>
  Object.keys(fields).filter((key) => fields[key].sends in body)

/** The sentence an MCP tool description adds for its `expected` argument. */
export const EXPECTED_SENTENCE =
  '`expected` holds the values you last read for fields this call changes; if one of them changed since, nothing is saved and the call says which.'

/** EXPECTED_SENTENCE for a tool that deletes. */
export const EXPECTED_DELETE_SENTENCE =
  '`expected` holds the values you last read; if one of them changed since, nothing is deleted and the call says which.'

/* --- the request's shape */

/** Joins words as people list them: "a", "a and b", "a, b and c". */
export const listed = (words: readonly string[]): string =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`

/* The key rules every surface shares: at least one key, each a key of the
 * record and owned by a field the request sends, and a pair's keys
 * together. `sent` holds the keys whose fields the request sends. */
function checkKeys<Row>(
  fields: Fields<Row>,
  expected: Readonly<Record<string, unknown>>,
  sent: ReadonlySet<string>,
): void {
  const keys = Object.keys(expected)
  if (keys.length === 0) throw badRequest('expected must name at least one field')
  for (const key of keys) {
    const field = fields[key]
    if (field === undefined) {
      throw badRequest(
        `unknown field "expected.${key}"; expected takes ${Object.keys(fields).join(', ')}`,
      )
    }
    if (!sent.has(key)) {
      throw badRequest(`expected.${key} applies only when the request sends ${field.sends}`)
    }
    if (field.pair !== undefined && !(field.pair in expected)) {
      const [first, second] = Object.keys(fields).filter((k) => k === key || k === field.pair)
      throw badRequest(`expected.${first} and expected.${second} go together`)
    }
    const bad = field.shape?.(expected)
    if (bad !== undefined) throw badRequest(bad)
  }
}

/** Validates the `expected` a REST body or an MCP call sent, before anything
 * is looked up or written, and answers it. `raw` is the field as sent,
 * undefined when absent; `sent` holds the keys whose fields the request
 * sends. Each refusal is a bad_request sentence naming the key. */
export function parseExpected<Row>(
  fields: Fields<Row>,
  raw: unknown,
  sent: Iterable<string>,
): Record<string, string | number | boolean | null> | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('expected must be an object of the fields as you last read them')
  }
  const expected = raw as Record<string, unknown>
  for (const [key, value] of Object.entries(expected)) {
    const field = fields[key]
    if (field !== undefined && !field.type.ok(value))
      throw badRequest(`expected.${key} must be ${field.type.says}`)
  }
  checkKeys(fields, expected, new Set(sent))
  // every key type admits only strings, numbers, booleans and null
  return expected as Record<string, string | number | boolean | null>
}

/* --- the comparison */

/* Whether two compare forms are the same value. Forms are JSON values. */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** What an edit stores for each key it sends, or DELETES for a delete,
 * which takes every key and leaves no stored value equal to the seen one. */
export type Next = Readonly<Record<string, unknown>> | typeof DELETES

/** The `next` of a delete (Next). */
export const DELETES = 'delete'

/** The keys of `expected` that conflict for `row` (the rule above), first
 * key of each pair only, in the table's order. `next` holds, for each key the
 * request sends, the value the core will store for it. */
export async function conflictingFields<Row>(
  read: Read,
  fields: Fields<Row>,
  row: Row,
  expected: Readonly<Record<string, unknown>>,
  next: Next,
): Promise<string[]> {
  const out: string[] = []
  for (const [key, field] of Object.entries(fields)) {
    if (!(key in expected)) continue
    if (field.pair !== undefined && field.compare === undefined) continue
    let matches: { seen: boolean; next: boolean }
    if (field.compare !== undefined) {
      matches = await field.compare({ row, read, expected, next: next === DELETES ? {} : next })
      if (next === DELETES) matches.next = false
    } else {
      const stored = field.form(
        field.stored ? await field.stored(row, read) : (row as Record<string, unknown>)[key],
      )
      const seen = expected[key]
      matches = {
        seen:
          field.printed && read.view === 'app'
            ? seen === printOf(stored)
            : same(field.form(seen), stored),
        next: next !== DELETES && same(field.form(next[key]), stored),
      }
    }
    if (!matches.seen && !matches.next) out.push(key)
  }
  return out
}

/** Who wrote each of `fields` as it is stored now, where the server can
 * prove it; a missing field is unknown. */
export type Writers = ReadonlyMap<string, { by: string; at: string }>

/** What one record's check needs. `label` names the record in the refusal
 * sentence, such as "QN-12" or `project WEB`. `next` holds, for each key the
 * request sends, the value the core will store for it (conflictingFields),
 * and `writers` finds who changed the fields that conflict. */
export type Check<Row> = {
  read: Read
  fields: Fields<Row>
  record: FieldRecord
  id: string
  of?: string
  label: string
  row: Row
  expected: Readonly<Record<string, unknown>> | undefined
  next: Next
  writers?: (fields: readonly string[]) => Promise<Writers>
}

/** Refuses the edit when a field of `expected` changed since its sender
 * read it, and does nothing without `expected`. Callers run it after their
 * permission checks, so a refused caller learns nothing, and before their
 * first write. The refusal is a `conflict` with reason FIELD_CHANGED, a
 * sentence for REST and MCP and `changes`, the fields for the app. */
export async function assertExpected<Row>(c: Check<Row>): Promise<void> {
  if (c.expected === undefined) return
  checkKeys(c.fields, c.expected, new Set(Object.keys(c.next === DELETES ? c.fields : c.next)))
  const keys = await conflictingFields(c.read, c.fields, c.row, c.expected, c.next)
  if (keys.length === 0) return
  const writers = c.writers ? await c.writers(keys) : new Map()
  const changes: FieldChange[] = keys.map((field) => ({
    record: c.record,
    id: c.id,
    ...(c.of !== undefined ? { of: c.of } : {}),
    field,
    by: writers.get(field)?.by ?? null,
    at: writers.get(field)?.at ?? null,
  }))
  const words = [...new Set(keys.map((key) => c.fields[key].sends))]
  const people = new Set(changes.map((change) => change.by))
  const one = people.size === 1 ? [...people][0] : null
  const name = one === null ? null : ((await byId(c.read.ctx, 'profiles', one))?.name ?? null)
  const it = words.length === 1 ? 'it' : 'them'
  const rest =
    c.next === DELETES
      ? `since you read ${it}, so nothing was deleted; read ${c.label} again before you delete it`
      : `since you read ${it}, so nothing was saved; read ${c.label} again and resend your change`
  const sentence =
    name !== null
      ? `${name} changed ${listed(words)} of ${c.label} ${rest}`
      : `${listed(words)} of ${c.label} changed ${rest}`
  throw new ConvexError<Refusal>({
    code: 'conflict',
    message: sentence,
    reason: FIELD_CHANGED,
    changes,
  })
}

/** The prints of every key of `fields` whose compare form differs between
 * `before` and `after`, for the activity row of the write (field_prints),
 * or undefined when none differs. */
export function changedPrints<Row>(
  fields: Fields<Row>,
  before: Row,
  after: Row,
): Record<string, string> | undefined {
  const prints: Record<string, string> = {}
  const raw = (row: Row, key: string) => (row as Record<string, unknown>)[key]
  for (const [key, field] of Object.entries(fields)) {
    if (field.pair !== undefined && field.compare === undefined) continue
    const a = field.form(raw(before, key))
    const b = field.form(raw(after, key))
    if (!same(a, b)) prints[key] = printOf(b)
  }
  return Object.keys(prints).length > 0 ? prints : undefined
}
