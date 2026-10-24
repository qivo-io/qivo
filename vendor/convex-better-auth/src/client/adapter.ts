/* Copied from get-convex/better-auth src/client/adapter.ts at 3f41cbcf
 * (Apache-2.0, see ../../LICENSE). Qivo changed it for Better Auth 1.7:
 * - Pagination resumes from continueCursor, never splitCursor, so a page
 *   that stops early is not read twice.
 * - Better Auth 1.7 passes `modelKey` to every adapter method. The adapter
 *   drops it before it calls the component, whose validators refuse unknown
 *   arguments (as get-convex/better-auth#430 does).
 * - consumeOne and incrementOne are native: each runs one component
 *   mutation, deleteOne or incrementOne, so it is atomic. Better Auth's
 *   fallback compares every field of the row it read, which breaks on
 *   `_creationTime` and on fields never written (as #430 does).
 * - The component API is typed by its function references, as in #430, not
 *   by the published component's generated types.
 * - The experimental joins override and remeda are left out; Qivo enables
 *   no joins. Types replace `any`. */
import type { CustomAdapter, DBAdapterDebugLogOption } from 'better-auth/adapters'
import { createAdapterFactory } from 'better-auth/adapters'
import type { Where } from 'better-auth/types'
import type {
  FunctionHandle,
  FunctionReference,
  GenericDataModel,
  GenericSchema,
  PaginationOptions,
  PaginationResult,
  SchemaDefinition,
} from 'convex/server'
import { createFunctionHandle } from 'convex/server'
import { asyncMap } from 'convex-helpers'
import { isRunMutationCtx, requireRunMutationCtx } from '../utils'
import type { AuthFunctions, GenericCtx, Triggers } from './index'

type Row = Record<string, unknown>
type PageResult = Partial<PaginationResult<Row>> & {
  isDone: boolean
  continueCursor: string
  count?: number
}

/** The component functions the adapter calls (convex/betterAuth/adapter.ts). */
export type AdapterApi = {
  create: FunctionReference<'mutation', 'internal'>
  findOne: FunctionReference<'query', 'internal'>
  findMany: FunctionReference<'query', 'internal'>
  updateOne: FunctionReference<'mutation', 'internal'>
  incrementOne: FunctionReference<'mutation', 'internal'>
  updateMany: FunctionReference<'mutation', 'internal'>
  deleteOne: FunctionReference<'mutation', 'internal'>
  deleteMany: FunctionReference<'mutation', 'internal'>
}

/** Collects every page of a paginated component call, up to `limit` rows. */
export const handlePagination = async (
  next: ({ paginationOpts }: { paginationOpts: PaginationOptions }) => Promise<PageResult>,
  { limit, numItems }: { limit?: number; numItems?: number } = {},
) => {
  const state: { isDone: boolean; cursor: string | null; docs: Row[]; count: number } = {
    isDone: false,
    cursor: null,
    docs: [],
    count: 0,
  }
  const onResult = (result: PageResult) => {
    // A page holds every match up to continueCursor, also when it stopped
    // early and suggests a split. Resuming from splitCursor, as upstream
    // does, reads the second half of the page again.
    state.cursor = result.continueCursor
    if (result.page) {
      state.docs.push(...result.page)
      state.isDone = (limit && state.docs.length >= limit) || result.isDone
      return
    }
    // Update and delete only return a count
    if (result.count) {
      state.count += result.count
      state.isDone = (limit && state.count >= limit) || result.isDone
      return
    }
    state.isDone = result.isDone
  }

  do {
    const cursorBeforePage = state.cursor
    const result = await next({
      paginationOpts: {
        // Subtract collected rows so the last page doesn't over-fetch past a
        // caller limit. No limit means an unbounded budget (Infinity, not 200,
        // or collecting 200 makes numItems 0 and the cursor never advances; #392).
        numItems: Math.min(
          numItems ?? 200,
          limit !== undefined ? limit - state.docs.length : Infinity,
          200,
        ),
        cursor: state.cursor,
      },
    })
    onResult(result)
    // A page that returns nothing and doesn't advance the cursor while !isDone
    // can never terminate; fail loudly instead of looping forever.
    const advanced = state.cursor !== cursorBeforePage
    const produced = (result.page?.length ?? 0) > 0 || (result.count ?? 0) > 0
    if (!state.isDone && !advanced && !produced) {
      throw new Error(
        'handlePagination made no forward progress; aborting to avoid an infinite pagination loop',
      )
    }
  } while (!state.isDone)
  return state
}

