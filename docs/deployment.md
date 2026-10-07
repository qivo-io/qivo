# Deployment and releases

Qivo separates persistent staging, customer production, the public demo and
temporary branch previews. Each uses a separate Convex backend. Production
retains its existing backend and customer data.

| Source event | Destination |
| --- | --- |
| Successful main CI and secret scanning | Full staging app and website at `preview.qivo.io` |
| Trusted feature branch push | Vercel branch preview with its own Convex preview deployment |
| Publish a stable GitHub Release | App at `qivo.io`, matching website/docs and public demo |
| Push a version tag | Windows and Linux installer candidates attached to a draft release |

Normal deployments never provision fixture users, seed a workspace or reset
data. Staging starts with its own synthetic data and private test accounts.
Its auth secrets, storage, mail handling, OAuth callbacks, API credentials and
billing sandbox remain separate from production. Do not import customer data
into staging or reuse production service credentials there.

## Staging

`.github/workflows/staging.yml` starts after main CI succeeds. The deployment
script verifies both `ci.yml` and `secrets.yml` succeeded for that exact main
commit. An older queued run cannot replace a newer main build.

Staging includes `/app`, `/admin`, marketing pages, pricing and rendered docs.
Both Vercel staging projects protect all deployments, including their custom
domains. The application keeps normal sign-in and authorization. Its website
proxy sends a project-scoped automation bypass header to the protected website
origin. That credential is server-side only and never appears in a route,
browser bundle, query string or response cookie.

Branch previews remain independent and do not share staging data. Private
operators can provision synthetic data deliberately using the private setup
instructions. A later deployment preserves it.

The private website source is pinned by `QIVO_SITE_REVISION`, a full approved
commit SHA in each GitHub environment. To review private-only website changes,
update the staging pin and run **Deploy staging** manually from `main`, passing
the exact current public main SHA as `app_revision`. Both main checks must
already have passed. A release requires a successful staging record for the
same app and website revision pair.

## Production release

1. Merge reviewed application changes to main and review the resulting staging
   application. Exercise sign-in, application operations, REST/MCP, file
   handling and any changed integrations with synthetic accounts.
2. Set the production website pin to the exact website commit verified in
   staging. Create a stable version tag such as `v1.4.0` at the tested main
   commit. Tags are protected from modification and deletion.
3. Prepare the release notes and any installer assets in a draft GitHub
   Release. Tag pushes alone do not deploy the hosted production application.
4. Publish the completed stable release. Drafts, prereleases and automated
   publication do not authorize production.

`.github/workflows/release.yml` calls the shared deployment workflow. The
deployment tooling comes from protected main and checks the release tag's
exact SHA against main history, successful quality and secret-scanning runs,
and the completed staging workflow and deployment record. It never deploys a
moving branch in place of the selected release. Jobs are serialized and are
not canceled midway by another release.

The workflow inspects all target projects before writing anything. Repository
bindings, custom domains and their existing environment identities must match.
It then deploys the pinned website, app and demo, and verifies their source
manifests, public routes and application assets before recording success.
These GET checks do not replace authenticated end-to-end review in staging.

Vercel production projects accept deployments only from the authorized REST
API workflow. Git pushes and deploy hooks cannot deploy production. Disabling
domain auto-promotion alone is insufficient because the application build also
deploys Convex functions. Deployment keys remain scoped to their Vercel project
and environment. Workflow tokens are scoped separately to the application,
website and demo projects.

The website build receives `QIVO_SOURCE_REVISION` for the exact application
commit and `QIVO_SITE_REVISION` for its own source commit. It never falls back
to public main in a hosted build. The former main-triggered docs hook is no
longer used. Production docs and the public demo therefore follow the release.

## Environment configuration

The `staging` and `production` GitHub environments provide these variables.
Values are deployment identifiers and public origins, not credentials.

| Variable | Meaning |
| --- | --- |
| `QIVO_SITE_REVISION` | Approved full private website commit SHA |
| `QIVO_APP_ORIGIN` | `https://preview.qivo.io` or `https://qivo.io` |
| `VERCEL_TEAM_ID` | Owning Vercel team |
| `VERCEL_APP_PROJECT_ID` | Application project for this environment |
| `VERCEL_SITE_PROJECT_ID` | Website project for this environment |
| `VERCEL_DEMO_PROJECT_ID` | Public demo project, production only |

The corresponding environment secrets are `VERCEL_APP_TOKEN`,
`VERCEL_SITE_TOKEN`, `VERCEL_DEMO_TOKEN` for production, and
`VERCEL_APP_PROTECTION_BYPASS` for protected staging health checks. Each Vercel
token has access to one project. Do not replace them with a team-wide token.

Each stable Vercel application project sets `QIVO_ENVIRONMENT`,
`QIVO_APP_ORIGIN`, `QIVO_CONVEX_DEPLOYMENT` and its matching
`CONVEX_DEPLOY_KEY` in its Production scope. Stable staging uses a dedicated
Convex project with its own deployment key, even though Vercel calls this scope
Production. Branch-preview scope uses a Convex preview key and
`QIVO_ENVIRONMENT=preview`. The public demo uses `QIVO_ENVIRONMENT=demo` and
its existing dedicated demo settings.

Convex also stores the explicit `QIVO_ENVIRONMENT` and exact `SITE_URL`.
Stable builds check them against their intended destination before pushing
backend code. Preview builds set their newly claimed branch backend's origin
and environment. No deployment infers safety from a hostname alone.

The website projects have their own persistent `QIVO_ENVIRONMENT`. The workflow
updates only the nonsecret source pins and `SITE_ORIGIN` before each build.
The staging app also has `QIVO_SITE_PROTECTION_BYPASS`, scoped to the staging
website project. Never prefix a secret with `VITE_`.

## Recovery and compatibility

The website, frontend and backend are separate deployments. A release can
partly succeed before a later step fails. Inspect the failed workflow and the
recorded source manifests before retrying. Do not automatically reset data or
restore a database to compensate for a failed build.

Backend changes must remain compatible with open browser tabs, desktop clients
and already scheduled jobs. Introduce optional schema fields first, migrate
existing records deliberately, and remove old fields/functions only after old
clients no longer need them. Test migrations with representative synthetic
data and retain verified production backups before destructive changes.

A frontend rollback changes the served application build. It does not roll
back Convex code, schema changes, stored files or customer writes. A database
restore can discard newer customer changes and requires a separate reviewed
recovery decision. Preserve backend identities, domains and signing secrets.
