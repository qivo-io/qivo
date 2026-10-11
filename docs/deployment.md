# Deployment and releases

Qivo separates persistent staging, customer production, the public demo and
temporary branch previews. Each uses a separate Convex backend. Production
retains its existing backend and customer data.

| Source event | Destination |
| --- | --- |
| Feature branch push | Vercel branch preview with its own Convex preview deployment |
| Successful main CI and secret scanning | Staging app, website and docs at `preview.qivo.io` |
| **Deploy staging** run by hand from main | The same, used after a private website merge |
| **Prepare release** run by hand from main | A draft GitHub Release for the commit staging serves. Deploys nothing |
| Publishing that draft (a stable release) | App at `qivo.io`, matching website/docs and the public demo |

```text
 feature branch ──► CI + secret scan, branch preview (own empty Convex backend)
       │
       ▼ pull request merged
 public main ─────► CI + secret scan ──► Deploy staging ◄── private main (website)
                                              │
                                              ▼
                          preview.qivo.io: app + website + docs, staging backend
                          records the exact app and website commits it served
                                              │
                         Prepare release ◄────┘  (draft release, nothing deployed)
                                              │
                         you publish the draft
                                              ▼
                          Production release: qivo.io, website/docs, demo.qivo.io
                          deploys exactly the pair staging recorded
```

Normal deployments never provision fixture users, seed a workspace or reset
data. Staging starts with its own synthetic data and private test accounts.
Its auth secrets, storage, API credentials and backend are separate from
production. Mail delivery, social sign-in and billing are not configured in
staging, so those flows cannot be tested there. Do not import customer data
into staging or reuse production service credentials there.

## Shipping a change

1. Merge the reviewed pull request to main. CI runs, then **Deploy staging**
   updates `preview.qivo.io`, normally within five minutes.
2. Review the change at `https://preview.qivo.io` with a synthetic account.
3. In GitHub Actions, run **Prepare release** from main. Leave the version
   empty for the next patch version, or enter one such as `v1.2.0`. It refuses
   until staging has verified the current main commit. If **Deploy staging**
   failed, run it again by hand from main, or fix the cause on main first.
4. Open the draft release it links. Its first section names the app and
   website commits and links their changes since the previous release. Do not
   change the draft's tag or target. To ship something else, run **Prepare
   release** again. It deletes the older drafts it made. Delete any draft you
   made yourself and will not publish, because publishing it later deploys its
   own, older commit.
5. Publish the draft. **Production release** deploys it in about two minutes.
   Check `https://qivo.io/version.json` for the app commit.

A release can also be created by hand in the GitHub interface. It must target
a main commit that already passed staging, or production refuses it. That
version number is then used up, because release tags cannot be moved or
deleted. Prefer **Prepare release**.

Private website changes merged to qivo-internal main reach staging with the
next public main deployment. To stage one at once, run **Deploy staging** by
hand from main. It needs no inputs and deploys the current commits of both
mains.

## Staging

`.github/workflows/staging.yml` starts after main CI succeeds, or by hand from
main. The deployment script verifies both `ci.yml` and `secrets.yml` succeeded
for the exact main commit and refuses an older commit. Vercel builds the
private website from qivo-internal's current main and reports which commit it
built. The script then deploys the app, checks both public source manifests
and records a successful staging deployment ("receipt") naming the exact app
and website commits. A run that fails records nothing.

Staging includes `/app`, `/admin`, marketing pages, pricing and rendered docs.
Both Vercel staging projects protect all deployments, including their custom
domains. The application keeps normal sign-in and authorization. Its website
proxy sends a project-scoped automation bypass header to the protected website
origin. That credential is server-side only and never appears in a route,
browser bundle, query string or response cookie.

Branch previews remain independent and do not share staging data. Private
operators can provision synthetic data deliberately using the private setup
instructions. A later deployment preserves it.

qivo-internal has no branch protection on the current GitHub plan. Anything on
its main appears on staging and ships with the next release. The draft release
links the private website changes so they can be reviewed before publishing.

## Production release

