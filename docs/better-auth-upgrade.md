# Better Auth and Qivo's copy of the Convex adapter

Qivo runs Better Auth `1.7.12` with its own copy of the Convex adapter in
[`vendor/convex-better-auth/`](../vendor/convex-better-auth/README.md).
`package.json` pins `better-auth`, `@better-auth/core` and
`@better-auth/oauth-provider` to the same release. This document says why the
copy exists, what it changed, how to move to a later Better Auth release, and
when to go back to an official adapter release. It does not authorize a
production deployment.

## Why Qivo keeps its own copy

Verified on October 24, 2026 against the npm registry and GitHub:

- The latest `@convex-dev/better-auth` is `0.12.5`, whose peer range is
  `better-auth >=1.6.11 <1.7.0`.
- The latest Better Auth is `1.7.12`, released October 20, 2026. `1.8.0-beta.2`
  is a prerelease.
- Better Auth's
  [`SECURITY.md`](https://github.com/better-auth/better-auth/blob/main/SECURITY.md)
  says: "We only support the latest version of Better Auth. Older versions
  are not supported."
- [get-convex/better-auth#430](https://github.com/get-convex/better-auth/pull/430),
  which ports the adapter to Better Auth 1.7.7, has no maintainer review and
  its CI has not run.

The owner approved copying the adapter into Qivo and porting it to 1.7 on
October 24, 2026. The copy holds only the parts Qivo uses, taken from the
official repository's `main` at `3f41cbcf` (tag `v0.12.5` is `c628916b`;
the seven commits between them change no copied file). Pull request #430 at
`fe7e0431` was read as a reference, and only what Qivo needs was taken from
it. The copy's README lists every file, what Qivo changed and what it left
out. `@convex-dev/better-auth` is no longer installed.

## What changed with Better Auth 1.7

- **Adapter.** Better Auth 1.7 passes `modelKey` to every adapter method,
  which the copy drops. `consumeOne` and `incrementOne` are native component
  mutations, so they stay atomic; Better Auth's fallback compares every field
  of the row it read, which fails on `_creationTime` and on fields never
  written. An `eq null` clause also matches a field Convex stores as absent,
  which refresh-token rotation relies on, so Qivo's own refresh claim
  (`claimRefreshToken`) is gone. A unique index of several fields is enforced.
- **The `convex()` plugin** no longer builds the `oidc-provider` plugin,
  which 1.7 removed. `/api/auth/convex/.well-known/openid-configuration` is
  gone; Convex reads keys from `/api/auth/convex/jwks` (`convex/auth.config.ts`).
  The JWT's issuer, audience, subject, claims and keys are unchanged, so
  nobody signs in again.
- **Schema.** `convex/betterAuth/schema.generated.ts` holds the 1.7 tables,
  among them `oauthResource`, `oauthClientResource` and
  `oauthClientAssertion`, and new optional fields on the token and client
  tables. `convex/betterAuth/schema.ts` keeps the consent index, keeps
  `oauthClient.public` and `oauthClient.type`, which 1.6 wrote and 1.7
  dropped, and adds `account.microsoftTenantId`.
- **OAuth provider** (`convex/lib/oauthProvider.ts`). The MCP endpoint is the
  one configured resource, and every new client is linked to it. Per-client
  links are not enforced, since with one resource they add no check that the
  grant's stored resource does not already make, and clients registered on
  1.6 have no link until the backfill below runs. Registration keeps making
  every client public, as 1.6 did for unauthenticated registrations, and
  infers a native client from a loopback or private-use redirect. A
  registration answers HTTP `201`. OAuth endpoints answer a validation error
  as `{ "error", "error_description" }` with the first problem.
- **Sign-out.** Ending a browser session revokes the OAuth access tokens
  issued in it. `/mcp` refuses a revoked token. A refresh token with
  `offline_access`, which Qivo's clients request, stays valid, so a connected
  client renews its access token without a new approval.
- **Qivo's own deletes** of OAuth clients (the unused-client sweep, the OAuth
  smoke cleanup and the demo purge) also delete the client's resource links.
  The operator's and the console's login deletes keep the clients, as before.
