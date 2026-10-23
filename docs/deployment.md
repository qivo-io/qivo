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
6. If the release adds a one-time backfill or migration, run it on each
   hosted deployment once that deployment serves the release, with the
   owner's approval for each run, as the backfill's header says. Deployments
   never run it on their own.

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

Every deployment sends the same `Content-Security-Policy` on `/app` and
`/admin` (`vercel.json`). It lets those pages run scripts only from the
deployment itself, so the Vercel toolbar, whose script comes from
`vercel.live`, does not load on them in a branch preview. The website pages
have no such policy and keep the toolbar. Do not add `vercel.live` to the
policy, because the same headers serve production.

### End-to-end API check

`scripts/staging-check.mjs` checks the REST API, MCP and OAuth consent on
staging with a real browser and real credentials. It signs in as the
Northstar fixture admin with a password, creates two personal tokens, a
Standard and a Viewer agent with their keys, and two OAuth connections on the
consent screen, one with **Allow changes** and one without. With each it
checks reads, writes, refusals, attachments, activity attribution and
revocation, and the text, name, comment and request size limits. It fills
one task with 60 comments and about 510 changes, one page and a little more
of each, reads its history over REST and MCP back to the first change, and
in the task window presses **Show earlier comments** and **Show earlier
activity** until the first comment and the created row appear. Its uploads
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
  node scripts/staging-check.mjs --staging
```

The script keeps each person and agent under 200 requests a minute. A tool
that stops a foreground command after a few minutes would end the run before
its cleanup, so start it in its own session with its output in a log file,
which holds no secrets, and wait at least 30 minutes before treating it as
stuck:

```sh
setsid "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-staging" \
  node scripts/staging-check.mjs --staging \
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
loopback addresses only. It signs in to the app at `--app-url` with the
fixture password, then checks that the app syncs with the backend
`--convex-url` names before it sends the admin key, a token or an agent key.
Seed that backend's Northstar fixture first with
`node scripts/marketing-demo.mjs seed --local --deployment local-<name>-<port>`,
which takes loopback origins only, `QIVO_FIXTURE_LOCAL=true` and the
backend's admin key in `QIVO_LOCAL_ADMIN_KEY`. The check reads the
credentials the seed stored for exactly its origins, so give the seed's
`--url` and `--site-url` the same origins as the check's `--convex-url` and
`--app-url`, spelled the same way (`localhost` and `127.0.0.1` differ), and
give both the same `--deployment` and `QIVO_FIXTURE_CREDENTIALS_DIR`. For
`--local` that directory may sit under the checkout's git-ignored
`dev-temp/`, which the dev server does not serve. Every other target keeps
it outside the checkout. The check prints status lines only, never a secret, and
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

### Which parts a rename re-sends

`scripts/rename-resend-probe.mjs` checks that a change to one task re-sends
only the one tasks window that holds it. It signs in a Northstar fixture
person (Nora unless `--as` names another) with the fixture password, loads
the workspace through the app's own part registry, renames the lowest
numbered active task assigned to that person (or the task `--task` names),
renames it back, and prints, for each change, every part that sent a new
answer and its size. The title is the only change, and the probe puts it
back also after a failure. It exits 0 when each change re-sent only that
window. Run it through the staging helper:

```sh
"${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-staging" \
  node scripts/rename-resend-probe.mjs --staging
```

It takes the same targets and refusals as the end-to-end check above, and
for `--local` the same `--app-url`, `--convex-url`, `--api-url` and
`--deployment`.

### A large organization on a local backend

To check the Board at scale by hand, grow that local Northstar copy with
`node scripts/board-scale-seed.mjs --local --deployment local-<name>-<port> --url <backend origin>`,
which takes the same loopback origins, `QIVO_FIXTURE_LOCAL=true` and
`QIVO_LOCAL_ADMIN_KEY` as the Northstar seed and refuses every other
target. It adds 10,000 tasks and a parent for every 25 of them, as Nora,
the organization's admin, through the app's own task mutations, one at a
time. `--tasks` sets any count from 1 to 30,000, which the app's workspace
parts load in windows. The tasks come in every status, with subtasks, due dates, pauses,
long titles and unowned tasks. Their titles read like Northstar's, so the
Board's card height estimates meet realistic text, and each description
names the task's number. Run it again to add only the tasks still missing;
it also finishes a parent and subtasks it stopped in the middle of, under
the parent it already made. It writes to that local backend alone.

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

Instant Rollback can also return a frontend that calls Convex functions a
later release removed. The operator console before v0.1.15 calls
`admin.listUsers` and `admin.orgDetail`, so after such a rollback its Users
and organization pages fail. The v0.1.15 console calls `adminPeople.listUsers`,
so its Users page fails. The app before v0.1.16 calls `billing.usage`, so its
Billing page cannot load usage. Later releases removed all four. The app
before v0.1.26 calls `labels.toggle` without `on`, which later releases
refuse, so after such a rollback it cannot add or remove labels. The app at
v0.1.38 or earlier tells a new Microsoft login that its confirmation email
was sent, but later backends leave that first email to the app, so the person
must press **Resend confirmation email**. An app from before demos were
prepared in steps expects one `demo.ensureMine` call to prepare a whole demo,
but later backends prepare one step a call, so after such a rollback a new
demo visitor sees "Your demo is still being prepared" and must press
**Retry** once for each step after the first, 26 times with the current
demo data.

The app before v0.1.18 reads an activity list that the snapshot no longer
sends, so it cannot load at all. Never return the app or the demo to a
deployment of a commit older than v0.1.18 (`8a1b37c`).

