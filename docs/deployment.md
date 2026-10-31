# Deployment and releases

Qivo separates persistent staging, customer production, the public demo and
temporary branch previews. Each uses a separate Convex backend. Production
retains its existing backend and customer data. One deployment serves the
website (`/`, `/docs/`, `/pricing/`), the planner (`/app`) and the operator
console (`/admin`), so every deployment below is one commit of this
repository.

| Source event | Destination |
| --- | --- |
| Feature branch push | Vercel branch preview, website included, with its own Convex preview deployment that runs no cron jobs and is deleted 3 days after the branch's last push |
| Successful main CI and secret scanning | Staging website, docs and app at `preview.qivo.io` |
| **Deploy staging** run by hand from main | The same, for example after a provider failure |
| **Prepare release** run by hand from main | A draft GitHub Release for the commit staging serves. Deploys nothing |
| Publishing that draft (a stable release) | Website, docs and app at `qivo.io`, and the public demo |

```text
 feature branch ──► CI + secret scan, branch preview (own empty Convex backend,
       │             no cron jobs, deleted 3 days after the last push)
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
data. Branch previews are the one exception to keeping data, because each
preview's backend is deleted 3 days after the branch's last push. Staging
starts with its own synthetic data and private test accounts. Its auth
secrets, storage, API credentials and backend are separate from production.
Mail delivery, social sign-in and billing are not configured in staging, so
those flows cannot be tested there. Branch previews send real mail instead
(see [Environment configuration](#environment-configuration)). Do not import
customer data into staging or reuse production service credentials there.

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
   never run it on their own. The release that adds the comment limits needs
   `internal/commentCountsBackfill` right after it deploys, on staging, the
   demo and production (see Recovery and compatibility).

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

A branch preview's Convex backend runs no cron jobs. Its build sets
`QIVO_ENVIRONMENT=preview` before Convex pushes the functions, also on the
branch's first build, and `convex/crons.ts` registers no job under that
value. A changed value takes effect only at the next push. Every other
environment registers every job. A preview therefore has no retention or
archive sweeps, no expiry of Deleted items or the audit log, no organization
retention, no recovery of a stopped deletion or webhook step, no billing
reconciliation or usage delivery to Polar, no recovery or sweep of
organization export jobs, and none of the demo cleanup and metrics jobs.
Work that a request starts still runs, including the delays it schedules,
such as webhook delivery and its retries, the steps of a deletion, an
export job's steps and erase legs and the expiry of its archive four hours
after it is ready, a snoozed item's wake and a demo's 24-hour expiry. The same holds for demo
branch previews. A preview exists to check that the functions and schema
push, and to open its branch site by hand. Test cron jobs on a local backend,
or on staging for jobs that need neither billing nor demo mode. Convex refuses
a push whose job names a missing function, which a preview push no longer
checks, so `convex/tests/crons.test.ts` checks it before staging does.

A branch preview's Convex backend is deleted 3 days after the branch's last
push, whether or not its pull request is still open. Each preview build sets
the deletion time to 3 days ahead through the Convex Management API, before
it changes anything else on the backend, using the preview deploy key the
build already holds, and reads the time back. Every push therefore moves the
date. A push whose build fails or is cancelled before that step leaves the
date the build before it set. Until then the backend keeps its data, its
environment variables, including the mail settings it was created with, and
its functions. The branch site loses its backend when it is deleted. The next
push after that creates a new, empty backend with the project's current
default environment variables. The demo's preview builds do the same,
although the demo's Vercel project creates no previews. Only a build with a
preview deploy key and `QIVO_ENVIRONMENT=preview` sends the request, so the
production, staging and public demo builds never set a deletion time. The
build tries 4 times, waiting at most 15 seconds for each request, and then
fails, naming the deployment and each attempt's HTTP status or that no
response came, so a preview whose date was not set is noticed at once
instead of piling up against the team's deployment limit. Without the call,
Convex would keep a preview for 14 days after it was created on the
Professional, Business and Enterprise plans, and for 5 days on Free and
Starter.

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
the search on **Settings → Projects → Archived tasks** and main Search, where
an active task the run made must show with **Include archived tasks** off
and a task the run archived only with it on. That shows whether the
deployment's search index takes the filter for an absent `archived_at` and
still returns active matches. Everything it creates
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
answer and its size. It waits until every part answered, the pieces of a
window cut in two included, before the first rename. The title is the only
field it changes, but each of the two writes is a rename like one in the
app: it sets the task's update time, adds a history row, sends a
`task.updated` event to each webhook that takes it and sends every other
follower of the task an inbox notice of the new title. The probe puts the title back also after a
failure, a timeout or a first Ctrl-C, when the backend accepts that write
within a minute, and otherwise prints the title to set; a second signal or
a kill exits without. A title that still ends in ` (rename probe)` stops
the probe before any write. Each write carries the title it replaces, so a
rename by someone else meanwhile keeps their title and fails the probe. It
exits 0 when each change re-sent only that window. Run it through the
staging helper:

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
time. `--tasks` sets any count from 0 to 30,000, which the app's workspace
parts load in windows. The tasks come in every status, with subtasks, due dates, pauses,
long titles and unowned tasks. Their titles read like Northstar's, so the
Board's card height estimates meet realistic text, and each description
names the task's number. Run it again to add only the tasks still missing;
it also finishes a parent and subtasks it stopped in the middle of, under
the parent it already made. It writes to that local backend alone.

`--archived <n>`, up to the `--tasks` count, archives the first `n` seeded
tasks that are not parents, spread over the sub-projects as the tasks are,
as Nora and without a reason, which gives **Archived tasks** more than one
page, for example `--tasks 400 --archived 160`. A second run archives only
what is still active and never seeds an archived task again.

`--inbox <n>`, up to the `--tasks` count, also gives Nora `n` inbox items,
for checking the Inbox and its bulk actions at scale. On each of the first
`n` seeded tasks that are not archived it posts one comment that mentions
her, through `comments:create`, as one of the sub-project's task owners who
has a login and is not Nora, because a mention of herself writes no
message and an agent has no login. Each comment's id comes from its task's
id, so a rerun posts only where no comment is yet, and a larger `--inbox`
adds items on the next tasks. For example, `--tasks 1300 --inbox 600` and
then `--tasks 1300 --inbox 1200` give Nora 600 more unread items.

To page **Settings → Organization → API access**, add
`--credentials <count> --api-url <backend site origin>` (up to 500, with
`--tasks 0` for no tasks). Every fourth credential is an agent key of one of
Northstar's agents and the rest are personal tokens of its people, each
made through the app's own mutations, and each new one makes one to four
`GET /v1/me` calls on the site origin, so the calls write their own usage.
A second run adds only the credentials still missing. A credential a
stopped run saved without all its calls stays as it is, and its number gets
a new credential named with the next try, such as `(scale 7, try 2)`, with
all its calls. The seed deletes and changes no credential.

`--relations` adds one task at both per-task caps, for checking the task
window's **Subtasks**, **Linked tasks** and **Attachments** at scale (with
`--tasks 0` for no other tasks). As Nora, through the app's own mutations,
it makes a new top-level task in Firmware, **Coordinate the pilot firmware
release**, with 100 active subtasks and 100 links. The subtasks take every
status and five owners in turn, every third has remaining hours, and they
have 20,000-character descriptions in a three-byte script, so the task's
window shows 20 of 100 tasks done and Σ 133h. The task's own description is
500 characters shorter, which leaves room to paste images into it. Each link goes to a
task made for it: 70 in Luma Sensor's sub-projects, 15 in Luma Cloud's and
Pilot & Launch's, and 15 in **Partner pilot**, a project the seed makes that
only Nora sees, so anyone else who is no organization admin finds those
links left out. Five of the linked tasks have one subtask each. The run
ends by naming the task's window key, which the backend chose: a workspace
that loads in stages (`--tasks 6000` or more) watches its task windows from
the lowest keys up, so the key says which stage brings the task. A second
run adds only what is missing. It leaves archived subtasks and linked tasks
archived and says how many of them the task's window no longer lists.

One run makes the credentials first, each as the login that makes it in
the app, then the tasks and the relations and the archiving as Nora, and
posts the inbox comments last, each as its poster, so they land on tasks
that stay active and arrive unread.

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
it is only safe when the backend schema and data remain compatible. Several
releases added fields that earlier releases refuse, such as the live task
and project counts, so a release of a commit before one of them fails to
deploy (see Recovery and compatibility).
Commits from before the website moved into this repository cannot be
released again. From the release that writes task descriptions only to
`issue_descriptions`, never return the backend to a commit before v0.1.98
(`221c21d`). Convex accepts v0.1.97, but it shows no description for a task
that release wrote, edited or cleared (see Recovery and compatibility).

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
refuse, so after such a rollback it cannot add or remove labels. The app
before v0.1.98 subscribes to `snapshot.commentThread`, so its task window
cannot load comments. The app before v0.1.99 reads Archived tasks through
`issues.archivedPage` with `project_id`, API access through
`apiAccess.list`, and each account's `keys` in Billing's usage report, so its
Archived tasks and API access pages cannot load, and Billing shows "This view
could not be loaded" while the period has API calls. The app before v0.1.15
reads Archived tasks through `issues.archivedFor`, the v0.1.15 app sends
`access` and `team_access` maps to `projects.update`, and the app before
v0.1.11 saves the Blue appearance through `appearance.save`, so their Archived
tasks, project access edits and Blue choice fail; the rollback floors below
already keep those apps out. Later releases removed them. The app at
v0.1.38 or earlier tells a new Microsoft login that its confirmation email
was sent, but later backends leave that first email to the app, so the person
must press **Resend confirmation email**. An app from before demos were
prepared in steps expects one `demo.ensureMine` call to prepare a whole demo,
but later backends prepare a part of it a call, so after such a rollback a
new demo visitor sees "Your demo is still being prepared" and must press
**Retry** once for each call after the first, 4 times with the current demo
data.

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

## Node.js version

`engines.node` in `package.json` names the Node.js range, `>=24.22.1 <25`.
Its lower bound is the oldest Node 24 release with the security fixes Qivo
needs. Every `actions/setup-node` step reads it with `check-latest: true`, so
each run installs the newest Node 24 release instead of an older one in the
runner's cache. The step after it runs `node scripts/node-version.mjs`, which
fails the job when the Node is outside the range. `npm run verify:local` runs
the same check first. **Desktop test build** can build an older ref that has
no check, so it takes the check and the range from a sparse checkout of the
workflow's own commit. `scripts/node-version.test.mjs` fails when a workflow
leaves out the check.

Vercel lets a project choose only the major and builds with the newest patch
it has rolled out, which can trail a Node security release by days. The
Vercel build command therefore runs the check with `--warn`, which prints the
Node version, and a warning when it is below the range, without failing the
build. A failing check there would stop every preview, staging and production
deploy until Vercel caught up. Each hosted build writes its Node version into
`version.json` as `node`, so `curl https://qivo.io/version.json` and
`curl https://preview.qivo.io/version.json` show which Node built production
and staging. Raise the lower bound when a Node security release fixes a
problem that affects Qivo's builds or deploy tooling, then check those files
after the next deploys.

