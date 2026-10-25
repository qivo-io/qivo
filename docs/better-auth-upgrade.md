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
  The copy also fixes four upstream bugs in reads that span pages, which its
  README lists.
- **The `convex()` plugin** no longer builds the `oidc-provider` plugin,
  which 1.7 removed. `/api/auth/convex/.well-known/openid-configuration` is
  gone; Convex reads keys from `/api/auth/convex/jwks` (`convex/auth.config.ts`).
  The JWT's issuer, audience, subject, claims and keys are unchanged, so
  nobody signs in again.
- **Schema.** `convex/betterAuth/schema.generated.ts` holds the 1.7 tables,
  among them `oauthResource`, `oauthClientResource` and
  `oauthClientAssertion`, and new optional fields on the token and client
  tables. `convex/betterAuth/schema.ts` keeps the consent index and adds
  `account.microsoftTenantId`. It no longer accepts `oauthClient.public` and
  `oauthClient.type`, which 1.6 wrote and 1.7 dropped (see
  [Existing data and deployment order](#existing-data-and-deployment-order)).
- **OAuth provider** (`convex/lib/oauthProvider.ts`). The MCP endpoint is the
  one configured resource, and every new client is linked to it. Registration
  keeps making every client public, as 1.6 did for unauthenticated
  registrations, and infers a native client from a loopback or private-use
  redirect. A registration answers HTTP `201`. OAuth endpoints answer a
  validation error as `{ "error", "error_description" }` with the first
  problem.
- **Per-client resource links are enforced**
  (`enforcePerClientResources: true`). Better Auth 1.7 refuses a client that
  asks for a resource it is not linked to with `invalid_target`, at
  authorization, code exchange and refresh. Better Auth checks the link at
  authorization only when the request names a resource, so the authorize
  hook fills in the MCP resource when a request leaves it out, as the token
  endpoint does. Registration links every client
  to the MCP resource, and the client backfill linked those registered on
  1.6. Qivo's own checks also refuse every other resource for every client:
  the authorize hook and `validateOAuthQuery` in `convex/lib/oauth.ts`, the
  token endpoint's `onRequest` and before hook, the issuance check in
  `customTokenResponseFields`, and the grant's stored resource, which
  `oauthConnections.lookupAccess` compares on every MCP request. Better
  Auth checks the link only when it issues a token, so `lookupAccess` also
  reads the client's link on every request and refuses a token whose client
  lost it, and webhook ownership (`model/taskEvents.ts eventOwner`) refuses
  the connection's subscriptions the same way (`lib/access.ts
  oauthClientLive`).
  `convex/tests/oauth.test.ts` shows that a client without the link is
  refused, and that a linked client is refused every other resource at
  authorize, code exchange and refresh, even when Better Auth knows a second
  resource. If Qivo ever serves a second resource, link each client only to
  the resources it may use and replace the single-resource checks listed
  above, which compare with `mcpResource()`. Because registration is the
  only time a client is linked, changing `MCP_RESOURCE_URL` leaves every
  existing client linked to the old resource, so each one is refused and
  must register again.
- **Client authentication and metadata.** Registration makes every client
  public (`none`). The token and revocation endpoints refuse a request that
  authenticates a client with `invalid_client` (`oauthHooks` in
  `convex/lib/oauthProvider.ts`): HTTP `401` with a `WWW-Authenticate`
  challenge of the same scheme for an `Authorization` header, as RFC 6749
  section 5.2 asks, HTTP `400` with `invalid_request` for a header whose
  scheme is malformed, and HTTP `400` for a secret or an assertion in the
  body. An empty header or field counts as absent, as Better Auth reads it.
  Better Auth 1.7's metadata also lists the
  secret and `private_key_jwt` methods and their signing algorithms, so
  `servedServerMetadata` lists `none` as the only method of both endpoints,
  on every path the metadata is served at.
- **Introspection is not served.** Better Auth 1.7 lets a client linked to a
  resource introspect another client's tokens for it, and accepts only a
  client that authenticates with a secret or an assertion, which no Qivo
  client has. Qivo's MCP endpoint reads its tokens itself, and the MCP
  specification asks no client to introspect, so `/oauth2/introspect`
  answers HTTP `404` (`convex/lib/authRoutes.ts`) and the metadata names no
  introspection endpoint.
- **Writes with a chosen id.** Some Better Auth features create a row whose
  id they choose, so that a second attempt with the same id fails: DPoP proof
  reservations, `private_key_jwt` client assertions (`oauthClientAssertion`),
  and the verification reservations of the Magic Link, email OTP and Sign In
  with Ethereum plugins. Convex chooses every document id, so the copy cannot
  store such a row, and none of these features works with it. Qivo uses none
  of them. Supporting one needs a table keyed by that id and a uniqueness
  check in the copy.
- **DPoP.** Better Auth 1.7 supports DPoP-bound tokens (RFC 9449), but the
  copy cannot store their proof reservations (see above), and `/mcp` checks
  no proof. Qivo issues Bearer tokens only: the token endpoint ignores a
  `DPoP` header, as a server without DPoP does, authorize refuses
  `dpop_jkt`, registration drops `dpop_bound_access_tokens`, the metadata
  lists no DPoP algorithms, and `/mcp` refuses a bound token.
- **Registration** ignores an `Authorization` header, because Better Auth 1.7
  reads a Bearer token there as an initial access token, which Qivo does not
  issue, and would answer HTTP `401`. 1.7 also checks redirect URIs by
  application type; `docs/mcp.md` lists the rules.
- **Sign-out.** Ending a browser session ends the OAuth access tokens
  issued in it, whether the session ends at sign-out, at a ban, when Better
  Auth deletes it after it expired or in any call that ends many sessions at
  once. A password reset ends no session. The owner decided on 25 October
  2026 that a reset, most often for a forgotten password, keeps every
  session, OAuth connection and token, so
  `emailAndPassword.revokeSessionsOnPasswordReset` in `convex/auth.ts` is
  `false`. Better Auth's reset calls `deleteUserSessions` only when that
  option is set; an upgrade that changes the option's meaning or default
  needs it rechecked. Better Auth 1.7 revokes only the oldest 100 tokens of a session, and
  each refresh adds one. It runs the session delete hooks of a bulk delete
  for the oldest 100 sessions only, and only after the session row is gone,
  so a failed revocation used to leave the tokens valid until they expired.
  Qivo's session delete trigger (`endSession` in `convex/lib/sessionEnd.ts`,
  run by `convex/authTriggers.ts`, which `convex/auth.ts` names) runs in the
  transaction that deletes each session row and stores one
  `oauth_ended_sessions` row with the time the session ended, so the delete
  and the record succeed or fail together, and the work stays one write
  however many tokens the session holds. `oauthConnections.lookupAccess`
  refuses every access token of the session created before that time, and a
  scheduled cleanup deletes the record once those tokens have expired
  (`OAUTH_ACCESS_TOKEN_TTL_SECONDS` in `convex/lib/oauth.ts`, plus a minute).
  The trigger runs once for each session in one transaction, so its module
  loads none of Better Auth (`convex/tests/authTriggers.test.ts`): with it, a
  ban of 200 sessions failed on Convex's time limit on a local backend.
  Better Auth deletes an expired session only when its cookie comes back,
  so a nightly job (`convex/authRetention.ts`) deletes the others with a
  trigger of its own that ends the session at its expiry: a code exchange
  needs a live session, so only a refresh issues a token in it after then,
  and that refresh token could issue it again. For a session that expired
  more than an access token's lifetime before, it writes no record. Every
  other delete, a ban too, ends the session now.
  A refresh token with `offline_access`, which Qivo's clients request, stays
  valid, and the access tokens it issues later work, so a connected client
  renews its access without a new approval. A ban also revokes every valid
  access token of the login (`convex/adminAuth.ts`), so a token a refresh
  issued after its session had ended works no more after an unban.
- **Spent OAuth tokens.** Every refresh adds an access token and a refresh
  token and revokes the refresh token it used. A nightly job
  (`convex/authRetention.ts`, `deleteSpentTokens` in
  `convex/betterAuth/oauth.ts`) deletes expired access and refresh tokens
  and refresh tokens revoked over an hour before, by the component indexes
  in `convex/betterAuth/schema.ts`. Better Auth checks a refresh token's
  expiry before its revocation, and Qivo's adapter hides a revoked refresh
  token from Better Auth (`convex/lib/oauthAdapter.ts`), so neither kind is
  read by its replay detection. Qivo detects a replay by the hash it keeps
  of every used refresh token (`oauth_credential_uses`). The same job
  deletes a hash at its first run 31 days after its use
  (`REPLAY_HASH_KEEP_MS`), once the token's 30-day lifetime
  (`OAUTH_REFRESH_TOKEN_TTL_SECONDS` in `convex/lib/oauth.ts`, which
  `convex/lib/oauthProvider.ts` hands Better Auth) and a day have passed,
  so a later replay is refused without ending the grant. An upgrade that shows Better Auth revoked refresh tokens again,
  or accepts a refresh token past that lifetime, needs that cleanup
  rechecked.
- **A failed sign-out says so.** Better Auth answers a sign-out whose
  session delete failed with HTTP `200` and clears the cookie. Qivo's after
  hook on `/sign-out` (`oauthHooks`) deletes a session that is still stored
  once more and looks it up again, and if it is still stored, answers HTTP
  `503` with `SIGN_OUT_FAILED` and without clearing the session cookie. A
  sign-out Better Auth refused, such as one with a malformed body, ends
  nothing. The hook also drops the signed authorization request that the
  app's OAuth client adds to a sign-out from the connect page, which the
  provider would refuse once it expires. The cross-domain client in the copy
  clears the stored session only after a sign-out succeeds. After a fault or
  a rate limit (HTTP `5xx` or `429`), the app, the consent page and the
  operator console keep the person signed in and ask them to try again
  (`signOut` in `src/lib/authSession.ts`). Any other refusal would repeat on
  every try, so the browser forgets the session then, as it does when the
  server cannot be reached or gives no answer within 15 seconds; the server
  session then ends at its expiry. A press while a sign-out runs joins it,
  and the controls show that it runs. A login removal from the console deletes the login and
  then its sessions and tokens, and `/mcp` refuses every token of a missing
  or banned login.
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

1. The 1.7 release (v0.1.76) answered a client 1.6 registered by its
   `public` field until the one-time client backfill had written it. The
   backfill mapped `type` to `applicationType`, kept the method `none` for
   public clients only, removed `public` and `type`, and linked every
   client to the MCP resource. It ran on staging, development and
   production on October 24, 2026, and a dry run after each found no client
   left and none for review. The demo has no OAuth clients.
2. The next release removed the backfill, that answer and the two fields.
   Convex refuses to deploy a schema that a stored row breaks, so a
   deployment where a client still holds `public` or `type`, such as one
   restored from a backup taken before the backfill, refuses the later
   release. Deploy the newest main commit that still has the backfill, from
   v0.1.76 (`1906eb2`) on, run `internal/oauthClientBackfill:run` as its
   file header says, and then deploy the later release
   (`docs/deployment.md`, "Recovery and compatibility").
3. `internal/microsoftAccounts:count` counts the Microsoft accounts, how many
   still use `sub`, and how many have no tenant recorded. Each person's next
   Microsoft sign-in moves theirs. If the move cannot happen, because
   another account already holds the `oid`, the sign-in goes to that account.

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
6. After the merge, verify the exact candidate on staging with the private
   fixture accounts: browser sign-in, consent approval and cancellation, the
   read-only refusal, permitted task changes, refresh, disconnect and
   reconnect. Hosted smoke tools can create and delete data, so use them only
   with explicit scope for the target and its writes, and keep fixture
   credentials outside this checkout.
7. Google and Microsoft sign-in and billing stay off and untested on staging,
   and so does email. The candidate's branch preview sends real mail, so try
   the email flows there ([deployment](deployment.md)). Passing tests does not
   show that these integrations work, so record each gap before a production
   release that affects them. A release still needs a separately authorized
   stable GitHub Release; this document does not authorize one.

### Checks to keep passing

- Discovery, registration, S256 PKCE, exact client and redirect binding,
  signed consent and scope limits work (`convex/tests/oauth.test.ts`).
- A client without a resource link is refused, also when it leaves the
  resource out, and so are an access token issued before the link went and
  the connection's webhook subscriptions. Foreign and repeated resource parameters fail for a linked
  one. An omitted resource keeps the canonical default, and refresh cannot
  widen its grant.
- The metadata on every path lists `none` as the only client
  authentication method and no introspection endpoint, and the token and
  revocation endpoints refuse a secret, an assertion and an `Authorization`
  header, the header with its challenge.
- The metadata lists no DPoP algorithms, and a token request with a `DPoP`
  header gets a Bearer token.
- Sign-out ends every access token of the session, also after more than 100
  refreshes, and a refresh after it still renews. A call that ends more than
  100 sessions ends the tokens of each. A sign-out whose session delete fails
  twice, or that Better Auth skipped, answers HTTP `503` and keeps the
  session and its cookie, and the browser client keeps the session to try
  again (`src/lib/authSession.test.ts`). A sign-out with an expired signed
  authorization request ends the session. The nightly cleanup deletes
  expired sessions through its delete trigger and ends their tokens at the
  expiry, and deletes spent OAuth tokens (`convex/tests/authRetention.test.ts`).
  A ban of an expired session ends a token a refresh issued after the
  expiry, a replay of a deleted refresh token still ends the grant while
  its hash is kept and is only refused once the job deleted the hash, and a
  password reset keeps the other sessions, the OAuth connection's access
  token and a personal token working (`convex/tests/oauth.test.ts`).
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
- Every app boot (`claimMySeats`), creating an organization and each call
  of a demo start read the caller's login with Qivo's own session check,
  `liveSessionUser` in `convex/betterAuth/sessions.ts`, through
  `convex/lib/authUser.ts`, not the adapter's `getAuthUser`, because
  loading Better Auth on each call is slow. It reads the session and user
  rows directly, so compare it with the release's rules for a live session
  and keep it as strict: the session exists, has not expired and is the
  token subject's, and that login exists. `convex/tests/identity.test.ts`
  and `convex/tests/demo.test.ts` refuse a caller without one, and
  `convex/tests/authTriggers.test.ts` keeps Better Auth out of these
  modules.

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