`.github/workflows/release.yml` calls the shared deployment workflow, whose
definition comes from the admin-created release tag. The deployment script it
runs comes from main. Before writing anything it checks that:

- a person published a stable, non-draft release whose tag is a `vX.Y.Z` tag
  on main history;
- `ci.yml` and `secrets.yml` succeeded for that exact commit;
- the release has the highest version tag, so re-running or republishing an
  older release cannot roll production back;
- staging recorded a successful deployment of that commit before the release
  was published.

The website commit comes from the newest such staging record, so production
receives the pair staging verified. Re-running the workflow selects the same
pair. A staging record only counts if it was written during the successful
staging run attempt it names. If two records name the same attempt, or the run
behind a record was deleted, the release stops instead of guessing. Releases
published before this flow existed (v0.1.2 and older) cannot be re-run. Jobs
are serialized and are not canceled midway by another release.

If a release fails because staging had not verified its commit when it was
published, re-running it cannot help. Wait for **Deploy staging**, then
publish a new, higher version.

The workflow inspects all target projects before writing anything. Repository
bindings, custom domains and their existing environment identities must match.
It then deploys the website, app and demo, and verifies their source
manifests, public routes and application assets before recording success.
These GET checks do not replace authenticated end-to-end review in staging.
The public demo is not staged. It deploys from the same app commit.

Vercel production projects, and both staging projects, accept production
deployments only through the REST API. Git pushes and deploy hooks cannot
deploy them. This policy is the enforcement and must stay enabled; the
deployment script refuses to run if it is loosened. It does not identify the
caller. Any token with access to a production project can create a production
deployment, so those tokens must stay limited to the release workflow. `vercel.json` also
turns off Git deployments of main, which only removes the blocked deployments
and failed statuses Vercel would otherwise create on every main push. The
staging application project still reports a blocked preview on branch pushes.
That status is expected and harmless.

## Rollback and hotfixes

Fix forward when possible. Merge the fix to main, let staging pass, then
prepare and publish a new release.

To restore an earlier app, publish a new, higher version that targets the
older main commit, from the GitHub interface. That commit needs a successful
staging record, which every commit that passed staging keeps. The release also
restores that commit's website and docs and deploys its Convex functions, so
it is only safe when the backend schema and data remain compatible. Vercel
Instant Rollback changes only the frontend, leaves the Convex functions in
place and stops Vercel from moving the domain to later deployments until the
rollback is undone in the Vercel dashboard.

## Environment configuration

The `staging` and `production` GitHub environments provide these variables.
Values are deployment identifiers and public origins, not credentials.

| Variable | Meaning |
| --- | --- |
| `QIVO_APP_ORIGIN` | `https://preview.qivo.io` or `https://qivo.io` |
| `VERCEL_TEAM_ID` | Owning Vercel team |
| `VERCEL_APP_PROJECT_ID` | Application project for this environment |
| `VERCEL_SITE_PROJECT_ID` | Website project for this environment |
| `VERCEL_DEMO_PROJECT_ID` | Public demo project, production only |

The former `QIVO_SITE_REVISION` variables are no longer read. Release tags
from before this change still pass them, and the deployment script ignores
them.

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

The website projects have their own persistent `QIVO_ENVIRONMENT`. Before each
build the workflow sets `QIVO_SOURCE_REVISION` to the app commit, `SITE_ORIGIN`,
and `QIVO_SITE_REVISION`. That is an exact website commit in production and
`main` in staging, where the website build records the commit Vercel checked
out. The
staging app also has `QIVO_SITE_PROTECTION_BYPASS`, scoped to the staging
website project. Never prefix a secret with `VITE_`.

## Desktop installers

Desktop installers are not published yet. **Desktop test build**, run by hand,
builds unsigned Windows and Linux installers from any ref as workflow artifacts.
It holds no signing credentials, never creates or changes a release and builds
no update feed into them. The installed
shell loads `https://qivo.io/app`, so web releases reach desktop users without
a new installer. See [desktop/README.md](../desktop/README.md).

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
