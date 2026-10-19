# Deployment and releases

Qivo separates persistent staging, customer production, the public demo and
temporary branch previews. Each uses a separate Convex backend. Production
retains its existing backend and customer data. One deployment serves the
website (`/`, `/docs/`, `/pricing/`), the planner (`/app`) and the operator
console (`/admin`), so every deployment below is one commit of this
repository.

| Source event | Destination |
| --- | --- |
| Feature branch push | Vercel branch preview, website included, with its own Convex preview deployment |
| Successful main CI and secret scanning | Staging website, docs and app at `preview.qivo.io` |
| **Deploy staging** run by hand from main | The same, for example after a provider failure |
| **Prepare release** run by hand from main | A draft GitHub Release for the commit staging serves. Deploys nothing |
| Publishing that draft (a stable release) | Website, docs and app at `qivo.io`, and the public demo |

```text
 feature branch ──► CI + secret scan, branch preview (own empty Convex backend)
       │
       ▼ pull request merged
 main ─────► CI + secret scan ──► Deploy staging
                                       │
                                       ▼
                     preview.qivo.io: website + docs + app, staging backend
                     records the exact commit it served
                                       │
                    Prepare release ◄──┘  (draft release, nothing deployed)
                                       │
                    you publish the draft
                                       ▼
                     Production release: qivo.io and demo.qivo.io
                     deploys exactly the commit staging recorded
```

Normal deployments never provision fixture users, seed a workspace or reset
data. Staging starts with its own synthetic data and private test accounts.
Its auth secrets, storage, API credentials and backend are separate from
production. Mail delivery, social sign-in and billing are not configured in
staging, so those flows cannot be tested there. Do not import customer data
into staging or reuse production service credentials there.

## Shipping a change

Website, docs and app changes all ship the same way.

1. Merge the reviewed pull request to main. CI runs, then **Deploy staging**
   updates `preview.qivo.io`, normally within five minutes.
2. Review the change at `https://preview.qivo.io` with a synthetic account.
3. In GitHub Actions, run **Prepare release** from main. Leave the version
   empty for the next patch version, or enter one such as `v1.2.0`. It refuses
   until staging has verified the current main commit. If **Deploy staging**
   failed, run it again by hand from main, or fix the cause on main first.
4. Open the draft release it links. Its first section names the commit and
   links the changes since what `qivo.io` serves now. If `qivo.io` already
   serves that commit, the run warns that publishing only redeploys it and
   uses up the version. That is still allowed, for example to redeploy a demo
   whose last deploy failed. Do not change the draft's tag or target. To ship
   something else, run **Prepare release** again. Once the new draft exists,
   it deletes the older drafts it made. The Actions run summary repeats these
   instructions. The release text leaves them out, because a published release
   keeps its text. Delete any draft you made yourself and will not publish,
   because publishing it later deploys its own, older commit.
5. Check that `https://preview.qivo.io/version.json` still names the draft's
   commit, because each new main commit replaces what staging serves. If it
   names a newer commit, run **Prepare release** again. Otherwise review the
   change there and publish the draft. **Production release** deploys it in
   about two minutes. Check `https://qivo.io/version.json` for the commit.
6. If the release adds a one-time backfill, such as
   `internal/attachmentScopeBackfill`, run it on each hosted deployment once
   that deployment serves the release, with the owner's approval for each
   run, as the backfill's header says. Deployments never run it on their own.

A release can also be created by hand in the GitHub interface. It must target
a main commit that already passed staging, or production refuses it. That
version number is then used up, because release tags cannot be moved or
deleted. Prefer **Prepare release**.

## Staging

`.github/workflows/staging.yml` starts after main CI succeeds, or by hand from
main. The deployment script verifies both `ci.yml` and `secrets.yml` succeeded
for the exact main commit and refuses an older commit. It deploys that commit,
checks the public manifest, the website pages and their assets, and then
records a successful staging deployment ("receipt") naming the commit. A run
that fails records nothing.

The staging Vercel project protects all deployments, including its custom
domain, so the website pages on `preview.qivo.io` need a Vercel sign-in too.
The application keeps normal sign-in and authorization. The website build
marks every page outside production `noindex` and publishes a `robots.txt`
that disallows crawling.

The `qivo` Vercel project creates branch previews. They remain independent and
do not share staging data. The `qivo-staging` project serves only persistent
staging and has preview deployment creation disabled. Private operators can
provision synthetic data deliberately using the private setup instructions.
A later deployment preserves it.

### End-to-end API check