Convex runs `'use node'` actions on the major that `node.nodeVersion` in
`convex.json` names and picks the patch itself. A local backend runs them on
the `node` first on `PATH`.

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
backend code. Preview builds set their newly claimed branch backend's
deletion time, origin and environment. No deployment infers safety from a hostname alone.

Production sends sign-up, password reset, invitation, billing and deletion
mail through Lettermint, so its Convex deployment also needs
`LETTERMINT_API_KEY` and `MAIL_FROM` (one address, such as
`no-reply@qivo.io`). A production build refuses to push backend code until
both are set. Set them before you publish the release.

Branch previews send the same mail. The Convex project that holds production,
development and the branch previews has both settings as default environment
variables, which Convex copies into each new deployment when it creates it.
Mail flows can therefore be tried on a branch preview before a release. A
preview build does not require the settings, and staging, a separate Convex
project, has neither. When the Lettermint token changes, update the project
default as well as production. Existing development and preview deployments
keep the copy they were created with. A preview gets the new token when its
branch is next pushed after its backend was deleted.

The website build takes its origin from `SITE_ORIGIN`, which
`scripts/vercel-build.mjs` sets to `QIVO_APP_ORIGIN` for stable builds and to
the branch URL for previews. Production must be built for `https://qivo.io`
and staging for `https://preview.qivo.io`, or the build fails. Never prefix a
secret with `VITE_`.

