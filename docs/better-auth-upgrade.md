# Deferred Better Auth security upgrade

The OAuth provider upgrade is deferred until a published Convex Better Auth
adapter supports a patched Better Auth 1.7 or later release. This is pending
security work, not a resolved advisory. Check compatibility when reviewing
authentication dependency updates. This document does not schedule an
automatic check or authorize a production deployment.

## Current blocker

Verified on October 7, 2026, Qivo pins `better-auth`, `@better-auth/core` and
`@better-auth/oauth-provider` to `1.6.31`. The latest published
`@convex-dev/better-auth` is `0.12.5`, whose Better Auth peer range is
`>=1.6.11 <1.7.0`.

[PR #3](https://github.com/qivo-io/qivo/pull/3) proposed upgrading only
`@better-auth/oauth-provider` to `1.7.0`. That version requires `better-auth`
and `@better-auth/core` at `^1.7.0`, so `npm ci` fails with `ERESOLVE`. The PR
is closed and its branch removed in favor of this checklist. Upgrading the
other packages to 1.7 would still conflict with the current Convex adapter.

Resume when the adapter's published peer range **includes** the selected
patched release. Its minimum need not become 1.7. Confirm the adapter's
release notes and migration support as well as its package metadata. The
following read-only commands check the currently published versions and
constraints. Inspect the exact candidate versions before selecting them.

```sh
npm view @convex-dev/better-auth@latest version peerDependencies --json
npm view @better-auth/oauth-provider@latest version peerDependencies --json
```

## Advisory and interim safeguards

[GHSA-p2fr-6hmx-4528](https://github.com/advisories/GHSA-p2fr-6hmx-4528)
describes OAuth resource indicators that are not bound to the authorization
grant. A client may obtain tokens for another allowed audience. The advisory
identifies `1.7.0-beta.4` and subsequent 1.7 releases as patched and states
that the stable 1.6 line remains unpatched. The compatible `1.6.33` patch
does not resolve this advisory.

The current application source limits the provider to one canonical MCP
audience and uses opaque access tokens. Qivo also validates resource
parameters, stores an immutable resource binding on each grant and checks
that binding during access and refresh. These safeguards mitigate the
reported cross-audience scenario; they do not patch the dependency or remove
the audit finding. See [MCP authorization](mcp.md) for the current contract.
Source safeguards apply to a hosted environment only after it deploys that
source. Check its deployed revision before relying on them.

Keep the security alert and audit finding visible. Closing PR #3 does not
resolve the advisory. Do not dismiss the alert, suppress the finding, add
another audience, or use `--force`, `--legacy-peer-deps` or dependency
overrides to bypass the compatibility blocker.

## Coordinated migration

1. Start a new implementation branch from current main. Upgrade the supported
   Convex adapter, `better-auth`, `@better-auth/core` and
   `@better-auth/oauth-provider` together. Regenerate the lockfile and confirm
   that clean `npm ci` succeeds with peer checks enabled.
2. Review the [1.7 migration changes](https://github.com/better-auth/better-auth/releases/tag/v1.7.0)
   and those of the selected release. Adapt `convex/lib/oauthProvider.ts`
   from `validAudiences` to the supported resource configuration. Review its
   callbacks, signed consent query, `referenceId` and `verificationValue`
   handling, plus `convex/lib/oauthAdapter.ts` and `convex/betterAuth/oauth.ts`.
   Preserve atomic refresh claims, replay rejection and grant ownership.
3. Regenerate and review `convex/betterAuth/schema.generated.ts` and affected
   generated types through the supported Convex adapter workflow. Preserve
   the custom consent index in `convex/betterAuth/schema.ts`. Review OAuth
   resource fields and links, and changed client fields. Account issuer
   migration depends on the selected release and existing schema. Direct
   upgrades from `1.6.31` to `1.7.3` or later need no issuer backfill. If the
   database adopted the `1.7.0` through `1.7.2` issuer schema, plan cleanup
   through the supported Convex workflow. See the
   [1.7.3 release notes](https://github.com/better-auth/better-auth/releases/tag/v1.7.3).
   Review existing Microsoft account identity handling even while staging
   social login remains disabled.
4. Rehearse a data-preserving migration using synthetic records in the old
   schema on an explicitly authorized isolated backend. Preserve user IDs,
   credential hashes, profile links and grant bindings. Retain
   `oauth_connections`, `oauth_credential_uses` and their replay tombstones.
   Never seed, reset or copy customer data into staging to test the upgrade.
5. Record how existing sessions, clients and grants behave after migration,
   any required reauthentication, the deployment order and a recovery plan.
   Test recovery with synthetic data. Reverting package versions alone may
   not reverse schema or account identity changes. Do not run an upstream
   migration command against a hosted database without verifying its Convex
   support and obtaining the required target authorization.

## Verification and release conditions

Run `npm ci`, `npm run desktop:install` and `npm run verify:local` sequentially
with at most two test workers. Preserve the existing OAuth, auth-options,
CORS and session tests. Add focused migration coverage for old records as
well as newly created accounts, clients and grants. Verify the following
behaviors after the upgrade.

- Discovery, client registration, S256 PKCE, exact client and redirect
  binding, signed consent and scope limits still work.
- Foreign and repeated resource parameters fail. An omitted resource retains
  the documented canonical default, and refresh cannot expand its grant.
- Expiry, disconnect, reconnect, replay detection, concurrent code exchange
  and concurrent refresh preserve access control and independent grants.
- App and admin sessions remain separate. Browser login can continue to
  consent, while public machine-endpoint CORS does not grant cookie access.

After local checks pass, verify the exact candidate on isolated staging with
private fixture accounts. Cover browser sign-in, consent approval and
cancellation, read-only refusal, permitted task changes, refresh, disconnect
and reconnect. Hosted smoke tools can create and delete data; use them only
with explicit scope for the target and those writes. Keep fixture credentials
outside the public checkout.

Email, Google/Microsoft sign-in and billing remain disabled and untested
until their separate test setup is authorized. Passing core tests does not
establish that these integrations work. Record those gaps and resolve
integration migration requirements before a production upgrade that affects
them.

Confirm the selected dependency is outside the advisory's affected range and
that `npm audit` no longer reports this advisory. Update this document, the
MCP security notes and the `AGENTS.md` reminder with the verified versions and
result. Follow [deployment and release operations](deployment.md) for CI,
staging and exact-commit release checks. Production still requires a
separately authorized stable GitHub Release; dependency compatibility alone
does not authorize deployment.
