/* Copied from get-convex/better-auth src/client/create-api.ts at 3f41cbcf
 * (Apache-2.0, see ../../LICENSE). Qivo changed it:
 * - incrementOne is new. It updates the first matching document in one
 *   mutation, so the adapter's consumeOne and incrementOne are atomic, which
 *   Better Auth 1.7 asks of them (as get-convex/better-auth#430 does).
 * - updateOne returns null instead of throwing when no document matches,
 *   which is what Better Auth's update expects (as #430 does).
 * - Types replace `any`. */
import type { BetterAuthDBSchema } from 'better-auth/db'
import { getAuthTables } from 'better-auth/db'
import type { BetterAuthOptions } from 'better-auth/minimal'
import type {
  DocumentByName,
  FunctionHandle,
  GenericDataModel,
  GenericMutationCtx,
} from 'convex/server'
import { mutationGeneric, paginationOptsValidator, queryGeneric } from 'convex/server'
import type { GenericId, PropertyValidators, Validator, Value } from 'convex/values'
import { v } from 'convex/values'
import { asyncMap } from 'convex-helpers'
import { partial } from 'convex-helpers/validators'
import {
  type AnySchema,
  adapterWhereValidator,
  checkUniqueFields,
  hasUniqueFields,
  listOne,
  paginate,
  selectFields,
} from './adapter-utils'

type Doc = DocumentByName<GenericDataModel, string>

/** The field validators of a table, which Better Auth's tables always define
 * as an object. */
const tableFields = (schema: AnySchema, tableName: string): PropertyValidators => {
  const validator: Validator<unknown, 'required', string> = schema.tables[tableName].validator
  if (validator.kind !== 'object') throw new Error(`Table ${tableName} has no object schema`)
  return validator.fields
}

