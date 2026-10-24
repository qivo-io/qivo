/* Copied from get-convex/better-auth src/client/adapter-utils.ts at 3f41cbcf
 * (Apache-2.0, see ../../LICENSE). Qivo changed it:
 * - A unique constraint may span several fields: Better Auth 1.7 declares
 *   table-level unique indexes, such as oauthClientResource's
 *   (clientId, resourceId), and checkUniqueFields enforces them, as
 *   get-convex/better-auth#430 does.
 * - An `eq null` clause also matches a field that is absent, and `ne null`
 *   only a field that holds a value, since Convex stores an unset optional
 *   field as absent (as #430 does). Such a clause never picks an index,
 *   because an index lookup on null does not find absent fields; it is
 *   applied to each document instead. Better Auth 1.7 sends these clauses,
 *   for example to rotate a refresh token that is not yet revoked.
 * - When no index starts with every equality clause of a query, it uses the
 *   index that covers the most of them and filters the rest, instead of
 *   reading the whole table. Better Auth 1.7 looks a password account up by
 *   accountId, providerId and userId, which no generated index starts with.
 * - An `in` clause the query does not expand is applied to each document.
 *   Upstream expands only the first one and dropped the others.
 * - listOne reads on past a page that holds no match until it finds one or
 *   reaches the end. A page stops after 200 documents, so a first match
 *   further on was missed.
 * - Types replace `any`, and common-tags is not used. */

import type { BetterAuthDBSchema } from 'better-auth/db'
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  GenericDatabaseReader,
  GenericDataModel,
  GenericQueryCtx,
  GenericSchema,
  IndexRange,
  PaginationOptions,
  PaginationResult,
  SchemaDefinition,
} from 'convex/server'
import type { GenericId, Infer, Value } from 'convex/values'
import { v } from 'convex/values'
import { asyncMap } from 'convex-helpers'
import { mergedStream, stream } from 'convex-helpers/server/stream'

export type AnySchema = SchemaDefinition<GenericSchema, true>
type Doc = DocumentByName<GenericDataModel, string>

/** The index range builder, for fields only known at run time. */
type RangeBuilder = {
  eq(field: string, value: Value): RangeBuilder
  lt(field: string, value: Value): RangeBuilder
  lte(field: string, value: Value): RangeBuilder
  gt(field: string, value: Value): RangeBuilder
  gte(field: string, value: Value): RangeBuilder
}

export const adapterWhereValidator = v.object({
  field: v.string(),
  operator: v.optional(
    v.union(
      v.literal('lt'),
      v.literal('lte'),
      v.literal('gt'),
      v.literal('gte'),
      v.literal('eq'),
      v.literal('in'),
      v.literal('not_in'),
      v.literal('ne'),
      v.literal('contains'),
      v.literal('starts_with'),
      v.literal('ends_with'),
    ),
  ),
  value: v.union(
    v.string(),
    v.number(),
    v.boolean(),
    v.array(v.string()),
    v.array(v.number()),
    v.null(),
  ),
  connector: v.optional(v.union(v.literal('AND'), v.literal('OR'))),
  mode: v.optional(v.union(v.literal('sensitive'), v.literal('insensitive'))),
})
type Where = Infer<typeof adapterWhereValidator>

export const adapterArgsValidator = v.object({
  model: v.string(),
  where: v.optional(v.array(adapterWhereValidator)),
  sortBy: v.optional(
    v.object({ field: v.string(), direction: v.union(v.literal('asc'), v.literal('desc')) }),
  ),
  select: v.optional(v.array(v.string())),
  limit: v.optional(v.number()),
  offset: v.optional(v.number()),
})
type AdapterArgs = Infer<typeof adapterArgsValidator>

/** Whether a clause asks for a field that is null or absent. */
const matchesAbsent = (w: Where) => (!w.operator || w.operator === 'eq') && w.value === null