type ConvexCleanedWhere = Where & {
  value: string | number | boolean | string[] | number[] | null
}

const parseWhere = (where?: Where | Where[]): ConvexCleanedWhere[] => {
  if (!where) return []
  const whereArray = Array.isArray(where) ? where : [where]
  for (const w of whereArray) {
    if (w.mode === 'insensitive') {
      throw new Error(
        `Case-insensitive queries (mode: "insensitive") are not supported by the Convex adapter. Store values in a normalized form (e.g. lowercase on write) and query against the normalized value. Field: ${w.field}`,
      )
    }
  }
  return whereArray.map((w) =>
    w.value instanceof Date ? { ...w, value: w.value.getTime() } : w,
  ) as ConvexCleanedWhere[]
}

type DocWithFlexibleId = { _id?: unknown; id?: unknown }

const getDocId = (doc: DocWithFlexibleId) => {
  if (doc?._id !== undefined && doc?._id !== null) return String(doc._id)
  if (doc?.id !== undefined && doc?.id !== null) return String(doc.id)
  return undefined
}

const dedupeDocsById = <T extends DocWithFlexibleId>(docs: T[]) => {
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const doc of docs) {
    const id = getDocId(doc)
    if (!id) {
      deduped.push(doc)
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    deduped.push(doc)
  }
  return deduped
}

const selectDocFields = (doc: Row, select?: string[]) => {
  if (!select?.length) return doc
  return select.reduce<Row>((acc, field) => {
    // Better Auth may request "id" while Convex stores it as "_id".
    // Keep "_id" so Better Auth output mapping can translate to "id".
    const sourceField = field === 'id' && '_id' in doc ? '_id' : field
    acc[sourceField] = doc[sourceField]
    return acc
  }, {})
}

/** Sorts by one field the way remeda's sortBy did upstream. */
const sortRows = (docs: Row[], field: string, direction: 'asc' | 'desc') =>
  [...docs].sort((a, b) => {
    const left = a[field] as string | number
    const right = b[field] as string | number
    const order = left < right ? -1 : left > right ? 1 : 0
    return direction === 'asc' ? order : -order
  })

/** The Better Auth database adapter that stores its rows in the component. */
export const convexAdapter = <
  DataModel extends GenericDataModel,
  Ctx extends GenericCtx<DataModel> = GenericCtx<DataModel>,
  Schema extends SchemaDefinition<GenericSchema, true> = SchemaDefinition<GenericSchema, true>,
