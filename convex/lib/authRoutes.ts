/* The Better Auth routes Qivo serves over HTTP, and who calls each one.
 *
 * Better Auth's router serves every endpoint of every plugin, and a plugin
 * may answer other paths before the router does, as the OAuth provider
 * answers its metadata. Anyone can reach a served route, so every request
 * whose method and path no route here lists is refused before its body is
 * read: http.ts answers it, and createAuth (auth.ts) answers it 404 before
 * Better Auth sees it. A route that a Better Auth update adds is refused
 * until it is listed here. Calls through auth.api, such as adminAuth.ts's,
 * run in-process and never pass the router, so this does not limit them.
 * convex/tests/authRoutes.test.ts checks that Better Auth answers every
 * route listed and that every other one answers 404.
 *
 * Some refused routes would also do harm. The provider token routes
 * (/get-access-token, /refresh-token, /account-info) answer from tokens Qivo
 * never stores (auth.ts databaseHooks). The OAuth client management routes
 * would let a client change itself after it registered through
 * /oauth2/register, which lib/oauthRegistration.ts limits, and
 * /oauth2/update-client stores metadata of any size. zod checks every entry
 * of /admin/has-permission's record before the session, which
 * lib/authValidation.ts cannot stop early. */

import { isDemoDeployment } from './demo'

/** The routes every deployment but the demo serves, as `METHOD /path`
 * under /api/auth. A `:name` segment matches any one segment. */
export const AUTH_ROUTES = [
  // the web app, /admin and the desktop app (lib/authSession.ts)
  'GET /get-session',
  'GET /convex/token',
  'POST /sign-in/email',
  'POST /sign-out',
  // the web app's sign-in screen (AuthGate.tsx), also in the desktop app
  'POST /sign-up/email',
  'POST /sign-in/social',
  'POST /send-verification-email',
  'POST /request-password-reset',
  'POST /reset-password',
  'POST /cross-domain/one-time-token/verify',
  // Google's and Microsoft's redirects back after a social sign-in
  'GET /callback/google',
  'GET /callback/microsoft',
  // the links in authentication letters (auth.ts)
  'GET /verify-email',
  'GET /reset-password/:token',
  // Better Auth's own redirect for a failed sign-in or authorization that
  // has no page of its own to return to
  'GET /error',
  // the Convex backend, which checks the app's tokens with these keys
  // (auth.config.ts)
  'GET /convex/jwks',
  // MCP clients' OAuth (docs/mcp.md) and the app's consent page
  // (OAuthConnect.tsx)
  'GET /oauth2/authorize',
  'POST /oauth2/consent',
  'POST /oauth2/register',
  'POST /oauth2/token',
  'POST /oauth2/revoke',
  // the authorization server's metadata after the issuer's path, which the
  // OAuth provider answers itself, for clients that look for it there
  // rather than where http.ts serves it (docs/mcp.md)
  'GET /.well-known/oauth-authorization-server',
  'HEAD /.well-known/oauth-authorization-server',
] as const

/** The routes the demo serves: its anonymous sign-in and the session and
 * token routes the app reads with it. http.ts refuses every other route on
 * the demo with its own answer, before the body is read. */
export const DEMO_AUTH_ROUTES = [
  'POST /sign-in/anonymous',
  'POST /sign-out',
  'GET /get-session',
  'GET /convex/token',
  'GET /convex/jwks',
] as const

/** The routes this deployment serves. */
export const servedAuthRoutes = (): readonly string[] =>
  isDemoDeployment() ? DEMO_AUTH_ROUTES : AUTH_ROUTES

/* Where Convex routes Better Auth's requests (registerRoutes). */
const AUTH_BASE_PATH = '/api/auth'

/** Whether `routes` lists `request`'s method and path. The path must match
 * one route segment by segment, so a trailing slash, another case or an
 * encoded character matches none. */
export function servesAuthRoute(routes: readonly string[], request: Request): boolean {
  const { pathname } = new URL(request.url)
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false
  const segments = pathname.slice(AUTH_BASE_PATH.length).split('/')
  return routes.some((route) => {
    const [method, path] = route.split(' ')
    const pattern = path.split('/')
    return (
      method === request.method &&
      pattern.length === segments.length &&
      pattern.every((part, i) => (part.startsWith(':') ? segments[i] !== '' : part === segments[i]))
    )
  })
}

/** `auth`, with a handler that answers 404 to every request `routes` does
 * not list, as Better Auth answers a path its `disabledPaths` names. */
export function serveOnly<Auth extends { handler(request: Request): Promise<Response> }>(
  auth: Auth,
  routes: readonly string[],
): Auth {
  return {
    ...auth,
    handler: async (request: Request) =>
      servesAuthRoute(routes, request)
        ? auth.handler(request)
        : new Response('Not Found', { status: 404 }),
  }
}