/** The model's unique constraints, each a list of the fields that together
 * must be unique: every unique field alone, then every unique index. */
const getUniqueConstraints = (betterAuthSchema: BetterAuthDBSchema, model: string) => {
  const table = Object.values(betterAuthSchema).find((value) => value.modelName === model)
  if (!table) return []
  const singleFieldConstraints = Object.entries(table.fields)
    .filter(([, value]) => value.unique)
    .map(([key, value]) => [value.fieldName ?? key])
  const tableConstraints =
    table.indexes
      ?.filter((index) => index.unique)
      .map((index) => index.fields.map((field) => table.fields[field]?.fieldName ?? field)) ?? []
  return [...singleFieldConstraints, ...tableConstraints]
}

const isUniqueField = (betterAuthSchema: BetterAuthDBSchema, model: string, field: string) =>
  getUniqueConstraints(betterAuthSchema, model).some(
    (constraint) => constraint.length === 1 && constraint[0] === field,
  )

/** Whether the input sets every field of one of the model's unique constraints. */
export const hasUniqueFields = (
  betterAuthSchema: BetterAuthDBSchema,
  model: string,
  input: Record<string, unknown>,
) => {
  const inputFields = new Set(Object.keys(input))
  return getUniqueConstraints(betterAuthSchema, model).some((constraint) =>
    constraint.every((field) => inputFields.has(field)),
  )
}

const findIndex = (
  schema: AnySchema,
  args: { model: string; where?: Where[]; sortBy?: { field: string; direction: 'asc' | 'desc' } },
) => {
  if ((args.where?.length ?? 0) > 1 && args.where?.some((w) => w.connector === 'OR')) {
    throw new Error(
      `OR connector not supported with multiple where statements in findIndex, split up the where statements before calling findIndex: ${JSON.stringify(args.where)}`,
    )
  }
  const where = args.where?.filter(
    (w) =>
      (!w.operator || ['lt', 'lte', 'gt', 'gte', 'eq', 'in', 'not_in'].includes(w.operator)) &&
      w.field !== '_id' &&
      !matchesAbsent(w),
  )
  if (!where?.length && !args.sortBy) return
  const lowerBounds = where?.filter((w) => w.operator === 'lt' || w.operator === 'lte') ?? []
  if (lowerBounds.length > 1) {
    throw new Error(`cannot have more than one lower bound where clause: ${JSON.stringify(where)}`)
  }
  const upperBounds = where?.filter((w) => w.operator === 'gt' || w.operator === 'gte') ?? []
  if (upperBounds.length > 1) {
    throw new Error(`cannot have more than one upper bound where clause: ${JSON.stringify(where)}`)
  }
  const lowerBound = lowerBounds[0]
  const upperBound = upperBounds[0]
  if (lowerBound && upperBound && lowerBound.field !== upperBound.field) {
    throw new Error(
      `lower bound and upper bound must have the same field: ${JSON.stringify(where)}`,
    )
  }
  const boundField = lowerBound?.field || upperBound?.field
  if (
    boundField &&
    where?.some((w) => w.field === boundField && w !== lowerBound && w !== upperBound)
  ) {
    throw new Error(`too many where clauses on the bound field: ${JSON.stringify(where)}`)
  }
  const indexEqFields =
    where
      ?.filter((w) => !w.operator || w.operator === 'eq')
      .sort((a, b) => a.field.localeCompare(b.field))
      .map((w) => [w.field, w.value] as const) ?? []
  if (!indexEqFields.length && !boundField && !args.sortBy) return
  const table = schema.tables[args.model]
  if (!table) throw new Error(`Table ${args.model} not found`)
  const indexes = table[' indexes']()
  const sortField = args.sortBy?.field

  // We internally use _creationTime in place of Better Auth's createdAt
  const indexFields = indexEqFields
    .map(([field]) => field)
    .concat(boundField && boundField !== 'createdAt' ? boundField : '')
    .concat(sortField && sortField !== 'createdAt' && boundField !== sortField ? sortField : '')
    .filter(Boolean)
  if (!indexFields.length && !boundField && !sortField) return
  // Use the built in _creationTime index if bounding or sorting by createdAt
  // with no other fields
  const index = !indexFields.length
    ? { indexDescriptor: 'by_creation_time', fields: [] as string[] }
    : indexes.find(({ fields }) => {
        const fieldsMatch = indexFields.every((field, idx) => field === fields[idx])
        // If sorting by createdAt, no intermediate fields can be on the index
        // as they may override the createdAt sort order.
        const boundFieldMatch =
          boundField === 'createdAt' || sortField === 'createdAt'
            ? indexFields.length === fields.length
            : true
        return fieldsMatch && boundFieldMatch
      })
  const eqValues = new Map(indexEqFields)
  // With only equality clauses and no index that starts with all of them, use
  // the index whose leading fields cover the most of them; the clauses it
  // leaves out are applied to each document (generateQuery).
  const partial =
    index || boundField || sortField
      ? undefined
      : indexes
          .map(({ indexDescriptor, fields }) => {
            const covered = fields.findIndex((field) => !eqValues.has(field))
            return {
              indexDescriptor,
              fields: fields.slice(0, covered === -1 ? fields.length : covered),
            }
          })
          .filter(({ fields }) => fields.length > 0)
          .sort((a, b) => b.fields.length - a.fields.length)[0]
  const chosen = index ?? partial
  if (!chosen) return { indexFields }
  const eqFields = index ? indexEqFields.map(([field]) => field) : chosen.fields
  return {
    index: {
      indexDescriptor: chosen.indexDescriptor,
      fields: [...chosen.fields, '_creationTime'],
    },
    eqFields,
    boundField,
    sortField,
    values: {
      eq: eqFields.map((field) => eqValues.get(field) ?? null),
      lt: lowerBound?.operator === 'lt' ? lowerBound.value : undefined,
      lte: lowerBound?.operator === 'lte' ? lowerBound.value : undefined,
      gt: upperBound?.operator === 'gt' ? upperBound.value : undefined,
      gte: upperBound?.operator === 'gte' ? upperBound.value : undefined,
    },
  }
}