>(
  ctx: Ctx,
  api: { adapter: AdapterApi },
  config: {
    debugLogs?: DBAdapterDebugLogOption
    authFunctions?: AuthFunctions
    triggers?: Triggers<DataModel, Schema>
  } = {},
) => {
  const handle = async (reference?: FunctionReference<'mutation', 'internal'>) =>
    reference ? ((await createFunctionHandle(reference)) as FunctionHandle<'mutation'>) : undefined
  const onCreateHandle = (model: string) =>
    handle(config.triggers?.[model]?.onCreate ? config.authFunctions?.onCreate : undefined)
  const onUpdateHandle = (model: string) =>
    handle(config.triggers?.[model]?.onUpdate ? config.authFunctions?.onUpdate : undefined)
  const onDeleteHandle = (model: string) =>
    handle(config.triggers?.[model]?.onDelete ? config.authFunctions?.onDelete : undefined)
  const mutationCtx = () => requireRunMutationCtx(ctx)

  return createAdapterFactory({
    config: {
      adapterId: 'convex',
      adapterName: 'Convex Adapter',
      debugLogs: config.debugLogs || false,
      disableIdGeneration: true,
      transaction: false,
      supportsNumericIds: false,
      supportsJSON: false,
      supportsDates: false,
      supportsArrays: true,
      usePlural: false,
      mapKeysTransformInput: { id: '_id' },
      mapKeysTransformOutput: { _id: 'id' },
      // Convert dates to numbers. This aligns with how
      // Convex stores _creationTime and avoids a breaking change.
      customTransformInput: ({ data, fieldAttributes }) =>
        data && fieldAttributes.type === 'date' ? new Date(data).getTime() : data,
      customTransformOutput: ({ data, fieldAttributes }) =>
        data && fieldAttributes.type === 'date' ? new Date(data).getTime() : data,
    },
    adapter: ({ options }) => {
      // Disable telemetry in all cases because it requires Node
      options.telemetry = { enabled: false }

      const collectIdsForOrWhere = async (data: { model: string; where: Where[] }) => {
        const results = await asyncMap(data.where, async (w) =>
          handlePagination(
            async ({ paginationOpts }) =>
              await ctx.runQuery(api.adapter.findMany, {
                model: data.model,
                where: parseWhere(w),
                paginationOpts,
              }),
          ),
        )
        return dedupeDocsById(results.flatMap((r) => r.docs))
          .map((doc) => getDocId(doc))
          .flatMap((id) => (id ? [id] : []))
      }

      return {
        id: 'convex',
        options: { isRunMutationCtx: isRunMutationCtx(ctx) },
        createSchema: async ({ file, tables }) => {
          const { createSchema } = await import('./create-schema')
          return createSchema({ file, tables })
        },
        create: async ({ model, data, select }) =>
          await mutationCtx().runMutation(api.adapter.create, {
            input: { model, data },
            select,
            onCreateHandle: await onCreateHandle(model),
          }),
        // modelKey is Better Auth metadata, not a Convex component argument.
        findOne: async ({ modelKey: _modelKey, ...data }) => {
          if (data.where?.every((w) => w.connector === 'OR')) {
            for (const w of data.where) {
              const result = await ctx.runQuery(api.adapter.findOne, {
                ...data,
                where: parseWhere(w),
              })
              if (result) return result
            }
          }
          return await ctx.runQuery(api.adapter.findOne, { ...data, where: parseWhere(data.where) })
        },
        findMany: async <T>({
          modelKey: _modelKey,
          ...data
        }: Parameters<CustomAdapter['findMany']>[0]) => {
          if (data.offset) throw new Error('offset not supported')
          if (data.where?.some((w) => w.connector === 'OR')) {
            // Always fetch full docs for OR unions so we can dedupe
            // by id and sort/limit before trimming selected fields.
            const { select: _ignoredSelect, ...queryData } = data
            const results = await asyncMap(data.where, async (w) =>
              handlePagination(
                async ({ paginationOpts }) =>
                  await ctx.runQuery(api.adapter.findMany, {
                    ...queryData,
                    where: parseWhere(w),
                    paginationOpts,
                  }),
                { limit: data.limit },
              ),
            )
            let docs = dedupeDocsById(results.flatMap((r) => r.docs))
            if (data.sortBy) docs = sortRows(docs, data.sortBy.field, data.sortBy.direction)
            if (data.limit !== undefined) docs = docs.slice(0, data.limit)
            return docs.map((doc) => selectDocFields(doc, data.select)) as T[]
          }
          const result = await handlePagination(
            async ({ paginationOpts }) =>
              await ctx.runQuery(api.adapter.findMany, {
                ...data,
                where: parseWhere(data.where),
                paginationOpts,
              }),
            { limit: data.limit },
          )
          return result.docs as T[]
        },
        count: async ({ modelKey: _modelKey, ...data }) => {
          // Yes, count is just findMany returning a number.
          if (data.where?.some((w) => w.connector === 'OR')) {
            const results = await asyncMap(data.where, async (w) =>
              handlePagination(
                async ({ paginationOpts }) =>
                  await ctx.runQuery(api.adapter.findMany, {
                    ...data,
                    where: parseWhere(w),
                    paginationOpts,
                  }),
              ),
            )
            return dedupeDocsById(results.flatMap((r) => r.docs)).length
          }
          const result = await handlePagination(
            async ({ paginationOpts }) =>
              await ctx.runQuery(api.adapter.findMany, {
                ...data,
                where: parseWhere(data.where),
                paginationOpts,
              }),
          )
          return result.docs.length
        },
        update: async ({ model, where, update }) => {
          const runner = mutationCtx()
          // An empty where matches no single record, so there's nothing to
          // update. better-auth's adapter contract expects null here.
          if (!where?.length) return null
          if (where.some((w) => w.connector === 'OR')) throw new Error('where clause not supported')
          return await runner.runMutation(api.adapter.updateOne, {
            input: { model, where: parseWhere(where), update },
            onUpdateHandle: await onUpdateHandle(model),
          })
        },
        // Deletes the first matching row in one mutation and returns it.
        consumeOne: async ({ model, where }) => {
          const runner = mutationCtx()
          if (!where.length) return null
          return (
            (await runner.runMutation(api.adapter.deleteOne, {
              input: { model, where: parseWhere(where) },
              onDeleteHandle: await onDeleteHandle(model),
            })) ?? null
          )
        },
        // Updates the first matching row in one mutation and returns it.
        incrementOne: async ({ model, where, increment, set }) => {
          const runner = mutationCtx()
          if (!where.length) return null
          return await runner.runMutation(api.adapter.incrementOne, {
            input: { model, where: parseWhere(where), increment, set },
            onUpdateHandle: await onUpdateHandle(model),
          })
        },
        delete: async ({ model, where }) => {
          await mutationCtx().runMutation(api.adapter.deleteOne, {
            input: { model, where: parseWhere(where) },
            onDeleteHandle: await onDeleteHandle(model),
          })
        },
        deleteMany: async ({ model, where }) => {
          const runner = mutationCtx()
          const deleteHandle = await onDeleteHandle(model)
          if (where?.some((w) => w.connector === 'OR')) {
            const ids = await collectIdsForOrWhere({ model, where })
            await asyncMap(ids, async (id) => {
              await runner.runMutation(api.adapter.deleteOne, {
                input: { model, where: [{ field: '_id', operator: 'eq', value: id }] },
                onDeleteHandle: deleteHandle,
              })
            })
            return ids.length
          }
          const result = await handlePagination(
            async ({ paginationOpts }) =>
              await runner.runMutation(api.adapter.deleteMany, {
                input: { model, where: parseWhere(where) },
                paginationOpts,
                onDeleteHandle: deleteHandle,
              }),
          )
          return result.count
        },
        updateMany: async ({ model, where, update }) => {
          const runner = mutationCtx()
          const updateHandle = await onUpdateHandle(model)
          if (where?.some((w) => w.connector === 'OR')) {
            const ids = await collectIdsForOrWhere({ model, where })
            if (!ids.length) return 0
            const result = await handlePagination(
              async ({ paginationOpts }) =>
                await runner.runMutation(api.adapter.updateMany, {
                  input: { model, where: [{ field: '_id', operator: 'in', value: ids }], update },
                  paginationOpts,
                  onUpdateHandle: updateHandle,
                }),
              { limit: ids.length },
            )
            return result.count ?? 0
          }
          const result = await handlePagination(
            async ({ paginationOpts }) =>
              await runner.runMutation(api.adapter.updateMany, {
                input: { model, where: parseWhere(where), update },
                paginationOpts,
                onUpdateHandle: updateHandle,
              }),
          )
          return result.count
        },
      }
    },
  })
}