const whereValidator = (schema: AnySchema, tableName: string) =>
  v.object({
    field: v.union(
      ...Object.keys(tableFields(schema, tableName)).map((field) => v.literal(field)),
      v.literal('_id'),
    ),
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

/** Builds the component functions the adapter calls, for the component's
 * schema and the Better Auth options it serves. */
export const createApi = (
  schema: AnySchema,
  createAuthOptions: (ctx: never) => BetterAuthOptions,
) => {
  const betterAuthSchema: BetterAuthDBSchema = getAuthTables(createAuthOptions({} as never))
  const tableNames = Object.keys(schema.tables)
  const modelValidator = v.union(...tableNames.map((model) => v.literal(model)))
  const updateInput = v.union(
    ...tableNames.map((tableName) =>
      v.object({
        model: v.literal(tableName),
        update: v.object(partial(tableFields(schema, tableName))),
        where: v.optional(v.array(whereValidator(schema, tableName))),
      }),
    ),
  )
  const whereInput = v.union(
    ...tableNames.map((tableName) =>
      v.object({
        model: v.literal(tableName),
        where: v.optional(v.array(whereValidator(schema, tableName))),
      }),
    ),
  )

  /** Patches one document, runs its update trigger and returns the document
   * as the trigger left it. */
  const applySingleUpdate = async (
    ctx: GenericMutationCtx<GenericDataModel>,
    model: string,
    doc: Doc,
    update: Record<string, Value | undefined>,
    onUpdateHandle?: string,
  ) => {
    await checkUniqueFields(ctx, schema, betterAuthSchema, model, update, doc)
    await ctx.db.patch(doc._id as GenericId<string>, update)
    const updatedDoc = await ctx.db.get(doc._id as GenericId<string>)
    if (!updatedDoc) throw new Error(`Failed to update ${model}`)
    if (!onUpdateHandle) return updatedDoc
    await ctx.runMutation(onUpdateHandle as FunctionHandle<'mutation'>, {
      model,
      newDoc: updatedDoc,
      oldDoc: doc,
    })
    const innerUpdatedDoc = await ctx.db.get(doc._id as GenericId<string>)
    if (!innerUpdatedDoc)
      throw new Error(`Failed to update ${model} (deleted by onUpdate trigger?)`)
    return innerUpdatedDoc
  }

  return {
    create: mutationGeneric({
      args: {
        input: v.union(
          ...tableNames.map((model) =>
            v.object({ model: v.literal(model), data: v.object(tableFields(schema, model)) }),
          ),
        ),
        select: v.optional(v.array(v.string())),
        onCreateHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        await checkUniqueFields(ctx, schema, betterAuthSchema, args.input.model, args.input.data)
        const id = await ctx.db.insert(args.input.model, args.input.data)
        const doc = await ctx.db.get(id)
        if (!doc) throw new Error(`Failed to create ${args.input.model}`)
        const result = selectFields(doc, args.select)
        if (args.onCreateHandle) {
          await ctx.runMutation(args.onCreateHandle as FunctionHandle<'mutation'>, {
            model: args.input.model,
            doc,
          })
          const updatedDoc = await ctx.db.get(id)
          if (!updatedDoc) {
            throw new Error(`Failed to create ${args.input.model} (deleted by onCreate trigger?)`)
          }
          return selectFields(updatedDoc, args.select)
        }
        return result
      },
    }),
    findOne: queryGeneric({
      args: {
        model: modelValidator,
        where: v.optional(v.array(adapterWhereValidator)),
        select: v.optional(v.array(v.string())),
        join: v.optional(v.any()),
      },
      handler: async (ctx, args) => await listOne(ctx, schema, betterAuthSchema, args),
    }),
    findMany: queryGeneric({
      args: {
        model: modelValidator,
        where: v.optional(v.array(adapterWhereValidator)),
        select: v.optional(v.array(v.string())),
        limit: v.optional(v.number()),
        sortBy: v.optional(
          v.object({ direction: v.union(v.literal('asc'), v.literal('desc')), field: v.string() }),
        ),
        offset: v.optional(v.number()),
        join: v.optional(v.any()),
        paginationOpts: paginationOptsValidator,
      },
      handler: async (ctx, args) => await paginate(ctx, schema, betterAuthSchema, args),
    }),
    updateOne: mutationGeneric({
      args: { input: updateInput, onUpdateHandle: v.optional(v.string()) },
      handler: async (ctx, args) => {
        const doc = await listOne(ctx, schema, betterAuthSchema, args.input)
        if (!doc) return null
        return await applySingleUpdate(
          ctx,
          args.input.model,
          doc,
          args.input.update,
          args.onUpdateHandle,
        )
      },
    }),
    /* Adds `increment` to the first matching document's counters and writes
     * `set`, in one transaction, and returns the updated document, or null
     * when no document matches. */
    incrementOne: mutationGeneric({
      args: {
        input: v.union(
          ...tableNames.map((tableName) =>
            v.object({
              model: v.literal(tableName),
              where: v.array(whereValidator(schema, tableName)),
              increment: v.record(v.string(), v.number()),
              set: v.optional(v.object(partial(tableFields(schema, tableName)))),
            }),
          ),
        ),
        onUpdateHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        if (!args.input.where.length) return null
        const doc = await listOne(ctx, schema, betterAuthSchema, args.input)
        if (!doc) return null
        const update: Record<string, Value | undefined> = { ...args.input.set }
        for (const [field, delta] of Object.entries(args.input.increment)) {
          const current = doc[field]
          if (current !== undefined && current !== null && typeof current !== 'number') {
            throw new Error(`Cannot increment non-numeric field ${args.input.model}.${field}`)
          }
          update[field] = (current ?? 0) + delta
        }
        return await applySingleUpdate(ctx, args.input.model, doc, update, args.onUpdateHandle)
      },
    }),
    updateMany: mutationGeneric({
      args: {
        input: updateInput,
        paginationOpts: paginationOptsValidator,
        onUpdateHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const { page, ...result } = await paginate(ctx, schema, betterAuthSchema, {
          ...args.input,
          paginationOpts: args.paginationOpts,
        })
        const update = args.input.update
        if (update) {
          if (hasUniqueFields(betterAuthSchema, args.input.model, update) && page.length > 1) {
            throw new Error(
              `Attempted to set unique fields in multiple documents in ${args.input.model} with the same value. Fields: ${Object.keys(update).join(', ')}`,
            )
          }
          await asyncMap(page, async (doc) => {
            await checkUniqueFields(ctx, schema, betterAuthSchema, args.input.model, update, doc)
            await ctx.db.patch(doc._id as GenericId<string>, update)
            if (args.onUpdateHandle) {
              await ctx.runMutation(args.onUpdateHandle as FunctionHandle<'mutation'>, {
                model: args.input.model,
                newDoc: await ctx.db.get(doc._id as GenericId<string>),
                oldDoc: doc,
              })
            }
          })
        }
        return { ...result, count: page.length, ids: page.map((doc) => doc._id) }
      },
    }),
    deleteOne: mutationGeneric({
      args: { input: whereInput, onDeleteHandle: v.optional(v.string()) },
      handler: async (ctx, args) => {
        const doc = await listOne(ctx, schema, betterAuthSchema, args.input)
        if (!doc) return
        await ctx.db.delete(doc._id as GenericId<string>)
        if (args.onDeleteHandle) {
          await ctx.runMutation(args.onDeleteHandle as FunctionHandle<'mutation'>, {
            model: args.input.model,
            doc,
          })
        }
        return doc
      },
    }),
    deleteMany: mutationGeneric({
      args: {
        input: whereInput,
        paginationOpts: paginationOptsValidator,
        onDeleteHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const { page, ...result } = await paginate(ctx, schema, betterAuthSchema, {
          ...args.input,
          paginationOpts: args.paginationOpts,
        })
        await asyncMap(page, async (doc) => {
          if (args.onDeleteHandle) {
            await ctx.runMutation(args.onDeleteHandle as FunctionHandle<'mutation'>, {
              model: args.input.model,
              doc,
            })
          }
          await ctx.db.delete(doc._id as GenericId<string>)
        })
        return { ...result, count: page.length, ids: page.map((doc) => doc._id) }
      },
    }),
  }
}