`scripts/staging-check.mjs` checks the REST API, MCP and OAuth consent on
staging with a real browser and real credentials. It signs in as the
Northstar fixture admin with a password, creates two personal tokens, a
Standard and a Viewer agent with their keys, and two OAuth connections on the
consent screen, one with **Allow changes** and one without. With each it
checks reads, writes, refusals, attachments, activity attribution and
revocation, and the text, name, comment and request size limits. Its uploads
check that an upload URL stores one file, and one upload is a file at the
organization's per-file limit (20 MiB by default), sent through a REST upload
ticket, confirmed, downloaded and deleted again, which shows whether the
deployment takes a body that large. It also
checks task progress, last comment times, delay and project completion, the
rule that a subtask in an archived project makes no group, and in the browser
the search on **Settings → Projects → Archived tasks**. Everything it creates
carries a run tag such as `stgchk-1a2b3c`, and its tasks live in projects it
creates. It deletes all of it at the end, also after a failure. Its deleted
projects and tasks then wait in Deleted items for 30 days, where an admin can
delete them for good, and OAuth client registrations stay, because they
cannot be deleted. Run it from the application checkout through the private
staging helper, which supplies the deployment, the fixture credentials and
the protection bypass:

```sh
"${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-staging" \
  node scripts/staging-check.mjs --staging --comment-cap
```

`--comment-cap` also fills one task to its 400 comments and pages through
them with **Show earlier comments** in the task window. The script keeps
each person and agent under 200 requests a minute, so a run with
`--comment-cap` takes 4 to 8 minutes against a local backend and an
estimated 8 to 15 minutes on staging. A tool that stops a foreground command
after a few minutes would end the run before its cleanup, so start it in its
own session with its output in a log file, which holds no secrets, and wait
at least 30 minutes before treating it as stuck:

```sh
setsid "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-staging" \
  node scripts/staging-check.mjs --staging --comment-cap \
  > "${TMPDIR:-/tmp}/staging-check.log" 2>&1 < /dev/null &
```

The run is over when the log has a `DONE` line with the number of passed,
failed and skipped checks; the exit code is 0 only when nothing failed.
Ctrl-C, `SIGTERM` and `SIGHUP` stop a run after its current step and clean
up; a second signal exits at once without cleanup. `nohup` alone does not
help, because the script handles `SIGHUP` itself.

With `--staging` the script refuses any environment but staging,
any app other than `preview.qivo.io` and any backend other than the one that
app uses. `--local` runs it against a disposable local backend instead, with
loopback addresses only, and before it sends any credential it checks that
the app it signed in to syncs with the backend `--convex-url` names. Seed
that backend's Northstar fixture first with
`node scripts/marketing-demo.mjs seed --local --deployment local-<name>-<port>`,
which takes loopback origins only (`--url` and `--site-url`),
`QIVO_FIXTURE_LOCAL=true` and the backend's admin key in
`QIVO_LOCAL_ADMIN_KEY`, and give the check the same `--deployment`. It
prints status lines only, never a secret, and
refuses to start while `DEBUG`, `PWDEBUG`, `DEBUG_FILE` or `NODE_DEBUG` is
set, because Playwright's and Node's debug output would bypass that. If a
run is killed before it cleans up, `--cleanup --run <hex>` with the six digits
of its tag removes what it left, and `--cleanup` alone removes every run's
leftovers, including the records of a run that is still going, so use it
only while no other run is active. Cleanup removes the run's tokens, agent
keys and OAuth connections first, through the app alone, so they go even when
the REST API fails, and it reports `FAIL cleanup/sweep` with what is left
whenever anything remains. If the browser closed during the run, the cleanup
opens it and signs in again first. Its temporary cleanup token ends after a
day, should a killed cleanup leave it.
Run it once per release candidate, not in a loop, because each run writes to
staging.

The checks that an organization admin can still remove access while billing
pauses editing need a pause. Staging runs without billing, so they report
`SKIP` there. A local run given its backend's admin key in
`QIVO_LOCAL_ADMIN_KEY` turns billing on in that backend for those checks,
which pauses the fixture organization because it has no subscription, and
turns it off again. `--require billing-pause-leave` makes the `SKIP` a
failure. The run marks its pause with the backend variable
`STGCHK_BILLING_PAUSE`. If it is killed before it lifts the pause, the
organization stays read-only and the sweep cannot remove its records. The
next local run or `--cleanup` given the key lifts a marked pause first. It
restores `BILLING_ENABLED` only while it is still the `true` the run set,
and otherwise removes just the mark, so a setting someone changed since
stays. Run one local run per backend at a time.

## Production release

`.github/workflows/release.yml` calls the shared deployment workflow, whose
definition comes from the admin-created release tag. The deployment script it
runs comes from main. Before writing anything it checks that:

- a person published a stable, non-draft release whose tag is a `vX.Y.Z` tag
  on main history;
- `ci.yml` and `secrets.yml` succeeded for that exact commit;
- the release has the highest version tag, so re-running or republishing an
  older release cannot roll production back;
- the commit contains the website (`website/index.html`), so a release cannot
  target a commit from before the website moved into this repository;
- staging recorded a successful deployment of that commit before the release
  was published.

A staging record only counts if it was written during the successful staging
run attempt it names. Jobs are serialized and are not canceled midway by
another release.

