/* Copied from get-convex/better-auth src/utils/index.ts at 3f41cbcf
 * (Apache-2.0, see ../../LICENSE). Qivo changed it: it keeps only the context
 * types and guards Qivo uses, and leaves out getToken, parseJwks and the
 * query, mutation and action guards. CreateAuth no longer describes the
 * instance's handler, options and context, which only the HTTP route
 * registration read, and the copy no longer registers the routes (see
 * ../client/create-client.ts). */
import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from 'convex/server'

/** A function that builds a Better Auth instance for a Convex context. */
export type CreateAuth<DataModel extends GenericDataModel, A = unknown> = (
  ctx: GenericCtx<DataModel>,
) => A

/** Any Convex function context. */
export type GenericCtx<DataModel extends GenericDataModel = GenericDataModel> =
  | GenericQueryCtx<DataModel>
  | GenericMutationCtx<DataModel>
  | GenericActionCtx<DataModel>

/** A context that can run a mutation: a mutation or an action. */
export type RunMutationCtx<DataModel extends GenericDataModel> = (
  | GenericMutationCtx<DataModel>
  | GenericActionCtx<DataModel>
) & { runMutation: GenericActionCtx<DataModel>['runMutation'] }

/** Whether the context can run a mutation. */
export const isRunMutationCtx = <DataModel extends GenericDataModel>(
  ctx: GenericCtx<DataModel>,
): ctx is RunMutationCtx<DataModel> => 'runMutation' in ctx

/** Returns the context when it can run a mutation, and throws otherwise. */
export const requireRunMutationCtx = <DataModel extends GenericDataModel>(
  ctx: GenericCtx<DataModel>,
): RunMutationCtx<DataModel> => {
  if (!isRunMutationCtx(ctx)) throw new Error('Mutation or action context required')
  return ctx
}
