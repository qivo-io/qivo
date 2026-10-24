/* Copied from get-convex/better-auth src/utils/index.ts at 3f41cbcf
 * (Apache-2.0, see ../../LICENSE). Qivo changed it: it keeps only the context
 * types and guards Qivo uses, and leaves out getToken, parseJwks and the
 * query, mutation and action guards. */
import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from 'convex/server'

/** Better Auth's trustedOrigins option, a list or a function of the request. */
export type TrustedOriginsOption =
  | (string | null | undefined)[]
  | ((request?: Request) => (string | null | undefined)[] | Promise<(string | null | undefined)[]>)

/** The part of a Better Auth instance that registerRoutes reads. */
type RegisterableAuth = {
  handler: (request: Request) => Promise<Response>
  options: { basePath?: string; [key: string]: unknown }
  $context: Promise<{ options: { trustedOrigins?: TrustedOriginsOption; [key: string]: unknown } }>
}

/** A function that builds a Better Auth instance for a Convex context. */
export type CreateAuth<
  DataModel extends GenericDataModel,
  A extends RegisterableAuth = RegisterableAuth,
> = (ctx: GenericCtx<DataModel>) => A

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