- **Microsoft accounts.** Better Auth 1.7 keys a Microsoft account by the ID
  token's `oid`, the person's object id in their organization, instead of
  `sub`, which Microsoft makes different for every app. Qivo keeps no ID
  tokens and serves people from any organization, so the upstream migration,
  which needs stored tokens or a directory export, cannot run. Instead, the
  next Microsoft sign-in moves the account (`convex/lib/microsoftAccounts.ts`):
  Better Auth hands the provider's `mapProfileToUser` the token from
  Microsoft's token endpoint before it looks the account up, and Qivo moves
  the account keyed by that token's `sub` to its `oid` then. It never uses
  the email, which Microsoft does not verify. Every Microsoft sign-in also
  records the token's tenant (`tid`, only when the issuer names it) as
  `account.microsoftTenantId`, so the pair (`tid`, `oid`) can name the person
  in a later login system. Better Auth does not know that field, so it never
  returns it to a browser. A sign-in whose token has no usable tenant goes on
  and records none.
- **The demo** has no OAuth provider, so it serves no OAuth metadata, and its
  `/mcp` answers HTTP `403` without pointing at an authorization server.

## Existing data and deployment order

The release keeps user ids, password hashes, account links, sessions, OAuth
clients and their `client_id`, consents, grants (`oauth_connections`) and the
replay tombstones (`oauth_credential_uses`). Nobody signs in again, and no MCP
client reconnects: a grant created on 1.6 refreshes, and its client keeps
its `client_id`.

1. Merging deploys staging. The schema accepts every 1.6 row, so the deploy
   needs no backfill first.
2. On each deployment, after it serves this release and with the owner's
   approval, run the client backfill. Check first with
   `internal/oauthClientBackfill:remaining`, then
   `internal/oauthClientBackfill:run` with `{"dry_run": true}`, then with
   `{"dry_run": false}`. The file's header has the commands. It maps `type`
   to `applicationType`, keeps `tokenEndpointAuthMethod: none` for public
   clients only, removes `public` and `type`, links every client to the MCP
   resource and drops duplicate links.
3. `internal/microsoftAccounts:count` counts the Microsoft accounts, how many
   still use `sub`, and how many have no tenant recorded. Each person's next
   Microsoft sign-in moves theirs. If the move cannot happen, because
   another account already holds the `oid`, the sign-in goes to that account.
4. A later change removes `public` and `type` from the schema and the
   backfill, once the backfill has run everywhere.

This release is a rollback floor. It writes fields the 1.6 schema does not
have, such as `oauthRefreshToken.rotatedAt` at every refresh and
`account.microsoftTenantId` at every Microsoft sign-in, and Convex refuses to
deploy a schema that stored rows break. Fix forward instead of deploying an
earlier release.

## Advisories

`npm audit` reports no vulnerability. Better Auth publishes some advisories
only as repository advisories, which `npm audit` does not read, so each was
checked against the code on October 24, 2026.

