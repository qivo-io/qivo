# Better Auth and the Convex adapter

Qivo runs Better Auth `1.7.21` with the official Convex adapter,
`@convex-dev/better-auth` `0.13.0`. `package.json` pins `better-auth`,
`@better-auth/core` and `@better-auth/oauth-provider` to the same release, and
the adapter to its own. This document says which releases Qivo can run and
why, what Qivo changes for the adapter, what changed with Better Auth 1.7 and
how to move to a later release. It does not authorize a production
deployment.

## The adapter and the releases Qivo can run

From October 24 to November 13, 2026, Qivo ran its own copy of the adapter in
`vendor/convex-better-auth/`, because the official adapter did not support
Better Auth 1.7 yet. Its release `0.13.0` of November 4, 2026 does, and the
owner decided on November 13, 2026 to use it and delete the copy, so that
Qivo keeps no adapter code of its own. Two things follow from that.

- **The OAuth provider's link index is declared as an ordinary index.** The
  adapter refuses a schema that declares a unique index of several fields,
  because it cannot enforce one, and its documentation lists the OAuth
  provider as incompatible for that reason. The provider declares one such
  index, `oauthClientResource` on `(clientId, resourceId)`, a client's link
  to a resource. `withOrdinaryLinkIndex` in `convex/lib/oauthProvider.ts`
  hands Better Auth the provider's tables with that index kept but no longer
  unique. Nothing Qivo serves can store a pair twice: the provider writes a
  link only when it registers a client, for a client id it made in that
  request. It stores a client whose id is a metadata document's URL, which
  two requests could name at once, only with its client discovery extension
  (`@better-auth/cimd`), which Qivo does not install, and
  `convex/tests/oauth.test.ts` shows that such a client id stores nothing.
  The provider's routes that link a client afterwards are not served
  (`convex/lib/authRoutes.ts`). A second row would change no answer either,
  because the provider and Qivo ask only whether a link exists, and a
  client's delete removes every link. Serving one of those routes or
  accepting such clients needs the pair kept unique some other way first.
  `convex/tests/betterAuthSchema.test.ts` fails when a provider release
  declares another such index. The adapter's maintainers do not test it with
  the OAuth provider, so the checks below are what shows that a release
  works. An open pull request,
  [convex/better-auth#471](https://github.com/convex/better-auth/pull/471),
  proposes that the adapter enforce these indexes. With a release that does,
  remove `withOrdinaryLinkIndex`.
- **Better Auth stays at the newest release the adapter works with.** Better
  Auth publishes a release on most days, and its
  [`SECURITY.md`](https://github.com/better-auth/better-auth/blob/main/SECURITY.md)
  says: "We only support the latest version of Better Auth. Older versions
  are not supported." The adapter's peer range, `>=1.7.16 <1.8.0`, also
  admits releases published after it. Better Auth `1.7.22` of November 12,
  2026 consumes a verification value with a query that compares a row id
  with `ne`, which adapter `0.13.0` refuses, so the OAuth code exchange fails
  on it (`convex/tests/oauth.test.ts`). `1.7.21` is the newest release whose
  tests pass. Move past it only with an adapter release that works with the
  newer one, and check the advisories of the releases in between meanwhile
  (see [Advisories](#advisories)).

### What the copy fixed, in adapter 0.13.0

Qivo's copy fixed these in the adapter it was taken from. Read from the
source of `0.13.0` on November 13, 2026, for a later release to recheck:

| The copy's fix | In `0.13.0` |
| --- | --- |
| A read of several pages resumes after the page it read, so a page that stops early is not read twice | Fixed |
| A single-row lookup reads on past a page with no match | Fixed |
| The queries for the values of an `in` clause merge on the fields their index orders by | Fixed |
| A lookup of only `OR` clauses answers null when none matches | Fixed |
| An update that matches no row answers null | Fixed |
| An `eq null` clause matches a field never written | Fixed |
| `consumeOne` and `incrementOne` run as one mutation each | Fixed |
| A second `in` clause of one lookup is applied to each row | Not fixed. With an index, the adapter applies only the first. No lookup of Better Auth or the OAuth provider has two. |
| A lookup that no index fully serves reads through the index that covers most of it | Not taken. The adapter scans the table and warns. `convex/betterAuth/schema.ts` holds the indexes, and a test in which a lookup scans fails. |
| A unique index of several fields is enforced | Not taken. The adapter refuses such an index (see above). |

## What changed with Better Auth 1.7

- **Adapter.** `consumeOne` and `incrementOne` are native component
  mutations, so they stay atomic. An `eq null` clause also matches a field
  Convex stores as absent, which refresh-token rotation relies on, so Qivo's
  own refresh claim (`claimRefreshToken`) is gone. The adapter rejects a
  second account with the same provider and account id. It reads a table
  through an index only when one starts with every field a lookup compares
  for equality, and scans the table otherwise, with a warning that names the
  index to add. Its schema generator knows the lookups of Better Auth itself,
  so `convex/betterAuth/schema.ts` adds the indexes the OAuth provider's
  lookups need, and a test in which a lookup scans fails
  (`convex/tests/env.setup.ts`).
- **The `convex()` plugin** no longer builds the `oidc-provider` plugin,
  which 1.7 removed. It serves a discovery document of its own at
  `/api/auth/convex/.well-known/openid-configuration`, which Qivo does not
  serve (`convex/lib/authRoutes.ts`); Convex reads keys from
  `/api/auth/convex/jwks` (`convex/auth.config.ts`). The JWT's issuer,
  audience, subject, claims and keys are unchanged, so nobody signs in again.
  A sign-in no longer answers with a token cookie. It clears that cookie, so
  no token of an earlier session outlives the sign-in, and the page asks
  `/api/auth/convex/token` for the new session's token, as it already did.
- **Schema.** `convex/betterAuth/schema.generated.ts` holds the 1.7 tables,
  among them `oauthResource`, `oauthClientResource` and
  `oauthClientAssertion`, and new optional fields on the token and client
  tables. `convex/betterAuth/schema.ts` adds `account.microsoftTenantId`
  and the indexes of the OAuth provider's lookups: a consent by its client
  and login and by its connection, the tokens of an authorization code, and
  the access and refresh tokens of a client and login, which the provider
  deletes when a revocation loses its refresh token to a rotation. It also
  holds the indexes of the nightly token cleanup. It no longer accepts
  `oauthClient.public` and `oauthClient.type`, which 1.6 wrote and 1.7
  dropped (see
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
  `oauthAccess.lookupAccess` compares on every MCP request. Better
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
  id they choose, so that a second attempt with the same id fails, such as
  `private_key_jwt` client assertions (`oauthClientAssertion`) and the
  verification reservations of the Magic Link, email OTP and Sign In with
  Ethereum plugins. Convex chooses every document id. The adapter keeps a
  reservation in the `verification` table unique by its identifier instead,
  and stores a row of any other table without the chosen id, so that row is
  not single-use. Qivo uses none of these features and has tested none of
  them with the adapter.
- **DPoP.** Better Auth 1.7 supports DPoP-bound tokens (RFC 9449), but Qivo
  has not tested their proof reservations with the adapter (see above), and
  `/mcp` checks no proof. Qivo issues Bearer tokens only: the token endpoint
  ignores a `DPoP` header, as a server without DPoP does, authorize refuses
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
  however many tokens the session holds. `oauthAccess.lookupAccess`
  refuses every access token of the session created before that time, and a
  scheduled cleanup deletes the record once those tokens have expired
  (`OAUTH_ACCESS_TOKEN_TTL_SECONDS` in `convex/lib/oauth.ts`, plus a minute).
  Before it stores that record, the trigger deletes the session's
  notification row (`notification_sessions`, through
  `convex/model/notificationSessionEnd.ts`) in the same transaction, also on
  the demo, where it stores no record.
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
- **A sign-out always signs the browser out.** The adapter's cross-domain
  client forgets the session in the browser as it sends the sign-out, so the
  person is signed out there whatever the server answers, also offline
  (`signOut` in `src/lib/authSession.ts`). Better Auth answers a sign-out
  whose session delete failed with HTTP `200`, and Qivo adds nothing to that
  (owner decision, November 13, 2026). Such a failure is rare, nobody can use
  the session from that browser, and it ends at its expiry, at most 7 days
  later. Until then the access tokens issued in it keep working, each for at
  most an hour. Qivo's before hook on `/sign-out` (`oauthHooks`) drops the
  signed authorization request that the app's OAuth client adds to a
  sign-out from the connect page, which the provider would refuse once it
  expires. A press while a sign-out runs joins it, and the controls show that
  it runs. The client applies the cleared cookies of a completed sign-out to
  the browser's stored session as it is when the answer arrives. A session
  that another tab of the same page stored while the request ran is therefore
  forgotten too, and that tab signs in again. Qivo's copy kept such a
  session. The app and the operator console store their sessions apart, so
  neither signs the other out. A login removal from the console deletes the
  login and then its sessions and tokens, and `/mcp` refuses every token of a
  missing or banned login.
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

`npm audit` reports no vulnerability in Better Auth or the adapter (November
13, 2026). Better Auth publishes some advisories only as repository
advisories, which `npm audit` does not read, so each was checked against the
code, those below on October 24, 2026 and the later ones on November 13,
2026.

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
  (high, organization invitations) is fixed in 1.7.16. Qivo does not use the
  organization plugin.
- Twelve advisories of November 3, 2026 are fixed in 1.7.16, which Qivo's
  release includes. None applied to Qivo on 1.7.12. They cover the phone
  number, email OTP, passkey, organization, Stripe, Expo and Electron
  plugins, the Kysely and Drizzle adapters, secondary storage and the
  cookie cache, none of which Qivo uses, email change, which Qivo does not
  turn on, and, in
  [GHSA-9hm7-xhfp-cx58](https://github.com/better-auth/better-auth/security/advisories/GHSA-9hm7-xhfp-cx58)
  (medium, an unverified provider email treated as verified), generic OAuth,
  Zoom and providers that send `email_verified` as a string. Qivo signs in
  with the built-in Google and Microsoft providers.
- No advisory names a release from 1.7.17 to 1.7.23. The release notes of
  1.7.22 and 1.7.23, which Qivo does not run yet, list bug fixes only.
- The adapter's four advisories
  ([GHSA-j8qq-g9pm-v3c2](https://github.com/convex/better-auth/security/advisories/GHSA-j8qq-g9pm-v3c2),
  [GHSA-pgx2-m66h-x29f](https://github.com/convex/better-auth/security/advisories/GHSA-pgx2-m66h-x29f),
  [GHSA-9qq3-v9g3-cxhw](https://github.com/convex/better-auth/security/advisories/GHSA-9qq3-v9g3-cxhw)
  and
  [GHSA-4qvm-r4pr-v3wg](https://github.com/convex/better-auth/security/advisories/GHSA-4qvm-r4pr-v3wg))
  are fixed in 0.12.6 and 0.12.7, before the release Qivo runs. Their
  conditions never held for Qivo: its trusted origins are exact
  (`appOrigins` in `convex/lib/deployment.ts`), its `baseURL` is a fixed
  string and it does not use the two-factor plugin.

The other repository advisories cover releases before 1.6.31 or plugins
Qivo does not use (SSO, SCIM, Stripe, passkey, API keys).

## Moving to a later Better Auth release

1. Read the release notes of every release since `1.7.21`, the
   upgrade guide (for 1.7, [Upgrading to Better Auth 1.7](https://www.better-auth.com/docs/guides/1-7-upgrade-guide)) and the
   repository's [security advisories](https://github.com/better-auth/better-auth/security/advisories),
   which `npm audit` does not show.
2. Pin `better-auth`, `@better-auth/core` and `@better-auth/oauth-provider` to
   the same release, inside the peer range of the `@convex-dev/better-auth`
   release Qivo pins, and run `npm ci` with peer checks on. Do not use
   `--force`, `--legacy-peer-deps` or an override for Better Auth or the
   adapter.
3. Move the adapter when a release of it works with a newer Better Auth. Read
   its [changelog](https://github.com/convex/better-auth/blob/main/CHANGELOG.md),
   its upgrade guide and its
   [security advisories](https://github.com/convex/better-auth/security/advisories).
   Then push to a disposable local backend, which regenerates
   `convex/betterAuth/_generated/`. A Better Auth release inside the peer
   range can still send a query the adapter refuses, as 1.7.22 did, so the
   tests decide, not the range.
4. Regenerate the schema from `convex/betterAuth`:
   `npx auth@<release> generate --output schema.generated.ts`.
   Format it, put the relative path back in its header, read the diff, and
   keep `schema.ts`'s additions in step
   (`convex/tests/betterAuthSchema.test.ts` checks the account table and the
   link index). The generator leaves out the indexes of the OAuth provider's
   lookups, which `schema.ts` adds. A test in which a Better Auth lookup
   scans a table fails and names the index to add
   (`convex/tests/env.setup.ts`). A field the new schema drops stays optional
   in `schema.ts` until a backfill removes it.
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
  100 sessions ends the tokens of each. A sign-out leaves the browser with
  no session, also when the server answers with a failure or cannot be
  reached (`src/lib/authSession.test.ts`). A sign-out with an expired signed
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
- The HTTP router (`convex/http.ts`) loads no Better Auth when a request
  starts. It registers the `/api/auth/` routes and their CORS itself
  (`registerAuthRoutes` in `convex/lib/authRoutes.ts`), and the sign-in,
  OAuth token, registration and revocation, and metadata handlers import
  `convex/auth.ts` inside the handler, after the refusals that need no
  Better Auth. `convex/tests/authTriggers.test.ts` walks the router's static
  imports and fails when one reaches Better Auth, `convex/auth.ts`,
  `convex/lib/oauthProvider.ts` or the adapter. `convex/tests/authHttp.test.ts`
  pins the status, every header and the body of the sign-in, OAuth and
  metadata answers, the router's table of those routes and a sweep of every
  route `convex/lib/authRoutes.ts` lists, for a regular deployment and the
  demo, so a release that changes an answer or a CORS header fails it.
  `convex/tests/authLoadRefused.test.ts` shows that a refused import fails
  those handlers with an error, never a cookie, and takes no demo
  admission, while every refusal before the import still answers, and that
  a misconfigured app origin fails the routes `registerAuthRoutes` serves
  under `/api/auth/` with an error and no CORS echo. Every app and demo
  build calls the sign-in route, and outside the demo the token and metadata
  routes, after Convex pushes the functions, and fails when one does not
  answer as expected (`scripts/auth-probe.mjs`; see
  [deployment](deployment.md)).
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
  `convex/lib/authUser.ts`, because loading Better Auth on each call is
  slow. Qivo therefore does not call the adapter's `getAuthUser` and
  `safeGetAuthUser`. `liveSessionUser` reads the session and user rows
  directly, so compare it with the release's rules for a live session and
  keep it as strict: the session exists, has not expired and is the token
  subject's, and that login exists. `convex/tests/identity.test.ts` and
  `convex/tests/demo.test.ts` refuse a caller without one, and
  `convex/tests/authTriggers.test.ts` keeps Better Auth out of these
  modules.
- Every REST and MCP call made with a personal token or an OAuth access
  token reads the person's login for its ban, and a call with an OAuth
  access token also reads the token, its client and the client's resource
  link, through the queries in `convex/betterAuth/lookups.ts`, not the
  adapter's `findOne`, which loads Better Auth. The OAuth check itself is in
  `convex/oauthAccess.ts`. Each query reads its row through the index
  `findOne` would use and answers only the fields Qivo checks, so compare
  them with the release's tables: the user's `banned` and `banExpires`, the
  client's `clientId` and `disabled`, the resource link's `clientId` and
  `resourceId`, and the access token's `token`, `referenceId`, `userId`,
  `clientId`, `sessionId`, `expiresAt`, `revoked`, `confirmation` and
  `scopes`. `convex/tests/oauth.test.ts` checks the grant's refusals with no
  adapter function running, and `convex/tests/authTriggers.test.ts` keeps
  Better Auth out of every module a REST or MCP call runs, following each
  nested call.

## What Qivo does not take from the adapter

- **Route registration.** The adapter's `registerRoutes` builds a Better Auth
  instance while the HTTP router loads, and Convex loads the router for every
  HTTP action, so every REST, MCP and image request would pay for Better
  Auth. Its `registerRoutesLazy` builds none then, but still imports the
  module that does. Qivo registers the `/api/auth/` routes itself in
  `convex/lib/authRoutes.ts` (`registerAuthRoutes`) and imports
  `convex/auth.ts` only inside the handlers that need it (`convex/http.ts`).
  Compare a later release's `registerRoutes` paths, methods and CORS options
  with that function. The adapter's routes also set the request's host and
  forwarded headers to an origin the app trusts, for a Better Auth that reads
  its base URL from the request. Qivo sets a fixed `baseURL`, so its handler
  passes the request on as it arrived.
- **The caller's login.** See the last two checks above.
- **The discovery document and the key rotation routes** of the `convex()`
  plugin, which `convex/lib/authRoutes.ts` does not list.

If a release of the adapter or of Better Auth breaks one of the checks above,
stay on the releases that pass, and report the failure to the adapter's
repository. Do not copy the adapter back into Qivo without the owner's
decision.