/** Throws when the input would give a document the same values as another
 * document for one of the model's unique constraints. `doc` is the document
 * being updated, if any. */
export const checkUniqueFields = async (
  ctx: GenericQueryCtx<GenericDataModel>,
  schema: AnySchema,
  betterAuthSchema: BetterAuthDBSchema,
  table: string,
  input: Record<string, unknown>,
  doc?: Doc,
) => {
  const mergedDoc: Record<string, unknown> = { ...doc, ...input }
  for (const constraint of getUniqueConstraints(betterAuthSchema, table)) {
    if (
      !constraint.some((field) => field in input) ||
      !constraint.every((field) => mergedDoc[field] !== undefined && mergedDoc[field] !== null)
    ) {
      continue
    }
    const { index } =
      findIndex(schema, {
        model: table,
        where: constraint.map((field) => ({
          field,
          operator: 'eq' as const,
          value: mergedDoc[field] as Where['value'],
        })),
      }) ?? {}
    const indexConstraintFields = index?.fields.slice(0, constraint.length) ?? []
    if (!index || !constraint.every((field) => indexConstraintFields.includes(field))) {
      throw new Error(`No index found for unique constraint ${table}.${constraint.join('+')}`)
    }
    const existingDocs = await ctx.db
      .query(table)
      .withIndex(
        index.indexDescriptor,
        (q) =>
          indexConstraintFields.reduce(
            (range, field) => range.eq(field, mergedDoc[field] as Value),
            q as unknown as RangeBuilder,
          ) as unknown as IndexRange,
      )
      .take(2)
    if (existingDocs.some((existingDoc) => existingDoc._id !== doc?._id)) {
      const constraintName =
        constraint.length === 1 ? constraint[0] : `unique constraint ${constraint.join('+')}`
      throw new Error(`${table} ${constraintName} already exists`)
    }
  }
}