- [GHSA-p2fr-6hmx-4528](https://github.com/advisories/GHSA-p2fr-6hmx-4528)
  (medium, OAuth resource indicators not bound to the grant) affected the
  1.6.31 provider and is fixed in 1.7. Qivo uses the provider. Dependabot
  alert #1 should close once `main` has this change.
- [GHSA-965c-763c-88jm](https://github.com/better-auth/better-auth/security/advisories/GHSA-965c-763c-88jm)
  (critical, OAuth state accepted as a Magic Link token) affected 1.6.31 and
  is fixed in 1.7.7. It needs the Magic Link plugin, which Qivo does not use.
- [GHSA-r4xp-prcw-77qf](https://github.com/better-auth/better-auth/security/advisories/GHSA-r4xp-prcw-77qf)
  (high, OAuth Proxy) affected 1.6.31 and is fixed in 1.7.7. Qivo does not
  use the OAuth Proxy plugin and keeps sign-in state in the database.
- [GHSA-44jh-23m7-hpcf](https://github.com/better-auth/better-auth/security/advisories/GHSA-44jh-23m7-hpcf)
  (low, rate limits on PostgreSQL) affected 1.6.31 and is fixed in 1.7.7.
  Qivo keeps rate-limit records in memory, Better Auth's default.
- [GHSA-q84f-53jg-9ppm](https://github.com/better-auth/better-auth/security/advisories/GHSA-q84f-53jg-9ppm)
  (high, device authorization) affected 1.6.31 and is fixed in 1.7.0-rc.3.
  Qivo does not use the device authorization plugin.
- [GHSA-fmh4-wcc4-5jm3](https://github.com/better-auth/better-auth/security/advisories/GHSA-fmh4-wcc4-5jm3)
  (high, organization invitations) lists `>= 1.6.14` with no fixed version,
  so it also covers 1.7.12; the global advisory, which `npm audit` reads,
  lists only `< 1.6.11`. Qivo does not use the organization plugin.

The other repository advisories cover releases before 1.6.31 or plugins
Qivo does not use (SSO, SCIM, Stripe, passkey, API keys).

## Moving to a later Better Auth release

1. Read the release notes of every release since `1.7.12`, the
   upgrade guide (for 1.7, [Upgrading to Better Auth 1.7](https://www.better-auth.com/docs/guides/1-7-upgrade-guide)) and the
   repository's [security advisories](https://github.com/better-auth/better-auth/security/advisories),
   which `npm audit` does not show.
2. Pin `better-auth`, `@better-auth/core` and `@better-auth/oauth-provider` to
   the same release and run `npm ci` with peer checks on. Do not use
   `--force`, `--legacy-peer-deps` or an override for Better Auth or the copy.
3. Port the copy: compare the adapter types and the atomic fallbacks in
   `@better-auth/core` (`dist/db/adapter/`) with the previous release, and
   the APIs the plugins call. Note each change in the header of the file it
   touches.
4. Regenerate the schema from `convex/betterAuth`:
   `npx auth@<release> generate --output schema.generated.ts`.
   Format it, read the diff, and keep `schema.ts`'s additions in step
   (`convex/tests/betterAuthAdapter.test.ts` checks the indexes). A field the
   new schema drops stays optional in `schema.ts` until a backfill removes it.
5. Run `npm run verify:local` and the checks below, then the hands-on checks
   on a disposable local backend.

### Checks to keep passing

- Discovery, registration, S256 PKCE, exact client and redirect binding,
  signed consent and scope limits work (`convex/tests/oauth.test.ts`).
- Foreign and repeated resource parameters fail. An omitted resource keeps
  the canonical default, and refresh cannot widen its grant.
- Expiry, disconnect, reconnect, replay detection, concurrent code exchange
  and concurrent refresh keep access control and independent grants.
- App and admin sessions stay separate. Browser login can continue to
  consent, while public machine-endpoint CORS grants no cookie access.
- Qivo serves only the Better Auth routes `convex/lib/authRoutes.ts` lists
  and answers 404 to every other one, including routes the new release adds.
  `convex/tests/authRoutes.test.ts` fails when a listed route is no longer
  one Better Auth serves. List a new route only once Qivo calls it, and name
  the caller beside it.
- A validation error stays short (`convex/tests/authValidation.test.ts`).
  `convex/lib/authValidation.ts` relies on Better Call listing each problem
  as `[body.path] message` and joining them with `; `, on the router checking
  with the schemas `auth.api` holds, all but `/sign-in/email`'s, and on zod
  internals: the `abortEarly` parse option, a settable `~standard` property,
  each schema's definition under `_zod.def` (and `_zod.innerType` for a lazy
  schema), the `abort` setting zod reads from a definition while it parses,
  a `catch` schema's definition type and the message of the error
  `safeParse` throws for an asynchronous check. zod checks every entry of a
  record even when it stops early, so a route whose body holds a record that
  can fail stays off the list in `convex/lib/authRoutes.ts`, as
  `/admin/has-permission` does. The OAuth provider's own endpoints answer
  with the first problem only. The test checks each of these.
- Microsoft sign-in keys accounts by `oid` and records the tenant
  (`convex/tests/authData.test.ts`).

## Comparing the copy with an official release

When get-convex/better-auth publishes a release that supports the Better
Auth release Qivo runs, compare it with the copy:

```sh
git clone https://github.com/get-convex/better-auth.git dev-temp/upstream
git -C dev-temp/upstream checkout <tag>
npx biome format --write --config-path . dev-temp/upstream/src
diff -ru dev-temp/upstream/src vendor/convex-better-auth/src
```

Formatting the upstream tree with this repository's Biome settings first
leaves only real differences, such as the parts Qivo left out, its types and
its changes. Going back to the published package makes sense once a release
supports the latest Better Auth, covers every change the copy's README lists
(or Qivo no longer needs one), and its maintainers keep it current. Then
install it, switch the imports back, delete the copy and run the checks
above.