## Desktop installers

Desktop installers are not published yet. **Desktop test build**, run by hand,
builds unsigned Windows and Linux installers as workflow artifacts from any
branch, tag or commit SHA, full or short, which its first job resolves to the
full SHA both builds check out.
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
clients no longer need them. A public function, argument or answer field the
app stops using stays through the release that ships the app's replacement,
so tabs and desktop windows loaded before it keep working until they reload.
A later release may remove it and adds it to the Instant Rollback list in
Rollback and hotfixes. Two releases broke that rule on purpose, by the
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

Each organization's `org_counters` row counts its active tasks and its
projects (`active_tasks`, `live_projects`), the rows the app's windows read,
and the app starts that many windows of each kind. Every write that adds,
archives, restores or deletes a task or project keeps the counts, and a new
organization starts at zero. An organization created before the release
that added them has none until the one-time `internal/liveCountsBackfill`
counts it, and until then the app sizes its windows by the task and project
numbers handed out, as earlier releases did, so it loads as before. Run the
backfill on every hosted deployment once it serves that release, as the
module's header says: read its dry run first, then run it. A call that
does not finish in about five minutes answers a `cursor`; call it again
with the same arguments and that `cursor` until it answers `done`. A
later dry run lists any organization whose counts differ from its rows,
and apart from them any whose writes kept changing it while it counted, to
check again.
`"recount": true` counts every organization again, which mends counts a
dry run lists as differing. Both list an organization without an
`org_counters` row as skipped; its next create makes the row, and a later
run counts it. Earlier releases do not accept the fields, and every new
organization holds them from its start, so the release that added them is
a rollback floor for the backend as soon as it deploys (see Rollback and
hotfixes). Roll forward instead.

