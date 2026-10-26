/* Copied from get-convex/better-auth src/client/create-client.ts at 3f41cbcf
 * (Apache-2.0, see ../../LICENSE). Qivo changed it:
 * - It keeps the members Qivo uses: adapter, getAuth, getHeaders,
 *   triggersApi and registerRoutes with CORS. safeGetAuthUser, getAuthUser,
 *   getAnyUserById, setUserId, clientApi, registerRoutesLazy and the verbose
 *   logging are left out. Qivo reads the caller's login with its own
 *   session check (convex/lib/authUser.ts), which loads no Better Auth.
 * - registerRoutes no longer redirects /.well-known/openid-configuration to
 *   the convex() plugin's discovery document, which is gone (see
 *   ../plugins/convex/index.ts).
 * - The CORS check reads the options' trusted origins when they set them,
 *   and only otherwise the static instance's context, whose plugin init
 *   (Better Auth 1.7's OAuth resource seed) fails without a database.
 * - The component API includes incrementOne (see create-api.ts).
 * - Types replace `any`. */
import type {
  FunctionReference,
  GenericDataModel,
  GenericMutationCtx,
  GenericSchema,
  HttpRouter,
  SchemaDefinition,
} from 'convex/server'
import { httpActionGeneric, internalMutationGeneric } from 'convex/server'
import type { GenericValidator, Infer } from 'convex/values'
import { v } from 'convex/values'
import { corsRouter } from 'convex-helpers/server/cors'
import type { CreateAuth, GenericCtx, TrustedOriginsOption } from '../utils'
import { type AdapterApi, convexAdapter } from './adapter'

/** The app's internal mutations that run the triggers (triggersApi). */
export type AuthFunctions = {
  onCreate?: FunctionReference<'mutation', 'internal', Record<string, unknown>>
  onUpdate?: FunctionReference<'mutation', 'internal', Record<string, unknown>>
  onDelete?: FunctionReference<'mutation', 'internal', Record<string, unknown>>
}

type TableDoc<
  Schema extends SchemaDefinition<GenericSchema, true>,
  K extends keyof Schema['tables'],
> = Infer<Schema['tables'][K]['validator'] & GenericValidator> & {
  _id: string
  _creationTime: number
}

/** Callbacks that run in the app, in the same transaction, when the
 * component creates, updates or deletes a row of a table. */
export type Triggers<
  DataModel extends GenericDataModel,
  Schema extends SchemaDefinition<GenericSchema, true>,
> = {
  [K in keyof Schema['tables']]?: {
    onCreate?: (ctx: GenericMutationCtx<DataModel>, doc: TableDoc<Schema, K>) => Promise<void>
    onUpdate?: (
      ctx: GenericMutationCtx<DataModel>,
      newDoc: TableDoc<Schema, K>,
      oldDoc: TableDoc<Schema, K>,
    ) => Promise<void>
    onDelete?: (ctx: GenericMutationCtx<DataModel>, doc: TableDoc<Schema, K>) => Promise<void>
  }
}

const restoreOriginalForwardedHeaders = (request: Request) => {
  const originalHost = request.headers.get('x-better-auth-forwarded-host')
  const originalProto = request.headers.get('x-better-auth-forwarded-proto')
  if (!originalHost && !originalProto) return request
  const headers = new Headers(request.headers)
  if (originalHost) headers.set('x-forwarded-host', originalHost)
  if (originalProto) headers.set('x-forwarded-proto', originalProto)
  return new Request(request, { headers })
}

/**
 * The app's side of the Better Auth component: the database adapter, the
 * trigger functions and the HTTP routes.
 *
 * @param component - `components.betterAuth` from `./_generated/api`.
 * @param config.local - The component's schema.
 * @param config.triggers - Callbacks for row changes, which need
 * `authFunctions` to name the app's trigger mutations.
 */
export const createClient = <
  DataModel extends GenericDataModel,
  Schema extends SchemaDefinition<GenericSchema, true>,
