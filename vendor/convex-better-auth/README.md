# Qivo's copy of the Convex adapter for Better Auth

This folder holds the parts of the official Convex adapter for Better Auth
that Qivo uses, ported to Better Auth 1.7. The published package,
`@convex-dev/better-auth` 0.12.5, supports Better Auth below 1.7 only, and
Better Auth supports only its latest release. See
[the Better Auth upgrade notes](../../docs/better-auth-upgrade.md) for why the
copy exists, how to port a later Better Auth release and how to compare the
copy with a later official release.

- Upstream: [get-convex/better-auth](https://github.com/get-convex/better-auth),
  `main` at commit `3f41cbcf`, which is tag `v0.12.5` (`c628916b`) plus seven
  commits that change no copied file.
- Reference for the 1.7 port, read line by line and not copied whole:
  [pull request #430](https://github.com/get-convex/better-auth/pull/430) at
  `fe7e0431`, which targets Better Auth 1.7.7.
- License: Apache-2.0, in [LICENSE](LICENSE), as upstream. Every copied file
  starts with a note naming its upstream path and commit and saying what
  Qivo changed.

The folder sits outside `convex/` because it holds code for two runtimes:
the server parts run in Convex, and `src/client/plugins/` runs in the
browser. Its files mirror upstream's `src/` paths, so a later release
compares file by file. It follows the repository's formatting, lint and
TypeScript rules like any other code.

## What was copied

| File | Used by |
| --- | --- |
| `src/client/adapter.ts`, `adapter-utils.ts`, `create-api.ts`, `create-client.ts`, `create-schema.ts`, `index.ts` | `convex/auth.ts` (`createClient`), `convex/betterAuth/adapter.ts` (`createApi`), `npx auth generate` |
| `src/plugins/convex/index.ts`, `src/plugins/cross-domain/index.ts`, `src/plugins/index.ts` | `convex/auth.ts` (`convex`, `crossDomain`) |
| `src/plugins/convex/client.ts`, `src/plugins/cross-domain/client.ts`, `src/client/plugins/index.ts` | `src/lib/authSession.ts` (`convexClient`, `crossDomainClient`) |
| `src/auth-config.ts` | `convex/auth.config.ts` (`getAuthConfigProvider`) |
| `src/utils/index.ts` | `GenericCtx` and `requireRunMutationCtx` in `convex/` |
| `src/version.ts` | the plugins' version |

## What Qivo changed

- Better Auth 1.7 support: the adapter drops the `modelKey` Better Auth now
  passes to every method; `consumeOne` and `incrementOne` are native, each one
  component mutation; an `eq null` clause also matches a field never written,
  and never picks an index; a unique index of several fields, such as
  `oauthClientResource`'s `(clientId, resourceId)`, is enforced; the schema
  generator indexes fields marked `index: true` and table-level indexes.
- The `convex()` plugin no longer builds the `oidc-provider` plugin, which 1.7
  removed. Its after hooks and `/convex/.well-known/openid-configuration` are
  gone. `/convex/jwks`, `/convex/token` and the JWT are unchanged.
- `registerRoutes` no longer redirects `/.well-known/openid-configuration`.
- `updateOne` returns null when no row matches.
- The cross-domain client clears the stored cookies at sign-out only after
  the server answers that it ended the session, so a refused sign-out keeps
  the session in the browser to try again. A newer session that another tab
  stored meanwhile stays.
- Upstream bugs fixed: pagination resumes from `continueCursor`, so a page
  that stops early is not read twice; a single-row lookup reads on past a
  page with no match; an `in` clause the query does not expand is applied to
  each row instead of dropped; `updateMany` checks unique constraints one row
  at a time, so a bulk update cannot give two rows the same composite key;
  the queries for the values of an `in` clause merge on the fields their
  index orders by, so an index with more fields no longer throws; `findOne`
  with only OR clauses answers null when none matches instead of throwing.
- Known and not changed, because Qivo reaches none of them: a row whose id
  Better Auth chooses (`forceAllowId`) cannot be stored, so DPoP,
  `private_key_jwt`, Magic Link, email OTP and Sign In with Ethereum do not
  work (see the upgrade notes); a `sortBy` on `id` is not mapped to `_id`;
  `create-schema` writes `./schema.ts` when no output file is given; a
  single-row lookup that no index narrows reads until it finds a match or
  hits Convex's read limits.
- Types replace `any`, and the code follows the repository's formatting.

## What was left out

- The published component (`src/component/`); Qivo defines its own in
  `convex/betterAuth/`.
- `react`, `react-start`, `nextjs`, `test`, `auth.ts`, `auth-options.ts` and
  every test file.
- From `createClient`: `getAnyUserById`, `setUserId`, `clientApi`,
  `registerRoutesLazy` and the verbose logging.
- From the `convex()` plugin: the static JWKS option, the deprecated
  `jwtExpirationSeconds`, the base path checks, `/convex/latest-jwks`,
  `/convex/rotate-keys`, the key rotation after a token error and the OpenAPI
  descriptions.
- From `auth-config.ts`: the static JWKS option and `createPublicJwks`.
- From `utils`: `getToken`, `parseJwks` and the context guards Qivo does not
  call.
- The check of the installed Convex version and the experimental joins
  override.
- The runtime dependencies `@better-fetch/fetch`, `common-tags`, `jose`,
  `remeda`, `semver` and `type-fest`. The copy needs only `convex-helpers` and
  `zod`, which `package.json` declares.