Task descriptions moved from `issues.description` into the
`issue_descriptions` table, one row per live task, in three releases. In
the first, every write of a task kept both copies and every reader still
read `issues.description`. A task stored before that release had no row
until the one-time `internal/descriptionsBackfill` gave it one. The second
release, v0.1.98, reads the table: every reader takes a task's text from
its first row, or from its first row that holds the task's project and
archived state when a rollback left more than one, and only a task without
a row reads `issues.description`. The third release writes the text to the
table alone. A new task's row in `issues` holds no copy of it, and every
description write unsets the copy a task row still holds. Its
`"clear": true` run of the backfill unsets the remaining copies, only
where the task's one row holds the same text and the task's project and
archived state, and it reports every other case. Run the backfill on every
hosted deployment once it serves the third release, as the module's header
says. Read a dry run, then run it with `"clear": true` and call it again
with the `cursor` it answers until it answers `done`, then read a second
dry run, which reports `held` 0. A deployment is clean when a dry run
reports zero `missing`, `differ`, `duplicates` and `orphans`. Its
`waiting` rows belong to a Deleted items item or a teardown that is still
running and deletes them. `skipped` counts the tasks whose row in `issues`
holds no copy, which is normal from the third release on and grows with
every create and description edit, and `held` counts the copies a clear
would unset. Clear only a clean deployment, and on production only after a
verified backup.
A rollback past the first release deploys, because Convex leaves a table
the schema does not list alone, but the earlier code writes tasks without
their rows and changes descriptions without them. After rolling forward
again, run the backfill with `"repair": true`, which also rewrites
differing rows from `issues.description`, deletes extra rows and deletes
rows whose task is gone. Once the second release serves, it shows the row
such earlier code left stale, so run the dry run and that repair before
anyone relies on the text. Every call that is not a dry run adds an audit
row with its counts and the `cursor` to go on from, also when it fails
partway.
The second release is the backend's rollback floor from the moment the
third deploys, not from the clear, because the third's first create or
description edit writes a task without a copy. The second release and the
ones after it before the third, from v0.1.98 on, read the rows, so every
description shows, and their writers write copies equal to the rows
again, which the next clear unsets after rolling forward. Their dry run
counts every task without a copy as `skipped`, which is no fault there,
and does not count a second row of a task without a copy, so only the third
release's dry run finds such duplicates. They also price each patch of a
subtree move or archive at the size of the task row, which holds no text
once the clear has run. Moving or archiving a family whose descriptions were
stored before the caps, near Convex's document size limit, can then fail
with Convex's read limit error instead of a refusal. Nothing of it is
written, and rolling forward ends it. Convex accepts a rollback to
v0.1.97 (`9243406`), or to a main commit between it and the second
release, but that code reads only `issues.description`. Every task the
third release created, edited, restored or cleared then shows no
description in the app, REST, MCP, the export and the searches, and people
and agents can save over text they cannot see, although the rows keep it.
Never return the backend to a commit before v0.1.98 (`221c21d`); roll
forward instead.

Each description row also holds copies of its task's project and archived
state (`project_id`, `archived_at`), and the table has the
`search_description` index, so main Search can match descriptions within a
project and leave archived tasks out. The copies came after the table, and
may reach a deployment in the same release or a later one. Every write of a
row, and every move, archive and restore of a task, the nightly archive
included, writes the copies in the same transaction. A row written by code
from before the copies holds none, and the same backfill counts it as
`differ`. Once a deployment serves the copies, read the dry run, then run
the backfill with `"repair": true`, which writes the copies from each task,
and call it again with the `cursor` it answers until it answers `done`. A
task without a row gets none from a move or an archive, and the backfill
inserts its row with the copies. Main Search's query, `search:page`
(`convex/search.ts`), matches descriptions through `search_description`,
titles through the `search_title` index of `issues` and project names
through the `search_name` index of `projects`, which Convex builds at
deploy without a backfill. The query shipped before the app called it. The
app's Search palette calls it, once typing rests and once for each page,
and the release that first ships that palette goes out only once a dry run
from the third release of the description move reports development,
staging, production and the demo clean, zero `missing`, `differ`,
`duplicates` and `orphans`. `skipped` is no gate there, because it counts
every task whose text the clear took off its row in `issues`.
Data restored from a backup taken before the copies leaves rows without
them, and a dry run lists them as `differ` until a repair mends them.
Code that lists `issue_descriptions` without the copy fields does not
accept a row that holds them, so once any row does, a rollback to such a
commit fails to deploy. That makes the copies a rollback floor for every
commit that lists the table without them (see Rollback and hotfixes). A
release from before `issue_descriptions` still deploys, because Convex
leaves a table its schema does not list alone, but it writes tasks without
rows, and changes descriptions and moves and archives tasks without them.
After rolling forward from it, run the dry run and then the backfill with
`"repair": true`.

Every person, team and project has a `name_key`, the form of its name that
lists in name order sort and search by (`convex/lib/nameKey.ts`), and every
team membership, project grant and team share holds a copy of its person's
or team's key. Every write keeps them: a rename brings the copies in line in
its own transaction and in background steps, and a restore from Deleted
items computes them again from the current names. A row stored before the
release that added them has none until the one-time
`internal/nameKeysBackfill` gives it one. The backfill stamps each
organization it finishes in `org_ready`, and an organization created since
that release is stamped at its creation. A list that reads in name order
refuses an organization without the stamp instead of leaving rows out. Run
the backfill on every hosted deployment once it serves that release, as the
module's header says. Read its dry run first, then run it. A call that does
not finish in about five minutes answers a `cursor`; call it again with the
same arguments and that `cursor` until it answers `done`, and check that a
second dry run reports no missing or stale keys. A call that a failed step
stopped answers `error` with the cursor of that step, and its audit row
records what it wrote first. Earlier releases do not
accept the fields or the `org_ready` and `name_copies` tables, and every new
organization writes its `org_ready` row, so the release that added them is a
rollback floor for the backend as soon as it deploys (see Rollback and
hotfixes). Roll forward instead.