>(
  component: { adapter: AdapterApi },
  config?: { local?: { schema?: Schema } } & (
    | { triggers: Triggers<DataModel, Schema>; authFunctions: AuthFunctions }
    | { triggers?: undefined; authFunctions?: undefined }
  ),
) => {
  const getHeaders = async (ctx: GenericCtx<DataModel>) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return new Headers()
    // Don't validate the session here, let Better Auth handle that
    const session: { token?: string; ipAddress?: string } | null = await ctx.runQuery(
      component.adapter.findOne,
      { model: 'session', where: [{ field: '_id', value: identity.sessionId as string }] },
    )
    return new Headers({
      ...(session?.token ? { authorization: `Bearer ${session.token}` } : {}),
      ...(session?.ipAddress ? { 'x-forwarded-for': session.ipAddress } : {}),
    })
  }

  return {
    /** The Convex database adapter for the Better Auth options. */
    adapter: (ctx: GenericCtx<DataModel>) =>
      convexAdapter<DataModel, typeof ctx, Schema>(ctx, component, config),

    /** The Better Auth instance and the current session's headers, for
     * calling Better Auth's API from a Convex function, which has no request
     * headers of its own. */
    getAuth: async <T extends CreateAuth<DataModel>>(
      createAuth: T,
      ctx: GenericCtx<DataModel>,
    ) => ({
      auth: createAuth(ctx) as ReturnType<T>,
      headers: await getHeaders(ctx),
    }),

    /** Headers that carry the current session's token as a Bearer token. */
    getHeaders,

    /** The internal mutations that run the triggers in the app, which
     * `authFunctions` must name. */
    triggersApi: () => ({
      onCreate: internalMutationGeneric({
        args: { doc: v.any(), model: v.string() },
        handler: async (ctx, args) => {
          await config?.triggers?.[args.model]?.onCreate?.(ctx, args.doc)
        },
      }),
      onUpdate: internalMutationGeneric({
        args: { oldDoc: v.any(), newDoc: v.any(), model: v.string() },
        handler: async (ctx, args) => {
          await config?.triggers?.[args.model]?.onUpdate?.(ctx, args.newDoc, args.oldDoc)
        },
      }),
      onDelete: internalMutationGeneric({
        args: { doc: v.any(), model: v.string() },
        handler: async (ctx, args) => {
          await config?.triggers?.[args.model]?.onDelete?.(ctx, args.doc)
        },
      }),
    }),

    /** Routes Better Auth's requests under its base path, with CORS for the
     * trusted origins and `cors.allowedOrigins`. */
    registerRoutes: (
      http: HttpRouter,
      createAuth: CreateAuth<DataModel>,
      opts: {
        cors?:
          | boolean
          | {
              // These values are appended to the default values
              allowedOrigins?: string[]
              allowedHeaders?: string[]
              exposedHeaders?: string[]
            }
      } = {},
    ) => {
      const staticAuth = createAuth({} as GenericCtx<DataModel>)
      const path = staticAuth.options.basePath ?? '/api/auth'
      const authRequestHandler = httpActionGeneric(async (ctx, request) => {
        const auth = createAuth(ctx as unknown as GenericCtx<DataModel>)
        return await auth.handler(restoreOriginalForwardedHeaders(request))
      })

      if (!opts.cors) {
        http.route({ pathPrefix: `${path}/`, method: 'GET', handler: authRequestHandler })
        http.route({ pathPrefix: `${path}/`, method: 'POST', handler: authRequestHandler })
        return
      }
      const corsOpts =
        typeof opts.cors === 'boolean'
          ? { allowedOrigins: [], allowedHeaders: [], exposedHeaders: [] }
          : opts.cors
      let trustedOriginsOption: TrustedOriginsOption | undefined
      const cors = corsRouter(http, {
        allowedOrigins: async (request) => {
          // The options' own list when they set one: building the static
          // instance's context would also run its plugins' init, such as the
          // OAuth provider's resource seed, without a database.
          trustedOriginsOption ??=
            staticAuth.options.trustedOrigins ??
            (await staticAuth.$context).options.trustedOrigins ??
            []
          const rawOrigins = Array.isArray(trustedOriginsOption)
            ? trustedOriginsOption
            : await trustedOriginsOption(request)
          return rawOrigins
            .filter((origin): origin is string => typeof origin === 'string')
            .map((origin) =>
              // Strip trailing wildcards, unsupported for allowedOrigins
              origin.endsWith('*') && origin.length > 1 ? origin.slice(0, -1) : origin,
            )
            .concat(corsOpts.allowedOrigins ?? [])
        },
        allowCredentials: true,
        allowedHeaders: ['Content-Type', 'Better-Auth-Cookie', 'Authorization'].concat(
          corsOpts.allowedHeaders ?? [],
        ),
        exposedHeaders: ['Set-Better-Auth-Cookie'].concat(corsOpts.exposedHeaders ?? []),
        enforceAllowOrigins: false,
      })
      cors.route({ pathPrefix: `${path}/`, method: 'GET', handler: authRequestHandler })
      cors.route({ pathPrefix: `${path}/`, method: 'POST', handler: authRequestHandler })
    },
  }
}
