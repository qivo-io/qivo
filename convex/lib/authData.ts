/* The personal data Better Auth would keep on its own rows that Qivo never
 * reads. auth.ts's databaseHooks stop it at every write, reading the field
 * lists here. The schema keeps
 * every field (convex/betterAuth/schema.generated.ts), because Convex
 * validates existing documents on deploy.
 *
 * Nothing Qivo enables reads them. The client IP address and User-Agent are
 * copied onto every session by Better Auth's createSession. The admin console
 * shows a login's newest session time only (adminPeople.ts authColumnsFor), and the
 * demo's visitor categories come from the sign-in request itself (http.ts).
 * A social login's provider tokens let Better Auth call the provider again
 * after sign-in, which Qivo never does, and the provider picture in
 * user.image is shown nowhere. The app draws avatars from uploaded pictures,
 * Gravatar or initials, the Convex token omits it, and the MCP OAuth
 * provider would only emit it under a `profile` scope Qivo does not offer
 * (lib/oauth.ts OAUTH_SCOPES). */

/** Session fields Better Auth fills from the sign-in request. */
export const SESSION_REQUEST_FIELDS = ['ipAddress', 'userAgent'] as const

/** Provider credentials Better Auth copies onto a social login's account
 * row. A credential (password) account never carries them, and its
 * `password` field is not among them. */
export const PROVIDER_TOKEN_FIELDS = [
  'accessToken',
  'refreshToken',
  'idToken',
  'accessTokenExpiresAt',
  'refreshTokenExpiresAt',
] as const

/** User fields copied from the provider profile: its picture URL, or for
 * Microsoft a Graph photo as a data URL. */
export const USER_PROFILE_FIELDS = ['image'] as const

/** An object setting every field in `fields` to `value`, for one write. */
export const fieldsSetTo = <F extends string, V>(fields: readonly F[], value: V) =>
  Object.fromEntries(fields.map((field) => [field, value])) as Record<F, V>

/** Whether `row` still holds a value, null and absent aside, in any of `fields`. */
export const holdsAny = (row: object, fields: readonly string[]): boolean =>
  fields.some((field) => (row as Record<string, unknown>)[field] != null)