Each organization's task files are counted in stored-byte totals per
organization, project and task (`storage_org_totals`,
`storage_project_totals`, `storage_task_totals`), files in Deleted items
included. The transaction that attaches a file counts it, the one that
deletes its last row for good takes it out, and a move between projects
shifts it. Each project and task row names its organization and its
project's or task's number, which the organization never gives another, so
a task or project that takes the id of a purged one, in any organization,
counts in a row of its own and never changes another's. Nothing reads
the totals yet. Billing samples and the Billing page still scan the
attachment rows. A new organization starts counted at zero. An
organization created before the release that added them has no totals
until the one-time `internal/storageTotalsBackfill` counts it, and a reader
must treat it as not counted until then. Run the backfill on every hosted
deployment once it serves that release, as the module's header says. Read
its dry run first, then run it, and call it again with its `cursor` until
it answers `done`. A call stops at its deadline between steps and answers a
cursor that goes on inside an organization, and a call that meets an error
answers it with the cursor of the organization it failed on and records
what it did in its audit row. A later dry run lists any organization whose
totals differ from its files or whose project rows have another name than
their project, any whose writes kept changing it while it counted, the
attachment rows whose task is gone, which nothing deletes, and the totals
of organizations that no longer exist, which a run deletes.
`"recount": true` counts every organization again from zero, and starts
over any count another run began. Earlier releases do not keep the totals.
Convex keeps the rows of a table the schema no longer lists, as it did for
`comment_counts`, so a rollback past that release deploys, but the
attaches, moves, renames and deletions it serves leave the totals out of
step, and an organization it deletes leaves its totals behind. After
rolling forward, run the backfill with `"recount": true`, which rebuilds
each organization's rows from its own files and deletes the totals of
deleted organizations. An organization created again under the id of one
deleted while an earlier release served, such as a fixture with a fixed id,
starts not counted while rows of the deleted one are left, until the
backfill counts it.

A task holds at most 1,000 comments, and each task's count lives in a
`task_comment_counts` row that every comment write keeps (the release that
added the comment limits). A task stored before that release has no row
until the one-time `internal/commentCountsBackfill` counts it. Until then
each post on such a task counts its thread first, and a thread with more
than about 1.5 MiB of comments refuses posts and archives with a reason for
about a minute while a background count, which the refusal starts, finishes.
A task with 1,000 or more comments refuses them until comments are deleted,
as the limit asks. Run the backfill on every hosted deployment right after it
serves that release, as the module's header says: read its dry run first,
then run it, and call it again with each `cursor` until it answers `done`.
The deployment is ready when every call of a dry run, followed through its
cursors to `done`, answers `counted: 0`, `stuck: 0`, `drift: 0`, `held: 0`,
`differing: 0` and `unsettled: 0`. A run clears the first three. Tasks a
dry run lists as `held` or `differing` need a run with `"recount": true`,
and `unsettled` tasks, whose comments changed while it counted, another dry
run. A rollback past that release deploys, because Convex keeps the rows of
tables the schema no longer lists, but the earlier release posts, deletes
and moves comments without counting them. After rolling forward again, read a dry run
and run the backfill with `"recount": true`, which counts every live task
again, counts the tasks that release created, deletes rows that name no task
of their organization any more, and deletes the counts of tasks in Deleted
items, which a move under that release left in place, so a restore counts
their threads again from the start.

Each label has a `label_counts` row with the number of active tasks that
carry it, and each team a `team_counts` row with its members, as the team
lists show them. No reader uses them yet. Every write that changes either
keeps the rows, and labels and teams created since the release that added
them start with one. A label or team stored before has no row until the
one-time `internal/labelCountsBackfill` and `internal/teamCountsBackfill`
count it, and the readers to come show such a count as unavailable, never
as zero. Run both on every hosted deployment once it serves that release,
as each module's header says: read the dry run first, then run it, calling
again with the answered `cursor` until it answers `done`. A dry run lists
the labels and teams a run would count, any stored count that its rows do
not give, any count left unfinished, and the rows left without their label,
team or organization; `"recount": true` mends the differing counts.

An earlier release moves none of these counts, deletes labels, teams and
organizations without their rows, and leaves a count the backfill had not
finished wrong below where it stopped. After the backend has run an earlier
release, run both dry runs again once the later release serves, then run
both with `"recount": true`, calling again with each answered `cursor` until
it answers `done`: a recount counts every organization and team again, an
unfinished count from its start, and deletes the rows left without their
label, team or organization. An organization deletion or demo cleanup that
had passed its labels and teams phases deletes the counts such a release
left in its last phase. A profile removal whose memberships outlive its own
transaction marks its `profile_removals` row with `counted_org_id` until its
background steps finish, which takes seconds. Releases before the one that
added that field do not accept it, so a rollback past it fails to deploy
while such a removal runs; wait for it to finish, or roll forward.