If a release fails because staging had not verified its commit when it was
published, re-running it cannot help. Wait for **Deploy staging**, then
publish a new, higher version.

The workflow inspects the application and demo projects before writing
anything. Repository bindings, custom domains and their existing environment
identities must match. It then deploys the application and the demo, and
verifies the manifest, the website's origin, public routes and their assets
before recording success. These GET checks do not replace authenticated
end-to-end review in staging. The public demo is not staged. It deploys from
the same commit and does not include the website.

Vercel production projects, and the staging project, accept production
deployments only through the REST API. Git pushes and deploy hooks cannot
deploy them. This policy is the enforcement and must stay enabled; the
deployment script refuses to run if it is loosened. It does not identify the
caller. Any token with access to a production project can create a production
deployment, so those tokens must stay limited to the release workflow.
`vercel.json` also turns off Git deployments of main, avoiding blocked
deployments and failed statuses on main pushes. Set
`previewDeploymentsDisabled: true` on the `qivo-staging` Vercel project through
the [project settings API](https://vercel.com/docs/rest-api/projects/update-an-existing-project)
to prevent feature pushes from creating staging preview attempts. Keep its
GitHub repository connected and its REST-only deployment policy enabled for
both production and preview targets. The staging workflow uses Vercel's
production target, so disabling preview creation does not stop it. Leave
branch previews enabled on `qivo`.

If a feature commit gets a failed `Vercel – qivo-staging` status saying
"Deployment was blocked", inspect the deployment's error reason. A deployment
policy rejection of a Git preview indicates that preview creation is still
enabled. Disable preview creation on that project instead of loosening its
policy or treating the failure as a passing check. Verify the setting with a
project API read, then check a new branch push. It should create a
`Vercel – qivo` preview status and no `Vercel – qivo-staging` status or
deployment. Existing failed statuses remain attached to their historical
commits.

## Rollback and hotfixes

Fix forward when possible. Merge the fix to main, let staging pass, then
prepare and publish a new release.

To restore an earlier version, publish a new, higher version that targets the
older main commit, from the GitHub interface. That commit needs a successful
staging record, which every commit that passed staging keeps. The release also
restores that commit's website and docs and deploys its Convex functions, so
it is only safe when the backend schema and data remain compatible. Commits
from before the website moved into this repository cannot be released again.

Vercel Instant Rollback changes only the frontend, leaves the Convex functions
in place and stops Vercel from moving the domain to later deployments until
the rollback is undone in the Vercel dashboard. Never use it to return
production or staging to a deployment of a commit older than v0.1.5
(`e758e51`). Those deployments fetch the website from Vercel projects that no
longer exist, so the website and docs on `qivo.io` or `preview.qivo.io` would
break.

## Environment configuration

The `staging` and `production` GitHub environments provide these variables.
Values are deployment identifiers and public origins, not credentials.

| Variable | Meaning |
| --- | --- |
| `QIVO_APP_ORIGIN` | `https://preview.qivo.io` or `https://qivo.io` |
| `VERCEL_TEAM_ID` | Owning Vercel team |
| `VERCEL_APP_PROJECT_ID` | Application project for this environment |
| `VERCEL_DEMO_PROJECT_ID` | Public demo project, production only |

Both environments have the secret `VERCEL_APP_TOKEN`. Production also has
`VERCEL_DEMO_TOKEN`, and staging has `VERCEL_APP_PROTECTION_BYPASS` so health
checks can pass its Vercel Deployment Protection. Each Vercel token has access
to one project. Do not replace them with a team-wide token.

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

The website build takes its origin from `SITE_ORIGIN`, which
`scripts/vercel-build.mjs` sets to `QIVO_APP_ORIGIN` for stable builds and to
the branch URL for previews. Production must be built for `https://qivo.io`
and staging for `https://preview.qivo.io`, or the build fails. Never prefix a
secret with `VITE_`.

## Desktop installers

Desktop installers are not published yet. **Desktop test build**, run by hand,
builds unsigned Windows and Linux installers from any ref as workflow artifacts.
It holds no signing credentials, never creates or changes a release and builds
no update feed into them. The installed
shell loads `https://qivo.io/app`, so web releases reach desktop users without
a new installer. See [desktop/README.md](../desktop/README.md).

## Recovery and compatibility

The frontend and backend are separate deployments. A release can partly
succeed before a later step fails. Inspect the failed workflow and the
recorded manifest before retrying. Do not automatically reset data or restore
a database to compensate for a failed build.

Backend changes must remain compatible with open browser tabs, desktop clients
and already scheduled jobs. Introduce optional schema fields first, migrate
existing records deliberately, and remove old fields/functions only after old
clients no longer need them. Test migrations with representative synthetic
data and retain verified production backups before destructive changes.

A frontend rollback changes the served application build. It does not roll
back Convex code, schema changes, stored files or customer writes. A database
restore can discard newer customer changes and requires a separate reviewed
recovery decision. Preserve backend identities, domains and signing secrets.