Since v0.1.52 (`38cc47f`) the backend sends load rows only for tasks their
reader cannot see, and the app works out the load of the tasks it shows
from their rows, so a pending hours or owner change moves delays and Team
sync load at once. An app from before v0.1.52 counts no load for the tasks
it shows, so against a later backend its delays and Team sync load come out
too low, also in a tab that was open when v0.1.52 deployed, until it
reloads. Never return the app or the demo to a deployment of a commit
before v0.1.52.

The app reads the workspace in live parts (`convex/workspace.ts`), and the
backend no longer has `snapshot.forMe`, the one query earlier apps loaded
the workspace with. An app from before the parts cannot load at all against
a later backend, and that includes a tab already open when the release
deploys, until it reloads. This moves the floor: never return the app or the
demo to a deployment of a commit before the release that replaced
`snapshot.forMe` with the parts (the release after v0.1.52). Roll forward
instead.

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

Production sends sign-up, password reset, invitation, billing and deletion
mail through Lettermint, so its Convex deployment also needs
`LETTERMINT_API_KEY` and `MAIL_FROM` (one address, such as
`no-reply@qivo.io`). A production build refuses to push backend code until
both are set. Set them before you publish the release.

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
clients no longer need them. Two releases broke that rule on purpose, by the
owner's decision while Qivo had no users: v0.1.52 and the release after it,
which replaced `snapshot.forMe` with the workspace parts. A tab open across
either deploy shows wrong load or cannot load until it reloads, and each is a
rollback floor (see Rollback and hotfixes). Later changes keep the rule.
Test migrations with representative synthetic data and retain verified
production backups before destructive changes.

Organizations no longer have the fields `next_issue_num`, `next_project_num`
and `activity_count`. Every hosted deployment cleared them with the one-time
`internal/orgCountersBackfill`. Convex refuses to deploy a later commit to a
backend where any organization still holds one of them, for example a
development backend that never ran the backfill, or data from a backup taken
before it ran. Deploy an earlier commit that still has the backfill, such as
v0.1.21 (`ab0a802`), run `internal/orgCountersBackfill:start`, wait until its
`remaining` query reports 0 on every page, and then deploy the later commit.

Team sync stamps live in their own `sync_stamps` table, off the profiles.
Profiles no longer have the fields `sync_at` and `sync_since`. Every hosted
deployment moved them into stamp rows with the one-time
`internal/syncStampsBackfill`, whose `remaining` check reported 0 on
development, staging, production and the demo before the fields were
dropped. Convex refuses to deploy a later commit to a backend where any
profile still holds one of them, for example a development backend that
never ran the backfill, or data from a backup taken before it ran. Every
main commit from v0.1.52 (`38cc47f`) up to the release that replaced
`snapshot.forMe` with the workspace parts has the backfill. Deploy the
newest of them, as an older one may refuse data from a later schema
addition, run the backfill as its header says, wait until `remaining`
reports 0 on every page, and then deploy the later commit. Returning the Convex functions to a commit before v0.1.52
shows nobody as stamped, because earlier code reads only the profile fields,
and the stamps it then writes into those fields make Convex refuse the roll
forward until the backfill runs again, which moves them into rows only for
people who have none, so those stamps are lost for everyone stamped before.
Roll forward instead.

Every task and project has a `window_key`, a random point the server picks
when it stores the row, which places the row in the app's windows of the
workspace (`convex/lib/workspaceParts.ts`). The release that replaced
`snapshot.forMe` with the workspace parts added it. A task or project
stored before has none until the one-time `internal/windowKeysBackfill`
gives it one, and until then it loads in the first window of its kind, so
an organization with more such tasks than one window holds cannot load. A
restore from Deleted items gives a task or project stored before keys a
key as it writes it back, and the task's relation rows the same key.
Earlier releases brought such a task back without a key, so a deployment
that ran the backfill before it served the release that keys restores
needs `remaining` checked again once it does, and another run if a page
reports rows.
Run the backfill on every hosted deployment once it serves that release, as
the module's header says, and check that `remaining` reports 0 on every
page of both tables. Earlier releases do not accept the field, so a
rollback past that release fails to deploy; it is a rollback floor anyway
(see Rollback and hotfixes).

Releases before v0.1.40 require every team to have `stale_days` and
`archive_days`, which no team has now, so a rollback to one of them fails to
deploy. Roll forward instead. Later releases no longer accept those fields,
a team's `max_attachment_mb` or an attachment's `project_id` at all, and
v0.1.40 (`a09b44e`) is the last commit with `internal/retiredFields`. A
backend that still holds any of them, such as a development backend that
never ran the clear or data restored from an older backup, takes v0.1.40
first, `internal/retiredFields:clear`, and then the later release.

An image a description save took out keeps a `dropped_at` for a day, in
Deleted items for as long as its task stays there. Releases before the one
that added it do not accept that field, so a rollback past it fails to
deploy while such an image exists. Roll forward instead.

A demo that is being prepared keeps its preparation step in `provision` on
its `demo_sessions` row, also after its visitor leaves partway, until cleanup
removes the row about a day later. Releases from before demos were prepared
in steps do not accept that field, so a rollback past it fails to deploy
while such a row exists. Roll forward instead.

A frontend rollback changes the served application build. It does not roll
back Convex code, schema changes, stored files or customer writes. A database
restore can discard newer customer changes and requires a separate reviewed
recovery decision. Preserve backend identities, domains and signing secrets.