Every inbox item, a person's messages about one task, has an `inbox_items`
row that every message write keeps in step, and each person an
`inbox_state` row that says whether their rows are complete.
`convex/inbox.ts` reads the rows for the capped unread summary and one
task's item, and answers that a person's Inbox is not ready while their
`inbox_state` is not built. The app does not call those reads yet. It keeps
the workspace inbox until a later release switches it, and REST and MCP
still read the messages. A person whose messages were stored before the
release that added the rows (PR 299, merged as `cf3d683`) has no complete
rows until the one-time `internal/inboxItemsBackfill` builds them, while a
person whose first message comes later has them from that message on. Run
the backfill on every hosted deployment once it serves that release, as the
module's header says: read its dry run first, then run it, calling it again with its
`cursor` until it answers `done`. Then check that `remaining` reports no
profile on any page and that a new dry run reports no rows that differ, are
missing, are extra or belong to removed profiles. A release whose app shows
these reads may reach a deployment only once it reports that. An earlier
release writes messages without keeping the rows, so after a deployment ran
one, a dry run lists the profiles whose rows differ, `"rebuild": true`
builds every profile's rows again, and a run deletes the rows of the
profiles that release removed. Such a release leaves the rows stale while
`inbox_state` still says built, which the reads take as complete. So a
deployment that went back to a release from before PR 299 after serving PR
299 or a later one reads a new dry run once it serves a later release
again, and when that dry run reports rows that differ, are missing or are
extra, runs the backfill with `"rebuild": true` until it answers `done`
before it serves a release whose app shows these reads. A deployment that
never served a release from before PR 299 after PR 299 needs no rebuild.

Unread messages about tasks archived before the archive marked them read
(commit `c311ec8`, 2026-10-15) stay unread, and the unread summary in
`convex/inbox.ts` reads such a task for each of these items on every run,
so many of them keep a person's summary incomplete for good. Run the
one-time `internal/archivedReadsBackfill` on every hosted deployment once it
serves the release that adds it, as the module's header says: read its dry
run first, then run it, calling it again with its `org_id` and `cursor`
until it answers `done`, wait for the read steps it schedules, and check
that a new dry run reports no tasks. It marks the messages of archived
tasks only. Active tasks in an archived project keep theirs, which the
summary skips with the project without reading them. Running it again is
safe.

Every project has an `archive_state` (live, archived as its own entry, or
archived under an archived parent), and `project_reach` holds a row for each
project every seat and team reaches through a lead, a grant or a team share,
so navigation lists read a person's projects in name order without reading
every grant (`convex/model/projectNav.ts`). Every write keeps them: grants,
shares and leads bring their rows in line in their own transaction, and a
rename, key change, archive or restore updates the rows of the projects it
changes, refusing a tree past `LIMITS.projectTreeChange` before it writes.
Rows and states stored before the release that added them are missing until
the one-time `internal/navBackfill` writes them. The backfill walks the
projects, grants, team shares and reach rows of every organization, then
stamps each organization in `org_ready` (`nav_at`); an organization created
since that release is stamped at its creation. A navigation list refuses an
organization without both that stamp and the name keys stamp. Once `nav_at`
holds, the access checks behind the workspace, the task window, the inbox,
main Search, Archived tasks, milestones and project settings
(`convex/lib/access.ts` `projectLevelsOf`) answer whether a top-level project
shows a person only for navigation to one of its sub-projects from these
rows, not from the project's sub-projects and every team share of the
person. They also tell which of a person's teams to ask about a project
shared with more than 64 teams once the person's teams share more than
1,000 projects. A row an earlier release left missing hides such a
top-level project, or a team's share on such a project, until a backfill
run writes it, which narrows the answer and never widens it. Main Search
(`search:page`) needs `nav_at` alone, and only where it searches a whole
organization: there it leaves the organization's project names out and
reports its search incomplete while the stamp is missing. A seat it searches
project by project finds its project names without the stamp, from the
projects, leads, grants and shares it already read. Run the
backfill on every hosted deployment once it serves that release, as the
module's header says. Read its dry run first, then run it. A call that does
not finish in about five minutes answers a `cursor`; call it again with the
same arguments and that `cursor` until it answers `done`. Then run a full dry
run again. While Deleted items moves a project, its reach rows wait for the
move's next steps, so a dry run can count them as extra for a moment, and
one restore or move finishing during the walk can leave a row the walk
already passed. If the second dry run reports anything missing, extra or
stale, run the backfill again, and repeat until a full dry run reports zero.
Earlier releases do not accept the `archive_state` and `nav_at` fields, and
every new organization writes `nav_at`, so the release that added them is a
rollback floor for the backend as soon as it deploys (see Rollback and
hotfixes). Roll forward instead. If a deployment runs an earlier release
anyway, read the dry run again after rolling forward: it finds what that
release wrote without rows, and a run mends it.

Projects and teams no longer have the fields `icon` and `icon_color`, which
no release since v0.1.15 (`31ece0f`) took or showed. The one-time
`internal/legacyIconsBackfill` reported and cleared them on live projects and
teams and on the project copies Deleted items keeps. Its dry run reported
zero on development, staging and the demo. On production it cleared 3
projects and 2 teams, and a second dry run reported zero, before the fields
were dropped. Convex refuses to deploy a later commit to a backend where any
project, team or project copy still holds one of them, for example data
restored from a backup taken before the backfill ran. Every main commit from
v0.1.101 (`fe9888e`) up to the release that dropped the fields has the
backfill. Deploy the newest of them, as an older one may refuse data from a
later schema addition, run the backfill as its header says until a second
full dry run reports zero, and then deploy the later commit. Earlier releases
accept rows without the fields and write none, so the drop is no rollback
floor.