/** Keeps only the selected fields of a document, or the whole document when
 * there is no selection. */
export const selectFields = <D extends Doc>(doc: D | null, select?: string[]) => {
  if (!doc) return null
  if (!select?.length) return doc
  return select.reduce<Record<string, unknown>>((acc, field) => {
    // Better Auth may request "id" while Convex stores it as "_id".
    // Keep the raw field key here and let Better Auth map "_id" -> "id".
    const sourceField = field === 'id' && '_id' in doc ? '_id' : field
    acc[sourceField] = doc[sourceField]
    return acc
  }, {}) as D
}

// Manually filter an individual document by where clauses. This is used to
// simplify queries that can only return 0 or 1 documents, or "in" clauses that
// query multiple single documents in parallel.
const filterByWhere = (
  doc: Doc | null,
  where?: Where[],
  // Optionally filter which where clauses to apply.
  filterWhere?: (w: Where) => boolean,
) => {
  if (!doc) return false
  for (const w of where ?? []) {
    if (filterWhere && !filterWhere(w)) continue
    const value = doc[w.field] as Where['value'] | undefined
    const isLessThan = (val: typeof value, wVal: typeof w.value) => {
      if (wVal === undefined || wVal === null) return false
      if (val === undefined || val === null) return true
      return val < wVal
    }
    const isGreaterThan = (val: typeof value, wVal: typeof w.value) => {
      if (val === undefined || val === null) return false
      if (wVal === undefined || wVal === null) return true
      return val > wVal
    }
    const listed = (list: Where['value']) =>
      Array.isArray(list) && (list as unknown[]).includes(value)
    const filter = (w: Where) => {
      switch (w.operator) {
        case undefined:
        case 'eq':
          return w.value === null ? value == null : value === w.value
        case 'in':
          return listed(w.value)
        case 'not_in':
          return Array.isArray(w.value) && !listed(w.value)
        case 'lt':
          return isLessThan(value, w.value)
        case 'lte':
          return value === w.value || isLessThan(value, w.value)
        case 'gt':
          return isGreaterThan(value, w.value)
        case 'gte':
          return value === w.value || isGreaterThan(value, w.value)
        case 'ne':
          return w.value === null ? value != null : value !== w.value
        case 'contains':
          return typeof value === 'string' && value.includes(w.value as string)
        case 'starts_with':
          return typeof value === 'string' && value.startsWith(w.value as string)
        case 'ends_with':
          return typeof value === 'string' && value.endsWith(w.value as string)
      }
    }
    if (!filter(w)) return false
  }
  return true
}