Releases before v0.1.40 require every team to have `stale_days` and
`archive_days`, which no team has now, so a rollback to one of them fails to
deploy. Roll forward instead. Later releases no longer accept those fields,
a team's `max_attachment_mb` or an attachment's `project_id` at all, and
v0.1.40 (`a09b44e`) is the last commit with `internal/retiredFields`. A
backend that still holds any of them, such as a development backend that
never ran the clear or data restored from an older backup, takes v0.1.40
first, `internal/retiredFields:clear`, and then the later release.

OAuth clients in the Better Auth component no longer have the fields
`public` and `type`. Every hosted deployment with OAuth clients cleared them
with the one-time `internal/oauthClientBackfill`, whose `remaining` check
reported 0 on staging, development and production before the fields were
dropped; the demo has no OAuth clients. Convex refuses to deploy a later
commit to a backend where any `oauthClient` row still holds one of them, for
example data restored from a backup taken before the backfill. Every main
commit from v0.1.76 (`1906eb2`) up to the release that dropped the fields
has the backfill. Deploy the newest of them, as an older one may refuse data
from a later schema addition, run the backfill as its header says, wait
until `remaining` reports 0 on every page, and then deploy the later commit.

Every agent key and personal token holds its owner's organization and a
`name_key`, and every OAuth connection a `name_key` (`convex/lib/nameKey.ts`),
which API access pages them by. Every API usage row holds a rank
(`neg_calls` and `name_key`), and the transaction that records a call also
counts it on its account's `billing_usage_accounts` row and, in a calendar
month, on the organization's `billing_month_totals`. A row stored before
the release that added them has none until the one-time
`internal/credentialKeysBackfill` and `internal/usageRanksBackfill` give it
them, and the next call of a credential ranks its row as well. API access
reads them. Until both backfills report nothing left, it says it is not
ready to list credentials, and a calendar month whose rows are not all
ranked shows its total as not available yet. Run both backfills on every
hosted deployment once it serves that release, as the modules' headers say.
Read each dry run first, then run it.
A call that does not finish in about five minutes answers where to go on:
`internal/credentialKeysBackfill` a `table` and a `cursor`, which can be
null where a table starts, and `internal/usageRanksBackfill` a `cursor`.
Call it again with the same arguments and what it answered, unchanged,
until it answers `done`. A call that answers an `error` kept what it wrote
before, and its `cursor` reads that page again. Then check that a second dry
run of each reports nothing left and that
`internal/usageRanksBackfill:check`, which goes on from its `cursor` the
same way, reports no unranked bucket and no difference. The check also lists calendar months that hold a total in
`billing_usage_totals`, which v0.1.14 and v0.1.15 wrote and which counts
only the calls of those releases. Earlier releases do not accept the fields
or the two tables, and the first credential or call stored after the deploy
holds them, so the release that added them is a rollback floor for the
backend as soon as it deploys (see Rollback and hotfixes). Roll forward
instead.

Every id a task or project holds is recorded in `used_ids`, so no create
gives it to a new task or project, also in another organization, until the
end of that organization's teardown lets it go. Ids freed before the release
that added the table are unknown and stay free. A task or project stored
before that release has no row until the one-time `internal/usedIdsBackfill`
records it; until then only its live row or Deleted items copy keeps its id.
Run the backfill on every hosted deployment once it serves that release, as
the module's header says. Read its dry run first, then run it. A call that
does not finish in about five minutes answers a `source` and a `cursor`;
call it again with the same arguments and both of those, unchanged, until it
answers `done`. A call that answers an `error` kept what it wrote before, and
its `cursor` reads that page again. Then check that a second dry run reports
zero in every source. A rollback past that release deploys, because Convex
leaves a table the schema does not list alone, but the earlier code creates
tasks and projects without rows and can give one an id another organization
used. After rolling forward, run the backfill again. It records the tasks
and projects the earlier code created that still exist; ids they held and
freed meanwhile stay unknown.

An image a description save took out keeps a `dropped_at` for a day, in
Deleted items for as long as its task stays there. Releases before the one
that added it do not accept that field, so a rollback past it fails to
deploy while such an image exists. Roll forward instead.

A demo that is being prepared keeps its preparation step in `provision` on
its `demo_sessions` row, also after its visitor leaves partway, until cleanup
removes the row about a day later. Releases from before demos were prepared
in steps do not accept that field, so a rollback past it fails to deploy
while such a row exists. Roll forward instead.

The nightly read-message sweep visits only the profiles whose
`message_sweeps` row is due, and every write that marks a message read keeps
that row in step. Data restored from an older backup, or messages read while
an older release ran, can lack the row. Every 28th night the sweep starts
with a full pass that checks every profile and adds or lowers the rows that
are missing or late, so such a message is removed at most 28 days after its
retention period ends. Deleting the one `message_sweep_seeds` row makes the
next night's run start with the full pass.

Organization exports can run as a server job (`convex/orgExport.ts`), which
nothing in the app starts yet; the browser export still reads
`orgExport.page`. A job keeps its state in `org_exports`, one row per admin
who asked for it in `org_export_requests`, and its archive as compressed
parts in storage, one `org_export_parts` row per part. A ready archive stays
four hours, then its expiry, scheduled when it became ready, erases the
parts; a newer archive of the same organization ends it as soon as the
newer one is ready, so an organization holds at most one collecting job and
one ready archive. An archive holds at most 95 MiB, and 2 MiB on the public
demo, where every visitor is an admin; a larger one fails as too large.
Ended jobs and their request rows stay 30 days as history. Two crons
serve it: `organization export recovery` (every minute) restarts a
collecting job whose step stopped and fails it after three restarts without
progress, and `organization export sweep` (every 15 minutes) expires ready
archives whose timer was lost, restarts erase legs that stopped and deletes
history older than 30 days. A branch preview registers neither, so there
only the steps, the erase legs and the scheduled expiry run. The tables start
empty, need no backfill, and `organizations.last_export_at` keeps its
meaning.

A rollback past the release that added the job deploys, because Convex
leaves the rows of tables the schema does not list alone, but the earlier
code knows none of it. Its orphan sweep does not know the parts, so it can
erase a ready archive's files within its four hours; only that temporary
copy is lost. The scheduled steps, expiries and erase legs of jobs fail,
because their functions are missing, and its organization deletion, demo
cleanup and profile removal leave the export rows of an organization or
profile they remove. A deletion or demo cleanup that goes on after the roll
forward deletes the export rows left behind in its last phase. After
rolling forward, `organization export recovery`
restarts a job that was collecting while its organization and an admin who
asked for it are still there. It fails a job that must stop, because its
organization's deletion has begun or no admin who asked for it is still
one, also when they are gone, and a job that has used its three restarts.
A resumed job whose parts the earlier orphan sweep erased fails as
incomplete when it finishes. `organization export sweep` expires the ready
archives and erases their parts, and it alone deletes ended jobs with their
request rows, 30 days after they ended. Nothing needs a manual step.

Each seat's favorite top-level projects are rows in `project_favorites`,
which only `projectNav:setFavorite` writes; no app calls it yet. The table
starts empty and needs no backfill. A rename, archive or restore of a
project keeps the rows' name key and live copies in its transaction, and
profile removal, organization deletion, the public demo's cleanup, the
Northstar wipe and the Deleted items purge delete them. A rollback past the
release that added the table deploys, because Convex leaves the rows of
tables the schema does not list alone, but the earlier code writes, keeps
and deletes no favorite. A deletion or demo cleanup that goes on after the
roll forward deletes the favorites left behind in its last phase, and the
Northstar seed refuses until a wipe of the later release has deleted the
favorites of the wiped projects. What stays are copies the earlier code did
not update, which readers skip until the seat stars the project again or a
later rename that changes the name key, an archive or a restore updates
them, and the rows of profiles the earlier code removed, of projects it
purged from Deleted items and of organizations it finished deleting. No
reader shows those, except that a seat created later in the same
organization with a removed seat's id would list that seat's favorites
among its own, of projects it sees anyway. A Northstar reset under the
earlier code keeps its seats and recreates its projects with the same ids
and names, so its seats' earlier stars would show again; reset Northstar
once more after the roll forward.

The nightly archive of Done tasks reads only the tasks whose Done time passed
the 30-day threshold since its last finished run, which the one
`archive_runs` row records, and the projects in `archive_rechecks`, which
every write that can let a task fall due without a new Done time marks, such
as a project restored from the archive, or a subtask that stops counting for
its Done parent because it is archived, leaves the parent or moves to Deleted
items. About every 28th night it makes a full pass over every live project
instead, which catches a task that data written outside the app or a missed
mark left waiting, at most about four weeks late. Deleting the `archive_runs`
row makes the next run a full pass. A backup restore rewinds both tables,
which is safe, because the next run reads from the older threshold. After
rolling forward from a release before the one that added them, delete the
row so that the first run is full, because the earlier release's writers
marked no project for a recheck. A run that the earlier release began and
this one finishes, because a step of it was queued at the deploy, records no
full pass and clears the last one, so the next night is a full pass too: the
chains the earlier release ran before the deploy marked nothing either.
Deleting the row on production is a production action and needs the owner's
approval. Both tables, their
indexes and the `issues.by_archived_status_done` index ship first in that
release, so no step an earlier release queued reads them. A rollback past it
deploys, because Convex leaves a table the schema does not list alone and
drops the index. The archive steps and legs that release queued then fail
the earlier release's argument checks, so that night's run does not finish,
and the earlier release's next run walks every live project, as it does
every night.

A frontend rollback changes the served application build. It does not roll
back Convex code, schema changes, stored files or customer writes. A database
restore can discard newer customer changes and requires a separate reviewed
recovery decision. Preserve backend identities, domains and signing secrets.