const generateQuery = (
  ctx: GenericQueryCtx<GenericDataModel>,
  schema: AnySchema,
  args: AdapterArgs,
) => {
  const { index, values, boundField, indexFields, eqFields } = findIndex(schema, args) ?? {}
  const usableIndex = index?.indexDescriptor === 'by_creation_time' ? undefined : index
  const db = ctx.db as unknown as GenericDatabaseReader<DataModelFromSchemaDefinition<AnySchema>>
  const query = stream(db, schema).query(args.model)
  const hasValues =
    (values?.eq?.length ?? 0) > 0 ||
    values?.lt !== undefined ||
    values?.lte !== undefined ||
    values?.gt !== undefined ||
    values?.gte !== undefined
  const indexedQuery = usableIndex
    ? query.withIndex(
        // The schema is only known at run time, so its index names type as
        // the system ones.
        usableIndex.indexDescriptor as 'by_creation_time',
        hasValues
          ? (q) => {
              let range = q as unknown as RangeBuilder
              for (const [idx, value] of (values?.eq ?? []).entries()) {
                range = range.eq(usableIndex.fields[idx], value)
              }
              const bound = boundField ?? ''
              if (values?.lt !== undefined) range = range.lt(bound, values.lt)
              if (values?.lte !== undefined) range = range.lte(bound, values.lte)
              if (values?.gt !== undefined) range = range.gt(bound, values.gt)
              if (values?.gte !== undefined) range = range.gte(bound, values.gte)
              return range as unknown as IndexRange
            }
          : undefined,
      )
    : query
  const orderedQuery = args.sortBy
    ? indexedQuery.order(args.sortBy.direction === 'desc' ? 'desc' : 'asc')
    : indexedQuery
  if (!usableIndex && indexFields?.length) {
    console.warn(
      `Querying without an index on table "${args.model}".\n` +
        'This can cause performance issues, and may hit the document read limit.\n' +
        'To fix, add an index that begins with the following fields in order:\n' +
        `[${indexFields.join(', ')}]`,
    )
  }
  return orderedQuery.filterWith(async (doc) => {
    // No usable index, handle all where clauses statically.
    if (!usableIndex) return filterByWhere(doc, args.where)
    // Index used for all eq and range clauses, apply remaining clauses
    // incompatible with Convex statically.
    return filterByWhere(
      doc,
      args.where,
      (w) =>
        matchesAbsent(w) ||
        ((!w.operator || w.operator === 'eq') && !eqFields?.includes(w.field)) ||
        (w.operator !== undefined &&
          ['in', 'contains', 'starts_with', 'ends_with', 'ne', 'not_in'].includes(w.operator)),
    )
  })
}

// This is the core function for reading from the database, it parses and
// validates where conditions, selects indexes, and allows the caller to
// optionally paginate as needed. Every response is a pagination result.
export const paginate = async (
  ctx: GenericQueryCtx<GenericDataModel>,
  schema: AnySchema,
  betterAuthSchema: BetterAuthDBSchema,
  args: AdapterArgs & { paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc>> => {
  if (args.offset) throw new Error(`offset not supported: ${JSON.stringify(args.offset)}`)
  if (args.where?.some((w) => w.connector === 'OR') && args.where?.length > 1) {
    throw new Error(
      `OR connector not supported with multiple where statements in paginate, split up the where statements before calling paginate: ${JSON.stringify(args.where)}`,
    )
  }
  if (
    args.where?.some(
      (w) => w.field === '_id' && w.operator && !['eq', 'in', 'not_in'].includes(w.operator),
    )
  ) {
    throw new Error(
      `_id can only be used with eq, in, or not_in operator: ${JSON.stringify(args.where)}`,
    )
  }
  if (args.where?.some((w) => w.mode === 'insensitive')) {
    throw new Error(
      `Case-insensitive queries (mode: "insensitive") are not supported by the Convex adapter. Store values in a normalized form (e.g. lowercase on write) and query against the normalized value.`,
    )
  }
  // If any where clause is "eq" (or missing operator) on a unique field,
  // we can only return a single document, so we get it and use any other
  // where clauses as static filters.
  const uniqueWhere = args.where?.find(
    (w) =>
      (!w.operator || w.operator === 'eq') &&
      w.value !== null &&
      (isUniqueField(betterAuthSchema, args.model, w.field) || w.field === '_id'),
  )
  if (uniqueWhere) {
    const { index } = findIndex(schema, { model: args.model, where: [uniqueWhere] }) ?? {}
    if (uniqueWhere.field !== '_id' && !index) {
      throw new Error(`No index found for ${args.model}.${uniqueWhere.field}`)
    }
    const doc =
      uniqueWhere.field === '_id'
        ? await ctx.db.get(uniqueWhere.value as GenericId<string>)
        : await ctx.db
            .query(args.model)
            .withIndex(index?.indexDescriptor ?? '', (q) =>
              q.eq(index?.fields[0] ?? '', uniqueWhere.value),
            )
            .unique()

    // Apply all other clauses as static filters to our 0 or 1 result.
    const page = filterByWhere(doc, args.where, (w) => w !== uniqueWhere)
      ? [selectFields(doc, args.select)].filter((d): d is Doc => d !== null)
      : []
    return { page, isDone: true, continueCursor: '' }
  }

  const paginationOpts = {
    ...args.paginationOpts,
    // If maximumRowsRead is not at least 1 higher than numItems, bad cursors
    // and incorrect paging will result (at least with convex-test).
    maximumRowsRead: Math.max((args.paginationOpts.numItems ?? 0) + 1, 200),
  }

  // Large queries using "in" clause will crash, but these are only currently
  // possible with the organization plugin listing all members with a high
  // limit. For cases like this we need to create proper convex queries in
  // the component as an alternative to using Better Auth api's.
  const inWhere = args.where?.find((w) => w.operator === 'in')
  if (inWhere) {
    if (!Array.isArray(inWhere.value)) throw new Error('in clause value must be an array')
    // For ids, just use asyncMap + .get()
    if (inWhere.field === '_id') {
      const docs = await asyncMap(inWhere.value as string[], async (value) =>
        ctx.db.get(value as GenericId<string>),
      )
      const filteredDocs = docs
        .flatMap((doc) => (doc ? [doc] : []))
        .filter((doc) => filterByWhere(doc, args.where, (w) => w !== inWhere))
      const sortBy = args.sortBy
      return {
        page: filteredDocs
          .sort((a, b) => {
            if (sortBy?.field === 'createdAt') {
              return sortBy.direction === 'asc'
                ? (a._creationTime as number) - (b._creationTime as number)
                : (b._creationTime as number) - (a._creationTime as number)
            }
            if (sortBy) {
              const aValue = a[sortBy.field] as Where['value']
              const bValue = b[sortBy.field] as Where['value']
              if (aValue === bValue) return 0
              const greater = (aValue as string | number) > (bValue as string | number)
              return sortBy.direction === 'asc' ? (greater ? 1 : -1) : greater ? -1 : 1
            }
            return 0
          })
          .map((doc) => selectFields(doc, args.select))
          .flatMap((doc) => (doc ? [doc] : [])),
        isDone: true,
        continueCursor: '',
      }
    }
    const streams = inWhere.value.map((value) =>
      generateQuery(ctx, schema, {
        ...args,
        where: args.where?.map((w) => (w === inWhere ? { ...w, operator: 'eq', value } : w)),
      }),
    )
    const result = await mergedStream(
      streams,
      [args.sortBy?.field !== 'createdAt' && args.sortBy?.field, '_creationTime'].flatMap((f) =>
        f ? [f] : [],
      ),
    ).paginate(paginationOpts)
    return {
      ...result,
      page: result.page.flatMap((doc) => {
        const selected = selectFields(doc, args.select)
        return selected ? [selected] : []
      }),
    }
  }

  const result = await generateQuery(ctx, schema, args).paginate(paginationOpts)
  return {
    ...result,
    page: result.page.flatMap((doc) => {
      const selected = selectFields(doc, args.select)
      return selected ? [selected] : []
    }),
  }
}

/** The first document that matches, or null. A page that ends before it
 * finds a match is not the end, so it reads on until it finds one or reaches
 * the end. */
export const listOne = async (
  ctx: GenericQueryCtx<GenericDataModel>,
  schema: AnySchema,
  betterAuthSchema: BetterAuthDBSchema,
  args: AdapterArgs,
): Promise<Doc | null> => {
  let cursor: string | null = null
  for (;;) {
    const result: PaginationResult<Doc> = await paginate(ctx, schema, betterAuthSchema, {
      ...args,
      paginationOpts: { numItems: 1, cursor },
    })
    if (result.page[0]) return result.page[0]
    if (result.isDone) return null
    cursor = result.continueCursor
  }
}
