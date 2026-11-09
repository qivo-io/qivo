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
   demo and production (see Recovery and compatibility), and the release
   that adds the Overview's counts needs `internal/overviewCountsBackfill`
   the same way.

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
that fails records nothing. The Vercel build itself calls the backend's
sign-in routes after Convex pushes the functions and fails when one does not
answer as expected, so staging then records no receipt and **Prepare
release** refuses the commit (see
[The auth routes check](#the-auth-routes-check)).

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

### The auth routes check

The HTTP router loads Better Auth only in the sign-in, OAuth token,
registration and revocation, and authorization server metadata handlers,
which import `convex/auth.ts` inside the handler. Convex's open-source
runtime allows that import in an HTTP action, while Convex's Bundling
documentation says the default runtime does not support dynamic imports and
throws at run time, and nothing public shows which of the two hosted
deployments follow. A push analyzes the modules without running a handler,
so every Vercel build of the app and of the demo (branch previews, staging,
production and the public demo) checks the routes after the push.
`scripts/app-deploy.mjs` and `scripts/demo-deploy.mjs` run `convex deploy`,
whose build command records the deployment's Convex site URL in a private
temporary file outside the checkout, and then `scripts/auth-probe.mjs`
calls:

- `GET /api/auth/get-session` without a cookie, which must answer `200`
  with `null` and set no cookie;
- outside the demo, `POST /api/auth/oauth2/token` with a JSON body, which
  must answer `400` with `invalid_request` and public CORS;
- outside the demo, `GET /.well-known/oauth-authorization-server`, which
  must list `none` as the token endpoint's only method.

It waits 15 seconds for each whole answer, body included. It sends a
request again, up to 4 times, 1, 2 and 4 seconds apart, when it gets no
answer, when its answer is cut off or has not arrived in full after those 15
seconds, or when it answers a `5xx`. An answer below `5xx` that arrives
whole but says something else fails at once. The build fails when a route
still answers otherwise. Its log has one `[auth-probe]` line for each
request with the route, the status and the time, which says `cut off` when
the answer broke off after its status and `no answer` when none came. A
runtime that refuses the import answers all three with a `5xx`, and so does
a backend whose `SITE_URL`, `ADDITIONAL_APP_ORIGINS`, `QIVO_ENVIRONMENT` or
demo settings Better Auth refuses. The probe sends no credential and creates
no session, OAuth client or token. Outside the demo Better Auth still reads
the deployment's OAuth resource row on each call and creates it on a new
backend.

The same calls by hand take the host of the deployment's Convex site URL as
`SITE`, such as `name.eu-west-1.convex.site`. The Convex dashboard shows
that URL for every deployment, the demo's included, as the HTTP Actions URL
in the deployment's settings. Keep the region label, because the bare
`name.convex.site` answers `404`. The calls are:

```sh
curl -sS -w '\n%{http_code}\n' https://SITE/api/auth/get-session
curl -sS -w '\n%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://SITE/api/auth/oauth2/token
curl -sS -o /dev/null -w '%{http_code}\n' https://SITE/.well-known/oauth-authorization-server
```

They print `null` and `200`, an `invalid_request` error and `400` (`403` on
the demo), and `200` (`404` on the demo).

Convex pushes the functions before the check runs, so a failed check leaves
that backend on the new functions while its Vercel domain keeps the earlier
app, which a build that fails before the push never leaves. Act on it at
once, because a later release that sets a backend floor would make that
mismatch worse:

1. Read the `[auth-probe]` lines of the failed build. A `5xx` on every
   route it called means sign-in on that backend fails for everyone, from a
   refused import or a deployment setting, which the backend's function logs
   name. No answer, an answer cut off, or one `5xx` while the other routes
   answered as expected, can be a brief fault of the network or of Convex
   while sign-in works.
2. Call the routes by hand as above. When they answer as expected, deploy
   the same commit again. Run **Deploy staging** from main for staging. For
   production and the demo, re-run the failed **Production release** run of
   the newest release, or, while main still points at that commit, run
   **Prepare release**, which drafts main's commit under a new version (see
   [Shipping a change](#shipping-a-change)). Once main has moved, publish a
   new, higher version that targets that commit from the GitHub interface
   instead (see [Rollback and hotfixes](#rollback-and-hotfixes)). A passing
   build moves the domain and records success.
3. When they still fail, fix a wrong setting, or follow
   [Rollback and hotfixes](#rollback-and-hotfixes). Fix forward, or publish
   a new, higher version of the last commit whose build passed. A branch
   preview's failure stops the branch before main, so report it instead of
   merging.

### End-to-end API check

`scripts/staging-check.mjs` checks the REST API, MCP and OAuth consent on
staging with a real browser and real credentials. Its first step,
`auth/routes`, calls the sign-in, OAuth token and metadata routes as every
build does ([The auth routes check](#the-auth-routes-check)), and then
checks the CORS the app's sign-in relies on. A preflight of
`/api/auth/sign-in/email` from the app's origin, asking for `POST` with
`content-type` and `better-auth-cookie`, must answer `204`, echo the origin,
allow credentials and both headers, and `GET /api/auth/get-session` from it
must echo the origin and expose `Set-Better-Auth-Cookie`. The step sends no
credential and creates no session, OAuth client or token, so it runs before
the check proves the API origin, and its failure names the origin it called,
which may still lack the region label the app shows. A failure is reported as
`FAIL auth/routes` and the run goes on to the sign-in. If the app's MCP
address then names another host of the deployment, the failed step runs
again on that host, and that result replaces the first. A pass there drops
the earlier failure with a `NOTE auth/routes` line, and a failure counts
once. The run signs in as the
Northstar fixture admin with a password, creates two personal tokens, a
Standard and a Viewer agent with their keys, and two OAuth connections on the
consent screen, one with **Allow changes** and one without. With each it
checks reads, writes, refusals, attachments, activity attribution and
revocation, and the text, name, comment and request size limits. It fills
one task with 60 comments and about 510 changes, one page and a little more
of each, reads its history over REST and MCP back to the first change, and
in the task window presses **Show earlier comments** and **Show earlier
activity** until the first comment and the created row appear. Past the
comments and changes the window keeps loaded (`threadRows`, 150), a press
lets as many rows go as it loads, so each press must, once its loading row
went, move the thread's first row rather than add rows. The step then
presses **Show newer activity** until it goes
(`thread-pages/ui/newer-activity`), checks that the presses together brought
back every change after the first one's place through the newest, each once
and in order, and finds **Show earlier activity** back at the top; it skips
that check when the thread fits the budget, and when the task could not be
filled. Its uploads
check that an upload URL stores one file, and one upload is a file at the
organization's per-file limit (20 MiB by default), sent through a REST upload
ticket, confirmed, downloaded and deleted again, which shows whether the
deployment takes a body that large. A confirm sent again must answer the
same attachment over REST and over MCP and leave one row, and the same
confirm from another user must answer `404` over REST and the same refusal
over MCP (`uploads/confirm-retry`). It also checks task progress, last
comment times, delay and project completion, and the rule that a subtask in
an archived project makes no group. After it archives and restores a
sub-project it waits, for up to 30 seconds, until the family's completion
stops saying `counting`, and it checks that the restore's own answer says
`counting`, as a regroup of the counts starts in that change. Its
`machine/workload-pages` step pages `GET /v1/workload` and `get_workload`
with a fixed `from_week` to their ends, finds each of the run's agents
once with one week of hours, the same people on both surfaces, and checks
that a cursor of another window, an `offset` other than `0` and `limit=0`
are refused with their sentences. Against a backend from before the
workload pages, that step and the restore's `counting` fail. Its
`machine/people-lists` step pages `GET /v1/users` and `list_users` to their
ends, finds each of the run's agents once and the same people on both
surfaces, and finds exactly the run's agents by a search with the run's
tag. It puts the run's two agents in the run's team, checks that the team's
`member_count` is 2 and that its member pages over REST and MCP, one member
a page, list both, and removes them again. It finds a label it makes by a
search without the label's accent on both surfaces, deletes it again in the
app, and checks that `offset=1`, `limit=0`, a cursor of another search and a
users cursor sent to the teams list are refused with their sentences.
Against a backend from before the paged people lists that step fails, and so
do the run's other reads of those lists. Its `machine/task-details` step
makes a group of its own with three subtasks, links to the run's two
fixture tasks, two followers and two text files, checks that `GET
/v1/tasks/{ref}` and `get_task` answer each list whole with every cursor
`null`, pages each list at limit 1 over `GET /v1/tasks/{ref}/subtasks`,
`/links`, `/followers` and `/attachments` and `list_task_related` to its
end, carries a REST cursor into MCP, and checks that `offset=1`, `limit=0`,
a subtasks cursor sent to the links route, a cursor of another task and an
unknown query parameter are refused with their sentences. The run reads
every task's files a page at a time. Against a backend from before the
paged task details that step fails, and so do the run's reads of a task's
files. Its `machine/project-lists` step pages `GET /v1/projects` and
`list_projects` with the Standard agent's key and the run's tag at limit 1
to their ends, finds the run's project first and its tagged sub-projects
after it in key order, the same rows on both surfaces, carries a REST
cursor into MCP, finds a project by the words of its name and by its key,
and checks that `offset=1`, `limit=0`, an active list's cursor sent with
`archived=true`, a users cursor and an unknown query parameter are refused
with their sentences. The run reads every project list a page at a time.
Against a backend from before the paged project lists that step fails, and
so do the run's reads of the project lists. Its `machine/project-details`
step adds two milestones of its own to the run's project, checks that `GET
/v1/projects/{ref}` and `get_project` answer its milestones, user grants and
team grants whole on their first pages with every cursor `null`, each MCP
cursor before what it continues, pages each list at limit 1 over `GET
/v1/projects/{ref}/milestones`, `/access/users` and `/access/teams` and
`list_project_related` to its end, carries a REST cursor into MCP, pages a
sub-project's users over `/users` and `list_project_users`, and checks
that `offset=1`, `limit=0`, a milestones cursor sent to the user grants
route, a cursor of another project and an unknown query parameter are
refused with their sentences. The run reads every list of a project's grants
and milestones a page at a time. Against a backend from before the paged
project details that step fails, as the new routes answer `404`, and so do
the run's reads of those lists. Its `machine/inbox` step mentions the run's
Standard agent in a comment on each of three tasks it makes, pages the
agent's inbox at limit 1 over `GET /v1/inbox` and `list_inbox` to its end,
where each of the three must come once, newest first, carries a REST cursor
into MCP, checks `unread_only` before and after `POST /v1/inbox/read`, and
checks that `offset=1`, `limit=0`, an `unread_only` cursor sent without
`unread_only`, a users cursor and an unknown query parameter are refused
with their sentences. Against a backend from before the paged Inbox that
step fails, as `GET /v1/inbox` answers no `next_cursor`. In the
browser it then opens the Board of the project it made, waits for the
deployment's answer for it (`tasks.board`)
and checks that the cards of its two fixture tasks show, which it makes in
To Do so that they show with **Focus** on or off. It then opens the window
of one fixture task and, from the deployment's batches
(`taskWindow.relationCandidates`), finds the other one in **Link task** by
its ID, a search with no match that says so at the end of the project and
again once **Search all your projects** ended, a task it makes in its second
project only after **Search all your projects**, and the subtask it made
as a current subtask in **Add subtask**, and writes nothing through the
pickers (`ui/relation-pickers`). Against a backend from before the relation
pickers' release that step fails. In the same window it makes a label with
its run tag over REST, finds it through **Add label**'s search on the
deployment's batches (`labels.picker`), puts it on the task and takes it
off with the chip's ×, creates `<tag> Made in picker` from the picker with
Enter once **Create new label** shows, and in the comment composer picks
the Standard agent from the @ mention popup (`pickers.mentions`) with
Enter, then clears the draft so nothing posts and nobody is notified
(`ui/label-mention-pickers`). Each label change is checked over REST, and
the step deletes both labels in the app before it returns, also after a
failure, so the later `ui/settings-labels` search for the run tag finds
only its own label. Against a backend from before the mention suggestions'
release the mention part fails. It then
makes a
sub-project of its own under that project, with one To Do task due 70 days
ago and one paused To Do task without a due date, opens the sub-project's
Overview, waits for the deployment's answers (`overview.summary`,
`overview.risk`, `overview.attention` and `overview.paused`) and checks that
Completion, Paused, the opening sentence and both lists count exactly those
two tasks. It then opens its project's Overview, waits for the health
table's answer (`overview.health`), finds the sub-project's row among the
project's few sub-projects and checks its cells: Progress 0%, Done 0/2,
Paused 1, Left and Slipping blank, and Delayed 1 where the sub-project
tracks delay, as its REST answer's `track_delay` says, else blank. A press
on the row's name must open the sub-project's Board on the deployment's
answer. That needs a backend from the release that added `overview.health`
or later, whose organization counts are whole, as
`internal/overviewCountsBackfill` left them. Against an older backend, or
while the counts read **Counting…**, the step fails. It then records the
frames the page sends on its sync socket and opens its project's Board,
one fixture task's address and its project's Roadmap in fresh loads, each
of which reads its tasks from its own read. The Roadmap must reach its ok
state and show that task's row, having subscribed its own read
(`tasks:roadmap`) and never the planning panel's old read
(`planning:assigneeLoad`) (`ui/own-reads`). It reads only,
and an app from before the Roadmap read the server fails it. Next it makes a
sub-project of its own with its run tag under the run project, with one task, over REST,
records the frames the page sends and receives on its sync socket from a
fresh load of that sub-project's Board, presses **New task in To Do**,
creates a task with its run tag through the dialog and renames it in its
window at once. No read of the new task (`taskWindow:task`, `snapshot:threadComments` or
`inbox:item`) may be sent before the answer to the create's `issues:create`
mutation arrives. The step knows the task by the uuid its create sent and
its key by the number that answer stored, since another create in the
organization meanwhile can move the key the window showed first. The window
and the card must show that key, the window must show the new title, and
the task, read over REST by its uuid, must hold the title under that key
(`ui/create-answer`). The run's sweep removes the task and
the sub-project, and an app from before a create stopped loading every task
fails it. Next it makes a label
with its run tag over REST, puts it on one of its fixture tasks, opens
**Settings → Labels** on the deployment's batches (`labels.settingsPage`),
finds the label by search with **1 active task**, renames it in place and
deletes it in its delete window (`ui/settings-labels`). While a label count
backfill runs on the deployment, the counts read **Counting…** and that step
fails. Next it makes a team of its own with its run tag over REST, finds it by
search on **Settings → Teams** (`teams.settingsPage`) with **0 members**,
adds the Standard agent on the team's page through **Add member**
(`teams.get`, `teams.members` and `teams.addable`), checks over REST and on
both pages that the team has **1 member**, renames it in place, removes the
agent and deletes the team from the list (`ui/settings-teams`). Against a
backend from before the release whose app reads the team pages from the
server that step fails. Next it loads the run project's Board, whose sync
socket must subscribe neither `workspace.people` nor `workspace.catalog`,
with Nora's own seats alone in the store, finds Leo Martins in the Board's
**Assignee** menu (`pickers.mentions`), whose pick reads the Board with
him among its owners and whose **×** clears it, gives him Viewer on the
run's Alpha sub-project, finds him by his address under **+ Add** in the
follower popover of a task there (`pickers.taskFollowers`, which offers
only people who see the task's project), closes it without adding him and
takes the grant away again, and finds the run's team by its tag in
Team sync's scope menu (`teams.picker`), whose pick names it on the
trigger and reads the team's agenda (`ui/roster-parts`). Against a backend
from before the release after v0.1.160 that step fails. When it fails after
it sent Leo's grant, it removes the grant once more as a check of its own
(`ui/roster-parts/revoke`), so a grant it could not remove is among the
run's failures. It then searches **Settings → Users** for its
Standard agent by its
full name, which the deployment's page (`people.settingsPage`) lists alone
with the fingerprint of its named key from a one-shot key read
(`tokens.agentKeys`), opens its keys, and checks that **Organization →
General**'s creators line (`orgs.projectCreators`) names and counts what
`GET /v1/users` implies for the fixture's setting; under **Selected users**
REST cannot tell who was chosen, so it checks the admins the line names
(`ui/settings-users`). Against a backend from before the release whose app
reads Users from the server that step fails, as the page cannot load. It
then makes a sub-project of its own under its second project, with
a User grant and a To Do task for the Standard agent, removes the agent's
grant in that sub-project's settings, waits for the removal window to list
the task from the deployment's preview (`accessRemovals.preview`), chooses
Nora in the **Reassign** picker's search (`accessRemovals.reassignChoices`)
and saves, then checks over REST that the task is Nora's and the agent's
grant is gone (`ui/removal-window`). Against a backend from before the
removal window's release that step fails. In **New project** it then makes
a project of its own with its run tag, led by the Standard agent and shared
with the run's team as Viewer from the deployment's pickers, and checks
that the dialog's own entry for a creator who names someone else as lead
shares it with Nora as User, which it leaves as it is. It opens **New
sub-project** from its first project's menu, picks the new project from
the **Project** list and makes a sub-project there, and checks both over
REST (`ui/project-dialogs`). The cleanup deletes both. Against a backend
from before the release after v0.1.140, which still requires
`sort_order`, that step fails. Over REST it then makes `<tag> Managed`,
led by the Standard agent, takes Nora's automatic User grant there away,
and with the agent's key adds `<tag> Managed sub` with a task, and it
makes `<tag> Managed control` under its first project with a task of
Nora's own. It checks that Nora, an organization admin who manages
`<tag> Managed` without taking part in it, reads it with `access.read`
false, completion unavailable and no milestones, cannot read its task and
saves its description, and in the app that **Settings → Projects** lists
it, that its **Archived tasks** says it can't show the project's tasks,
and that Search finds the control task and not the managed one
(`ui/admin-management`). It deletes `<tag> Managed`, its sub-project and
task after the step, also after a failure, and reports that delete as
`cleanup/admin-management`; the control sub-project goes with its first
project in the cleanup. Against a backend from before the release after
v0.1.159, where admin status still gives access to project work, that
step fails. It then makes a sub-project of its
own under its first project, uploads one file of 2,048 bytes over REST to a
task there, opens **Billing**, checks that current storage shows a figure
rather than **Being counted**, finds the sub-project alone with **2.0 KB ·
1 file** by searching **Storage by project** for its run tag and the word
storage, and deletes the file over REST, also after a failure
(`ui/billing-storage`). That shows the deployment's stored-byte totals are
counted and that the page reads them (`billing.usageFigures` and
`billing.storageProjects`). Against a backend from before the release after
v0.1.144, whose Billing page reads `billing.details` and
`billing.usageFigures`, that step fails. It then calls `GET /v1/me` once
with each of the run's two agent keys still in use, the Standard agent's
named key and the Viewer agent's key, opens **Billing** again, checks that
**API calls** shows a figure rather than **Being counted**, finds the
run's Standard and Viewer agents alone by searching **API calls by
account** for its run tag, each with at least one call, opens **View
credentials** on the Standard agent, which must open API access on that
agent and the period Billing showed, and finds both agents again by
searching **Who counts toward your bill** for the run tag
(`ui/billing-accounts`). It writes only the usage of those two calls. That
shows the deployment's usage aggregates are complete and that the page
lists and searches the run's own accounts (`billing.apiAccounts` and
`billing.accountList`). Against a backend from before the release after
v0.1.144 that step fails. It then opens **MCP access** and searches
**Connected apps** and **Personal access tokens** for its run tag, where
the deployment's batches (`connectedApps.list` and `tokens.personalTokens`)
list the run's two connections and two tokens newest first, alone when the
list shows its search, and a token search that matches nothing says so
(`ui/mcp-access-lists`). A list shows its search only once it holds more
than 25 rows. On a deployment with fewer, the step reads the run's rows from
the list's first batch, the store's read for the run tag must answer the
run's two rows alone, and the store's read answers the token search with no
match. Against a backend from before the release after v0.1.158 the run
stops at `setup/target`, whose visit to **MCP access** waits for
**New token**, which the app shows only once `tokens.personalTokens` has
answered, so the run creates nothing and sweeps nothing, and a `--cleanup`
run stops there too. Back in the run's task window it attaches a small
file, which must go on an upload ticket: its `POST` must go to
`/attachment-uploads/` on the API origin and answer 200, the window must list
the file and its download must match the bytes, and the step deletes it again
(`ui/attachment-upload`). That step and `uploads/confirm-retry` fail against a
backend from before the release after v0.1.135. After startup selection
(`ui/startup-selection`) it opens `/board/all`, an address that once named
all projects, which must give way to the startup rule's page with **All
projects** unlit, makes `<tag> Old paths`, led by the Standard agent, takes
Nora's automatic User grant there away, and opens its numbered
**Settings** address, which must show the project's page and keep that
address through a reload, and a number no project holds, which must open
**Your preferences** (`ui/old-paths`). It deletes the project after the
step, also after a failure, as `cleanup/old-paths`. Against a backend from
before the release after v0.1.160, which reads a project's settings by id
alone, that step fails. Then it makes 26 tasks of
its own and deletes them over REST, searches its run tag in **Settings →
Projects → Deleted items** and waits until the page answers that nothing
matches without projects, then picks its project and kind **Tasks**, opens
the folded run with **Show all**, selects the first page of 25 and the 26th
on the next, and restores them as one action of two calls after the window
says to keep Qivo open, then checks over REST that all 26 are live. It
deletes a sub-project of its own in the app, finds it among the deleted
projects without a scope, and deletes it for good once **Delete now**
counts no earlier items (`ui/deleted-items`). The
cleanup deletes the 26 tasks again with its project. Against a backend from
before v0.1.131 that step fails.
Next it makes a task of its own and deletes it over REST, then, with a file
of the browser's origin private file system standing in for the save
picker, which no headless browser can press, presses **Export data** in
**Settings → Organization → General** as Nora. It waits up to five minutes
for the deployment's export job to be ready, its own job and not an earlier
ready archive, which it tells apart by the job's id, notes how long it
took, waits for the automatic save into that file and its record, reads
the file back,
unzips it and checks its format 4 manifest, t0 in `data/tasks`, its deleted
task in `deleted/tasks` and `deleted/items`, no file contents and its size,
and that the record line shows today's date (`ui/org-export`). It writes on
t0's organization what an admin's export writes: a job with its parts for
four hours and its rows for 30 days, the end of an earlier ready archive and
the organization's last saved export. Afterwards it deletes the file and its
Deleted item for good, also after a failure. It finds the item by its id
in the archive, or, when it failed before it read the archive, by the
task's tagged title in **Deleted items**. A purge that is refused or fails,
or that finds no item, is a NOTE, and the item then stays 30 days. Against a backend before the release after v0.1.161, whose record
takes no export id, that step fails.
It makes a sub-project of its own under the run project, led by Leo
Martins, with a task in it, picks the task's assignee (the run's Standard
agent), its reviewer (Nora) and **No reviewer** in the task's window and
Nora as its owner on its Team sync card, each from the deployment's people
pickers and each checked over REST; then the card's Mention window picks
Leo, the sub-project's lead goes back to Nora over REST and the User grant
the handover leaves Leo is removed, until `GET /v1/projects/{ref}/users`
stops listing him, and **Send** must post
nothing and say Leo can no longer be mentioned (`ui/owner-pickers`). It
notifies only the run's own Standard agent, which follows the task once it
is assigned and gets the task's later changes, such as its handover to
Nora, in its Inbox; no fixture person is notified. Against a backend from
before v0.1.147 that step fails.
Before the archive, it
checks that the top bar's Inbox badge shows what the deployment's unread
summary (`inbox.summary`) says, has the Standard agent mention Nora in a
comment on the run's fixture task in Alpha over REST, which the badge must
count, opens that task at its address, whose window must draw the **New**
divider above the comment from its inbox item (`inbox.item`) and read the
item (`messages.readItem`), so the summary drops back, and removes the
task's item from Nora's Inbox with the row's own **Remove notification**
(`ui/inbox-badge`). Against a backend from before v0.1.97 that step fails.
In a page granted notifications for the app's origin it then checks a
desktop alert (`ui/inbox-feed`). Once the page took its fresh start's
baseline, the Standard agent mentions Nora on the fixture task over REST,
and one alert must carry that message's id as its tag and the agent's
mention as its title, from `inbox.feed` and a granted
`notifications.claimAlerts`, with no `workspace.inbox` watched; with the
page's sync socket closed once, a second mention must reach no alert of its
own and one generic summary must follow after `notifications.claimSummary`,
which goes before the next claim. It removes the task's item again at the
end and brings the run's app page back to the app, as the in-app cleanup
needs it. Against a backend from before the release after v0.1.161 that
step fails. Then, in a fresh browser context for Nora with the run's bypass and
notifications granted, it opens the app in two pages and checks the leader
tab (`ui/notification-delivery`). Exactly one page must lead, **Settings →
Your preferences → Notifications** in the other must show the server's mode,
then **All enabled sessions** and **Most recently active session** from the
server once chosen, a mention of Nora from the Standard agent must reach the
leader's alerts alone, tagged with its message or with the generic
summary's tag, and the other page must lead once the leader's page closes.
The step puts Nora's mode back once the control shows it from the server,
removes t0's item from her Inbox and signs its context out from one of its
open pages, or a new one, since the session cookie signs in every page. It
signs out once the sign-in went through, also when the app then never
loaded, with the account page's **Sign out**, or with the app's own
sign-out request where that page does not render, and a cleanup that cannot
do one of these fails the step. Against a backend from before the release after v0.1.161
that step fails, since the leader's alerts come from `inbox.feed`; v0.1.154
first shipped only its session calls.
After that it checks
the
search on **Settings → Projects → Archived tasks** and main Search, where an
active task the run made must show with **Include archived tasks** off and a
task the run archived only with it on. That shows whether the deployment's
search index takes the filter for an absent `archived_at` and still returns
active matches. The archived task must then open read-only in its task
window, with its description and, under **All**, its history, which shows
whether the deployment answers an archived task's text and history. Archived
tasks chooses its project through the shared project picker, found by name,
and between the two searches the run chooses through that picker on the
deployment's navigation reads (`ui/project-picker`): it lists its project's
two sub-projects from `projectNav.children` and chooses both, which must
list exactly its three archived tasks, takes one sub-project's chip off,
finds that sub-project with its project from `projectNav.search`, opens an
archived task over Archived tasks read-only with its description, and
narrows Search to the sub-project, where **Include archived tasks** must
find exactly the task archived there. Against a backend from before v0.1.126
both Archived tasks steps fail, as each finds its project through the
picker's search. It then
opens task links in fresh loads (`ui/task-link`): that archived task's,
which must show read-only under its archived note with its title,
`/tasks/qn-99999999`, which must say the task can't be opened, and an active
task's, which must show its title with no note. That shows whether the
deployment answers a task's number in the organization the address names
(`taskWindow.task`). The step is skipped with the archived steps when the
run could not make its archived tasks.
Everything it creates
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

### A large organization on a local backend

To check the Board at scale by hand, grow that local Northstar copy with
`node scripts/board-scale-seed.mjs --local --deployment local-<name>-<port> --url <backend origin>`,
which takes the same loopback origins, `QIVO_FIXTURE_LOCAL=true` and
`QIVO_LOCAL_ADMIN_KEY` as the Northstar seed and refuses every other
target. It adds 10,000 tasks and a parent for every 25 of them, as Nora,
the organization's admin, through the app's own task mutations, one at a
time. `--tasks` sets any count from 0 to 30,000, for the Board's, the
Roadmap's and Search's reads of a large organization, which read their own
answers. The tasks come in every status, with subtasks, due dates, pauses,
long titles and unowned tasks. Their titles read like Northstar's, so the
Board's card height estimates meet realistic text, and each description
names the task's number. Run it again to add only the tasks still missing;
it also finishes a parent and subtasks it stopped in the middle of, under
the parent it already made. It writes to that local backend alone.

The Board shows at most 1,000 tasks, subtasks included. The default 10,000
tasks spread over Northstar's 12 sub-projects put each top-level project
over that limit and each sub-project under it, at about 840 tasks; from
about 12,100 seeded tasks each sub-project passes it too. `--sub-project
<key or name>` puts the tasks a run adds into that one sub-project, for
checking a sub-project's Board at the limit: a family, a parent over four
tasks, adds four tasks the limit counts, and a task on its own one. A family
an earlier run started finishes in the sub-project of its first task.

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
links left out. Five of the linked tasks have one subtask each. A second
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
before recording success. Each Vercel build calls its backend's sign-in
routes after Convex pushes the functions and fails when one does not answer
as expected, which fails the release after that backend already runs the
new functions (see [The auth routes check](#the-auth-routes-check)). These GET checks do not replace authenticated
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
could not be loaded" while the period has API calls. The app from v0.1.84 to
v0.1.106 reads the window of a task that left the board through
`issues.archivedTask`, and from v0.1.103 also the window of a task Search
opened that the workspace does not hold, so that window says it couldn't check
the archive. The app before v0.1.110 saves the hours its Update estimates
window edits through `roadmap.change` while Roadmap records its undo history.
From the release that left Remaining out of that history, `roadmap.change`
refuses `remaining_hours`, so after such a rollback those saves fail and the
hours go back. The app before v0.1.15
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
**Retry** once for each call after the first, 7 times with the current demo
data.

The app before v0.1.145 reads Billing's details through `billing.summary`
and its usage through `billing.currentUsage`, and the app before v0.1.135
its usage through `billing.usageReport`. The release after v0.1.150 removed
all three, so after such a rollback Billing shows the error of the missing
function in place of its details and says "Usage could not be refreshed".

The app before the release after v0.1.158 lists **MCP access** through
`oauthConnections.list` and `tokens.listMcpTokens`, and the app before
v0.1.147 reads an agent's keys on **Settings → Users** through
`tokens.listAgentKeys`. The release after v0.1.158 removed all three, so
after a rollback to either app, MCP access cannot list connected apps or
tokens, and after a rollback to the app before v0.1.147 every agent's key
line also reads "no key, cannot sign in" and its key panel says it has no
keys, though the keys still work; **Organization → API access** lists them.

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
instead. The app from the release after v0.1.160 on needs its backend's
`teams.picker`, `pickers.taskFollowers` and the root part's own rows, and
the app from the release after v0.1.161 on reads its projects through
`projectNav.byIds`, `projectNav.targets` and `projectNav.holds` and its
desktop notifications through `inbox.feed`, all of which that release first
ships, so never return the backend to a commit before the release after
v0.1.161. Every app before
the release after v0.1.161 subscribes workspace parts that later backends
no longer have, `workspace.projects`, `workspace.tasks` and
`workspace.inbox`, and before the release after v0.1.160 also
`workspace.people` and `workspace.catalog`, so
it cannot load its workspace against them, and that includes a tab already
open when the release deploys, until it reloads. Never return the app or
the demo alone, Vercel Instant Rollback included, to a deployment of a
commit before the release after v0.1.161; roll forward.

The app before v0.1.149 lists **Settings → Projects → Deleted items**
through `deletedItems.list` and searches it through `deletedItems.matches`,
which the release after v0.1.160 removed, so its Deleted items page cannot
load against a later backend. Never return the app or the demo alone to a
deployment of a commit before v0.1.149.

REST `GET /v1/tasks` and MCP `list_tasks` page active tasks with a cursor
from the release that made them answer `{next_cursor, tasks}`. Returning the
backend to a commit before it makes active lists answer an array again,
honors `offset` again and refuses a `cursor` without the archived flag
(`cursor works only with archived=true`, or `archived: true` on MCP). A
REST or MCP caller that pages active lists with `next_cursor` then stops
working until the backend rolls forward. List rows' delays never say
`unavailable`, and project completion loses `status`. Such a deploy drops
the index `issues.by_project_archived_created`, and the deploy forward
builds it again, with no change to data. This sets no floor for the app,
which calls neither route.

REST `GET /v1/workload` and MCP `get_workload` page people with a cursor,
and project completion over REST and MCP reads the stored counts, from the
release that made the workload answer `{next_cursor, week_starts, project,
hidden, people}`. Returning the backend to a commit before it makes the
workload answer every person in one answer again, without `next_cursor`,
`hidden` or a person's `status`, and refuse `limit`, `cursor`, `offset` and
`person` as unknown parameters. A REST or MCP caller that pages the
workload with `next_cursor` or asks for one `person` then stops working
until the backend rolls forward. Code written for the older answer keeps
reading `people` after the release, but sees only the first page, at most
50 people, as if it were everyone, without any error, so callers must
follow `next_cursor`. Completion then reads tasks again within a budget and
never says `counting`. This sets no floor for the app, which calls neither.

The app's Board, the phone's task list and My view's Board read which tasks
they show from `tasks.board`, which v0.1.107 (`b7d2abac`) first shipped. An
app from the release that switched them to it, against a backend before
v0.1.107, says on every Board that it could not be loaded, also in a tab
that was open when the backend went back, until the backend rolls forward.
From that release on, never return the backend to a commit before v0.1.107
(`b7d2abac`); roll forward instead. Returning the app alone to a release
before that one is safe against a later backend, because that app filters
the Board's tasks in the browser.

The app's Overview reads its summary, its projected delays and its two
lists from `overview.summary`, `overview.risk`, `overview.attention` and
`overview.paused`, which v0.1.112 (`9dd4ef7f`) first shipped. An app from
the release that switched the Overview to them, against a backend before
v0.1.112, says on every Overview that it could not be loaded, also in a tab
that was open when the backend went back, until the backend rolls forward.
From that release on, never return the backend to a commit before v0.1.112
(`9dd4ef7f`); roll forward instead. Returning the app alone to a release
before that one is safe against a later backend, because that app derives
the Overview in the browser. The Overview's figures read the counts that
v0.1.110 (`b38c4e1c`) added and its release step backfilled
(`internal/overviewCountsBackfill`), so this release adds no step; an
organization whose counts are not whole shows its counts as counting until
they are.

The app's Overview reads its health table from `overview.health`, which the
release after v0.1.115 first ships. An app from that release, against a
backend before it, says that the health table could not be loaded, also in
a tab that was open when the backend went back, until the backend rolls
forward. From that release on, never return the backend to a commit before
it; roll forward instead. Returning the app alone to an earlier release is
safe against a later backend, because that app derives the health table in
the browser. The health table reads the same counts as the summary, so the
release adds no step.

The task window edits a task the workspace does not hold yet from the
window's own read of it, through the mutations the app already sends
(`issues.update`, `issues.move`, `issues.archive`, `issues.deleteDeep`,
`labels.toggle`, `issues.subscribe`, `issues.unsubscribe`,
`issues.setSubscriber`, `files.uploadUrl`, `files.attach` and
`files.removeAttachment`), with the expected values of that read. The
release that first does so changes no server function, so it has no server
change, no step and no rollback floor. An older app works against its
backend, and it works against an older backend that has the task window's
read.

A task link, a bookmark, Back and Forward and an Inbox row open their task
through the task window's read (`taskWindow.task`), by the task's number or
its uuid in the organization the address or the message names, and a boot
on a task address reads it with the workspace's first parts instead of
waiting for every task. The task window reads the owner's load of a task it
cannot judge from the workspace through `planning.ownerLoads`. The release
that does so changes no server function, so it has no server change, no
step and no rollback floor. An older app works against its backend, and
this app works against any backend that has the task window's read and
`planning.ownerLoads`, which the floors above already hold.

Settings › Labels reads its rows 25 at a time from `labels.settingsPage`,
which v0.1.97 (`92434062`) first shipped, and keeps the batches it loaded
live while the page shows. The release that switches the page to it
changes no server function, so it has no server change, no release step and
no new rollback floor. An older app works against its backend, and this app
works against any backend from v0.1.97 on, which the floors above already
hold.

The project navigation reads `projectNav.page`, `projectNav.children` and
`projectNav.resolve` first shipped in v0.1.118 (`13f4bcba`), which set no
rollback floor and needed no step. The shared project picker is the first
app that calls them, and its paragraph below says which floor that app
needs. From the release after v0.1.155, whose paragraph below says the
same, the All projects directory calls `projectNav.page`, `children` and
`search`; v0.1.126 (`1228de4c`) first shipped `search`. The reads use only
the reach rows and name keys every deployment holds since v0.1.97 and the
favorites rows below. `projectNav.page` and `projectNav.children` answer
`not_ready` for an organization without both of its `org_ready` stamps,
and `projectNav.resolve` answers without them. The reads skip the
favorites a rollback past the favorites release leaves, by the reader rule
the favorites paragraph below describes, so such a row never shows and
keeps its project, where the seat sees it, in the list of the rest. From
the release after v0.1.158 the sidebar's project tree calls
`projectNav.page` and `children` too, as its paragraph below says.

The Roadmap's server reads, `tasks.roadmap` and
`tasks.roadmapDependencies`, first ship in the release after v0.1.119
(v0.1.120). No app of that release calls them, so it sets no floor of its
own. The app reads them from the release after v0.1.139, whose paragraph
below names v0.1.125, which holds them, as the backend that app needs,
already held by the upload floor v0.1.136. The Board's filter read moved into
`convex/lib/viewFilters.ts` with `tasks.board`'s answers unchanged. There
is no schema change, no backfill and no release step.

The app's removal window reads `accessRemovals.preview`, which v0.1.99
(`78f5d6ad`) first shipped, with its `reassign_to` argument and its
`keep.offered`, `keep.permitted` and `reassign.permitted` fields, and its
Reassign picker reads `accessRemovals.reassignChoices`. The release after
v0.1.120 first ships the argument, the fields and the picker's query. An app
from that release, against a backend before it, says that it could not check
which tasks a removal affects and removes nothing, also in a tab that was
open when the backend went back, until the backend rolls forward. From that
release on, never return the backend to a commit before it; roll forward
instead. Returning the app alone to an earlier release is safe against a
later backend, because that app works a removal out from its loaded tasks
and the backend keeps every earlier argument and field. The release adds no
step.

From the release that first ships `deletedItems.page`, every task moved to
Deleted items stores its search text, its assignee and copies of its item's
deletion time, deleter, project and parent on its `deleted_tasks` row, and
the page's search and assignee filter read them. No app of that release
calls the page; the app reads it from the release after v0.1.148, whose
paragraph below names v0.1.131, which holds it, as the backend that app
needs. Code from before that release lists `deleted_tasks` without these fields, so
it does not accept a row that holds them, and once any row does, a backend
from before the release fails to deploy, as the description copies below do
for `issue_descriptions` (see Recovery and compatibility). A restore of a
task item also saves its job at the new phase `restore_clear` while steps
delete those rows of the tasks it brought back, which that code does not
accept either. That holds from
the first delete after the deploy for as long as Deleted items keeps such a
row, so from that release on never return the backend to a commit before it;
roll forward instead. Returning the app alone to an earlier release was
safe then, because no app of that release called the page; the release after
v0.1.160 removed `list` and `matches`, so from it on the app alone never goes
below v0.1.149. Rows stored before the release keep none of
the fields and need no step. The page finds their tasks by key only since
the release after v0.1.160, and says so (`legacy`) until they leave Deleted
items. Convex builds the page's new indexes of `deleted_items` and
`deleted_tasks` at deploy. The release after v0.1.160 removed `list`,
`matches` and the `search_title` index; `item` stays.

The Inbox's pages, `inbox.page`, first ship in the release after v0.1.122.
When it shipped no app, REST or MCP caller read them, so that release set no
rollback floor and needed no step. The release after v0.1.158, whose app
lists the Inbox from them, makes v0.1.123 the backend's floor for that app,
as its own paragraph below says. The pages read the `inbox_items` and
`inbox_state` rows every deployment holds since the inbox items backfill
below, and the release changes no table, field or index. The same release
makes `inbox.item` answer `unread_change` for an unread mention in the
description too, as the app's task window counts it, which the task window
reads from the release after v0.1.147 on.

From the release after v0.1.124, `planning.ownerLoads` answers each span's
`project_id` where the span names its task, and each owner's paused tasks
in live projects the caller can see as `paused`. No app reads either yet.
The Board's and the task window's owner-load cache keeps the spans as
before and leaves `paused` out, so that release sets no rollback floor and
needs no step, and an older app ignores both fields. An owner's paused work
now counts toward the owner reader's bounds in that query, so the Board and
the task window can show Delay unknown for an owner whose paused work
takes them past those bounds, where they showed a delay before. Every
other owner's delay stays as it was. In a staff call the paused reads also
spend the call's room, so an owner can come back `not_read` sooner and the
cache asks for it again in a call of its own. `planning.assigneeLoad`, the
REST and MCP workload pages and delays and the Overview ask nothing about
paused tasks' projects or subtasks, and read and answer as before. The app
reads the fields from the release after v0.1.139, whose paragraph below
names this release (v0.1.125) as the backend that app needs, already held
by the upload floor v0.1.136. There is no schema
change and no backfill.

From the release after v0.1.125, a member's task history in the task
window, over REST and over MCP checks each project its rows name instead of
reading every project of the organization, and REST and MCP creates count a
new top-level project's place from the organization's top-level projects.
Inside Qivo's fixed access limits the answers do not change, so that release
sets no rollback floor and needs no step, and returning the backend or the
app to an earlier commit stays safe. A person whose access Qivo cannot
finish checking within those limits now gets that refusal on a task's
history too, as on the workspace. There is no schema change and no backfill.

The directory's name search across a person's projects and sub-projects,
`projectNav.search`, first shipped in v0.1.126 (`1228de4c`), which set no
rollback floor and needed no step. The shared project picker is the first
app that calls it, and its paragraph below says which floor that app
needs. The search reads only the reach rows and name keys every deployment
holds since v0.1.97 and the favorites rows below, and the release changes
no table, field or index. It answers `not_ready` for an organization
without both of its `org_ready` stamps, and it skips the favorites a
rollback past the favorites release leaves, by the reader rule the
favorites paragraph below describes, as the navigation reads do.

The task window's Parent, Subtasks and Linked tasks pickers read the tasks
they offer from `taskWindow.relationCandidates`, once a batch and never
subscribed, which the release after v0.1.126 first ships together with the
app that reads it. An app from that release, against a backend before it,
says in every relation picker that it couldn't load tasks, also in a tab
that was open when the backend went back, until the backend rolls forward.
From that release on, never return the backend to a commit before it; roll
forward instead. Returning the app alone to an earlier release is safe
against a later backend, because that app filters the workspace's tasks in
the browser. The same release lets the window change the parent, subtasks
and links of a task it shows from its own read, through the mutations the
app already sends (`issues.update`, `issues.create`, `issues.createParent`,
`issues.createLinked`, `issues.addLink` and `issues.removeLink`), with the
expected values that read showed. There is no schema change, no backfill
and no release step.

From the release after v0.1.127, `teamSync.agenda` answers one Team sync
meeting for one scope, a project, a team or All projects, with every task
the page shows, the people it walks and their week's hours, within Team
sync's ceiling of 1,000 tasks. That release's app did not call it, so the
release set no rollback floor and needed no step. The Team sync page reads
it from the release after v0.1.138, which makes this release, v0.1.128, the
backend's floor for that app, as its own paragraph below says. The same
release moves `teamSync.lastComments` off its read of every project of the
organization. It asks the caller's
access only about the projects its owners' tasks name, counts a task in a
project the caller cannot see at a fixed size, so its text no longer moves
`complete`, and answers `complete: false` past 200 such projects or where a
bound of the caller's own access reads stops a check, which the app already
answers by asking for fewer people at a time. Its arguments and the rows it
answers otherwise stay as before. The Overview's delay verdicts moved to a
module the agenda shares, with every Overview answer unchanged. The clock
check the Overview's queries and the agenda share now also refuses, as a
bad request, a clock whose last week does not begin at a local midnight of
its `week`, which no app sends. The same release's app begins every week of
its grid at the first instant of the week's first day. In a zone whose
daylight-saving change skips a midnight, such as Santiago, Havana, Beirut,
the Azores or Cairo, the grid began every week an hour late on that day,
and, where the organization's weeks begin on that weekday, through the week
that begins on it and again 11 weeks later, when the grid's anchor fell on
it. So there the Overview placed a change made in the first hour of a week
in the week before, and the Roadmap's due mark could say a plan ends after a
due date on the first day of its last planned week. `lib/visibility.ts`
`orgProjectView`, which read every project of the organization and
lastComments was the last to call, is gone; the tests keep it as an oracle.
There is no schema change and no backfill.

The project lists of Settings, `projectSettings.projects`, `subProjects`,
`archived` and `archivedSubProjects`, first ship in the release after
v0.1.128. No app calls them yet, so that release sets no rollback floor for
them and needs no step, and returning the backend to a commit before it
stays safe while no app calls the lists. The release whose app first calls
the lists makes the release that shipped them the backend's floor, and its
own paragraph here says so. They add the index `projects.by_org_state_name`,
which Convex builds at deploy with no backfill, and which a rollback drops
with no effect on stored data. The lists read the archive states, reach
rows and name keys every deployment holds since v0.1.97, and answer
`not_ready` for an organization without both of its `org_ready` stamps.

The shared project picker, which **Search in** and **Settings → Projects →
Archived tasks** open, first ships in the release after v0.1.129. While it
is open it keeps its batches of `projectNav.page`, `projectNav.children` and
`projectNav.search` live, and Search and Archived tasks read
`projectNav.resolve` once for the project they open on. v0.1.118
(`13f4bcba`) first shipped `projectNav.page`, `projectNav.children` and
`projectNav.resolve`, and v0.1.126 (`1228de4c`) first shipped
`projectNav.search`. The release changes no server function, so it has no
server change and no release step. An app from that release against a
backend before v0.1.126 says in a picker's search that it couldn't load your
projects, and against one before v0.1.118 says so in every picker list and
opens Search on **All projects** and Archived tasks on no choice, while the
**All projects** rows still work, also in a tab that was open when the
backend went back, until the backend rolls forward. So this app needs a
backend from v0.1.126 (`1228de4c`) on. The relation pickers' floor above,
v0.1.127, already holds that, so this release sets no new floor. From it
on, as from that one, never return the backend to a commit before v0.1.127;
roll forward instead. Returning the app alone to an earlier release is safe
against a later backend, because that app lists the workspace's projects.

From the release after v0.1.130, `deletedItems.roles` answers each seat of
the login its role in Deleted items and whether Delete now applies there,
`deletedItems.people` answers the people of one organization 25 at a time
in name order for Deleted by and the assignee filter, and
`deletedItems.purgeSummary` answers an organization admin how many items
Delete now deletes with a project item. `deletedItems.page` takes `someone`,
the deletes of people no longer in the organization, and its `via` takes a
credential kind, which matches every delete through that kind of
credential, so an admin's `via: 'mcp_tokens'` now lists the deletes
through personal tokens where it listed none. No app of that release calls
any of them, so it sets no rollback floor and needs no step. The app reads
them from the release after v0.1.148, whose paragraph below names this
release (v0.1.131) as the backend that app needs, already held by the floor
of the release after v0.1.140. The same release has
Deleted items judge an organization admin by what the admin's role reads,
which changes no answer until the admin access split; after it an admin
keeps every item with its metadata and Delete now, and sees no task title,
search hit or content without ordinary access. The release changes no
table, field or index, and there is no backfill.

REST `GET /v1/users`, `/v1/labels` and `/v1/teams` and MCP `list_users`,
`list_labels` and `list_teams` page with a cursor and take a name search,
every team answer is `{id, name, member_count}` without its members, and a
team's members have their own list, REST `GET /v1/teams/{id}/members` and
MCP `list_team_members`, from the release after v0.1.131, which makes the
lists answer `{next_cursor, …}`. From that release `GET` and `PATCH
/v1/users/{id}` read their one user by id. Returning the backend to a commit
before it makes the three lists answer whole arrays again and every team
answer, `GET /v1/teams/{id}`, `POST`, `PATCH` and `set_team`'s included,
embed `members` again, without `member_count`. REST then refuses `search`,
`limit`, `cursor` and `offset` on those lists as unknown parameters and
answers `404` for `GET /v1/teams/{id}/members`, and MCP's three tools
ignore every argument again and `list_team_members` is an unknown tool, so
a caller that pages these lists or reads a team's members stops working
until the backend rolls forward. Code written for the older answers breaks
at once on the objects after the release, rather than reading a short list
without any error as with the workload. This sets no floor for the app,
which calls none of them. The lists read the name keys and team counts
every deployment holds since their backfills, so the release changes no
table, field or index and needs no step, and a list in name order answers
`this list cannot be read until this organization's names are ready; try
again in a few minutes` for an organization whose names are not ready.

From the release after v0.1.132, the app subscribes the workspace's task
windows (`workspace.tasks`) only when a page or action needs every task:
the Roadmap, Team sync, a create and the Inbox's search. The Board, the
phone's task list, the Overview, Search, task windows, task links and the
Inbox's rows read the server's own answers meanwhile, as they did before.
The release changes no server function, so it has no server change, no
release step and no rollback floor. An older app works against its
backend, and this app works against any backend from v0.1.127 on, the
relation pickers' floor, which the floors above already hold.

From the release after v0.1.133, a project's Settings page reads its
project, its rights, its Teams and Users lists, its Add team or user
picker, its Lead field and its invite form's lookup from
`projectSettings.get`, `users`, `teams`, `candidates`, `leadCandidates`
and `inviteTarget`, which v0.1.102 (PR #321, `584b3c07`) first shipped,
and sends each write with the values the page showed as its `expected`.
The release changes no server function, so it has no server change, no
release step and no new rollback floor. An older app works against its
backend, and this app works against any backend from v0.1.102 on, which
the removal window's floor (the release after v0.1.120) already holds.

Billing reads its usage from `billing.currentUsage` and its Storage by
project list from `billing.storageProjects`, once on opening and on each
Refresh and never subscribed, which the release after v0.1.134 first ships
together with the app that reads them (the release after v0.1.144 moves the
usage to `billing.usageFigures`, below). Current storage comes from the
stored-byte totals, files in Deleted items included, and Billing shows the
paid period's storage sample beside it. An app from that release, against
a backend before it, says on Billing that usage could not be refreshed,
also in a tab that was open when the backend went back, until the backend
rolls forward. From that release on, never return the backend to a commit
before it; roll forward instead. Returning the app alone to an earlier
release was safe while the backend kept `billing.usageReport`, which this
release kept with its scan for tabs loaded before it; the release after
v0.1.150 removed it, so it is on the Instant Rollback list above. The
period's storage sample scanned the attachment rows until the release after
v0.1.150, which reads the stored-byte totals and adds a daily job that
records them (below). There is no schema change, no backfill and no release
step.

From the release after v0.1.135, an app upload of an attachment or
description image outside the private demo goes through an upload ticket,
as REST and MCP uploads do. `files.uploadUrl` takes the file's `size` and
`name` and answers an upload URL on Qivo's API origin that stores one file
of that size, and `files.attach` takes only a file the same person's
unexpired ticket for that task stored. A person has at most 20 uploads in
progress in an organization over the app, REST and MCP together, and the
new hourly cron `reap-expired-upload-tickets` deletes expired tickets and
erases the files nothing names that they hold. A REST or MCP confirm sent
again after its answer was lost answers the attachment it made. App uploads
now run in Qivo's HTTP actions for the whole transfer, as REST, MCP and
demo uploads already did, instead of Convex's storage endpoint, so they
share Convex's limit on actions running at once with every other action.
The receiver reads a body for 5 minutes plus a second for every 32 KiB
declared, at most 8 minutes, which leaves the HTTP action time to store the
file within Convex's action time limit, so a 20 MiB file needs about
44 KB/s. Before this release a REST or MCP upload had 5 minutes whatever
its size. On the demo backend the shared upload budget falls from
50 MiB to 5 MiB, reserved at each upload's declared size. A demo above 5 MiB
keeps its files and admits no upload until enough is freed, and a stored
upload that never attaches stops counting within minutes. An attachment or
picture whose POST gets no answer frees its reservation at once through the
new `files.cancelDemoUpload`, which does nothing outside the demo.
`files.avatarUploadUrl` and `appearance.createUpload` take a `size` too,
which only the demo reserves. The app sends arguments an older backend
refuses, so from that release on never return the backend to a commit
before it; roll forward instead. Returning the app alone is safe, because an
app loaded before that release calls `files.uploadUrl` without a size and
gets a ticket that takes up to the organization's per-file limit, and on
the demo a reservation of the per-file limit or the free space, whichever is
smaller. A file uploaded through a Convex upload URL before the deploy and
attached after it is refused once, and the person uploads it again. A
monthly usage run that spans the deploy fails the organization whose Deleted
items it was reading, which its audit row counts in `failed` until the month
runs again. The release adds `attachment_uploads.up_to`, the index
`attachment_uploads.by_storage`, `demo_uploads.declared` and
`custom_backgrounds.preview_skipped` with its index `by_preview_skipped`,
the last two fields written only on the demo, where the minute sweep makes
a skipped preview once 1 MiB is free.
An older backend fails to deploy while a ticket row holds `up_to`, which goes
when it attaches or within an hour of its expiry, or while a demo row holds
`declared` or a demo background holds `preview_skipped`, which go with their
demo within a day. There is no backfill and no release step.

From the release after v0.1.136, **Settings → Projects → All projects**,
**Archived projects**, a project page's Sub-projects section and an
archived project's **Show sub-projects** read `projectSettings.projects`,
`subProjects`, `archived` and `archivedSubProjects`, which v0.1.129 (PR
#364, `e0a2d0b7`) first shipped, instead of the workspace, one
organization at a time and 25 a page, and a restore from Archived projects
sends the organization the page showed. That makes v0.1.129 the backend's
floor for this app. Against a backend before it, these pages say they
could not load the lists and offer Try again, never an empty list, also in
a tab that was open when the backend went back, until the backend rolls
forward. The upload tickets' floor above, the release after v0.1.135,
already holds it, so this release sets no new rollback floor; from it on,
as from that one, never return the backend to a commit before that
release, and roll forward instead. Returning the app alone to an earlier
release is safe, because that app lists the workspace's projects and the
backend keeps every function it calls. The release changes no server
function, so it has no server change and no release step. The New project
and New sub-project dialogs still read the workspace.

From the release after v0.1.137, the Milestones window opens a milestone
through `milestones.get`, and Team sync's opening reads its next milestone
and the milestones of this week and next through `milestones.section` and
`milestones.between`, which v0.1.97 (`92434062`) first shipped. The
release changes no server function, so it has no server change, no release
step and no new rollback floor. An older app works against its backend,
and this app works against any backend from v0.1.97 on, which the floors
above already hold. v0.1.103 (`fbcf0214`) made the reads refuse with
`access_unchecked` where a bound of the caller's own access reads stops a
check; against an earlier backend such a check fails as an error, which
the app shows as a failure with Retry, so it fails closed either way.

From the release after v0.1.138, the app's Team sync reads its meeting, its
people and their week's hours from `teamSync.agenda`, which v0.1.128
(`941d9d15`) first shipped, so it opens without loading every task, and
asks to choose a team or project instead of falling back to All projects.
It saves the scope the person picks under a new preference key,
`teamSyncScope`, so a scope an older app saved, which held its fallbacks to
All projects too, reads as nothing once. An app from this release against a
backend before v0.1.128 says on every Team sync scope that Team sync could
not be loaded, also in a tab that was open when the backend went back,
until the backend rolls forward. So this app needs a backend from v0.1.128
on. The upload floor above, v0.1.136 (`31f3e45f`), already holds that, so
this release sets no new floor. From it on, as from that one, never return
the backend to a commit before v0.1.136; roll forward instead. Returning the
app alone to an earlier release is safe against a later backend, because
that app derives the meeting from the workspace's tasks and asks for every
task first, and `teamSync.lastComments` keeps its arguments. Such an app
reads the older `syncScope` key, which this release no longer writes, so
it opens the scope it last saved. The release changes no server function
and needs no step.

From the release after v0.1.139, the app's Roadmap, the phone's agenda and
landscape timeline read which tasks they show from `tasks.roadmap` and their
dependency arrows and Auto-move from `tasks.roadmapDependencies`, which
v0.1.120 (`c9a0a748`) first shipped, and Team utilization and the planning
panel read people's loads from `planning.ownerLoads` with each span's
`project_id` and each owner's `paused` list, which v0.1.125 (`fdb4d232`)
first shipped. The Roadmap no longer asks for every task
(`workspace:tasks`), and the app no longer calls `planning.assigneeLoad`.
An app from this release, against a backend before v0.1.120, says on every
Roadmap that it could not be loaded, and against a backend before v0.1.125
shows every Team utilization cell and the planning panel's workload as
unknown, also in a tab that was open when the backend went back, until the
backend rolls forward. So this app needs a backend from v0.1.125
(`fdb4d232`) on. The upload floor above, v0.1.136 (`31f3e45f`), already
holds that, so this release sets no new floor. From it on, as from that
one, never return the backend to a commit before v0.1.136; roll forward
instead. Returning the
app alone to an earlier release is safe against a later backend, because
that app derives the Roadmap from the workspace's tasks, and
`planning.assigneeLoad`, which this release no longer calls, stays for it.
The release changes no server function and needs no step.

From the release after v0.1.140, `projects.create` takes `sort_order` as
optional, refuses one that is not a finite number and stores nothing, and,
when a create leaves it out, places the new project one past the largest
finite place among its siblings, archived and hidden ones included.
REST and MCP creates, which leave it out, take the same place, so a new
project goes after every sibling also where deletes, restores or earlier app
creates left gaps or ties in the places, where counting the siblings, as
before, could put it among them. The New project and New sub-project dialogs
of that release's app leave `sort_order` out, so that release is the
backend's floor for its app. An app from it, against a backend before it,
cannot create a project or a sub-project, also in a tab that was open when
the backend went back, until the backend rolls forward. That backend refuses
the create for the missing argument and stores nothing, so the app takes
its painted row away and says it couldn't create it, and never stores a
project in a wrong place. From that release on, never return the backend to
a commit before it; roll forward instead. Returning the app alone to an
earlier release is safe against a later backend, because that app sends
`sort_order` and the backend still stores it as sent. In place of the
workspace's roster, teams and projects, the dialogs read
`projectSettings.get`, `candidates` and `leadCandidates`, which v0.1.102
(PR #321, `584b3c07`) first shipped, and `projectSettings.projects` with
`sub_project_parents`, which v0.1.129 (PR #364, `e0a2d0b7`) first shipped,
and a sub-project's create goes to the organization its parent's check
named. There is no schema change, no backfill and no release step.

From the release after v0.1.141, `milestones.section` answers up to 100
milestones a call (`MILESTONE_READ_ROWS`), up from 25, and the app's
Milestones window lists a project's upcoming milestones and, once Past is
expanded, its past ones from it, 25 at first and 25 more for each Load more,
instead of the workspace's copy. An older app asks at most 25 and works
against this backend. An app from this release against an older backend
shows each section's first 25 and, at Load more, says it could not load
more, and a section that already showed more than 25 when the backend went
back keeps its rows and says it could not load the latest milestones, until
the backend rolls forward. So this app needs a backend from this release on,
which makes it the backend's rollback floor. From it on, never return the
backend to a commit before it; roll forward instead. Returning the app alone
to an earlier release is safe, because that app lists the workspace's
milestones and asks at most 25. The release has no schema change, no
backfill and no release step. Northstar's dataset becomes version 9 with
nine past milestones. A deployment whose Northstar is already seeded gets
them only at its next reset, and a seed refuses there until then. A seed of
an absent or empty demo writes version 9, and the public demo's new copies
have them.

From the release after v0.1.142, `pickers.taskOwners`, `pickers.syncRecipients`
and `pickers.canOwn` answer a task's owner pickers and Team sync's mention
recipients 25 at a time in name order, with a search, from the same rules as
the writes. `taskOwners` lists the people `issues.update` accepts as the
task's new assignee or reviewer, `syncRecipients` the active people, not
agents, who see the task and so hear a comment's mention of them, the caller
left out, and `canOwn` answers, for up to 100 ids, each person's row and
whether they could be chosen now. No app calls them yet, so that release
sets no rollback floor and needs no step, and returning the backend to a
commit before it stays safe until an app reads them. The release whose app
first calls them makes this release the backend's floor for that app, and
its own paragraph here says so. The lists answer `not_ready` for an
organization whose names are not ready. The release changes no table, field
or index, and there is no backfill.

From the release after v0.1.143, **Settings → Organization → Teams** lists
teams from `teams.settingsPage`, 25 at a time with a search, each with its
member count from `team_counts`, a team's page reads the team and the
caller's rights from `teams.get` and its members from `teams.members`, 25 at
a time with a search, and its **Add member** list reads `teams.addable` only
while it is open. That release first ships these four queries, so it is the
backend's floor for its app, a floor the ones above do not hold. An app from
it, against a backend before it, says on Settings › Teams and on every team's
page that it could not load them, also in a tab that was open when the
backend went back, until the backend rolls forward. From that release on,
never return the backend to a commit before it; roll forward instead.
Returning the app alone to an earlier release is safe, because that app
reads the workspace's teams and memberships, which the backend still sends.
The same release checks a team leader's right to set plannable hours against
at most 256 of the person's team memberships, in the app, REST `PATCH
/v1/users/{id}` and MCP `update_user`, and refuses a person in more teams
with its own sentence, which an older app shows as any refusal. The counts
read `team_counts`, which every deployment holds since
`internal/teamCountsBackfill` ran on 2026-10-28, and the lists read the name
keys every deployment holds, so there is no schema change, no backfill and
no release step.

From the release after v0.1.144, Billing reads its details from
`billing.details`, a live read that answers the counts without the account
names, its usage figures once on opening and on each Refresh from
`billing.usageFigures`, whose API calls come from the bucket's aggregates,
and its lists of API calls by account (`billing.apiAccounts`) and of
billable and non-billable accounts (`billing.accountList`) 25 at a time,
which that release first ships together with the app that reads them. An
app from that release, against a backend before it, shows Billing's load
error instead of the page, also in a tab that was open when the backend
went back, until the backend rolls forward. From that release on, never
return the backend to a commit before it; roll forward instead. Returning
the app alone to an earlier release was safe while the backend kept
`billing.summary` and `billing.currentUsage`, which this release kept
unchanged for tabs loaded before it; the release after v0.1.150 removed
them, so they are on the Instant Rollback list above. The operator console's
organization page reads `adminBilling.orgBilling`, which answers without
the account names from this release, and no console reads them. This
release becomes the backend's newest floor. There is no schema change, no
backfill and no release step.

From the release after v0.1.145, REST `GET /v1/tasks/{ref}`, the answers of
`POST /v1/tasks` and `PATCH /v1/tasks/{ref}`, and MCP `get_task` answer at
most 50 of each of `subtasks`, `links`, `followers` and `attachments`, each
with its cursor, `subtasks_next_cursor`, `links_next_cursor`,
`followers_next_cursor` and `attachments_next_cursor`, and REST `GET
/v1/tasks/{ref}/subtasks`, `/links`, `/followers` and `/attachments` and
the new MCP tool `list_task_related` page them. `has_more_subtasks` now
says that the subtask list goes on, and an archived group's subtasks page
to the end. Comment pages read only the profiles their comments name. A
task's details ask the caller's access project by project, for the
projects the task, its subtree and its links name, rather than for the
organization's every project. Returning the backend to a commit before it
makes task details answer every row again, without the cursors and with
`has_more_subtasks` as before, makes `GET /v1/tasks/{ref}/attachments`
answer an array and refuse `limit`, `cursor` and `offset` as unknown query
parameters, makes the three new routes answer `404` and makes
`list_task_related` an unknown tool, so a caller that pages these lists
stops working until the backend rolls forward. Code written for the older
answers keeps reading the arrays, and after the release reads only their
first 50 rows without any error, as with the workload; such code must
follow the cursors. Such a return drops the index `issues.by_parent_num`,
which the deploy forward builds again with no change to data. A caller far
past the sizes Qivo is built for, whose check of which projects they can
see stops at the fixed limits of one request, now gets that refusal (`Qivo
could not finish checking which projects you can see in one request`) on
task details, and on the answers of REST task creates and updates, whose
change is then not made, where the earlier reader answered. A task's
details naming a project on which one person holds two grant rows, which
only bad data holds, now fail with an internal error for that person,
where the earlier reader took the higher level for an archived task or
past 16 projects, as a member's task history already does. This sets no
floor for the app, which calls none of them, needs no step and has no
backfill.

From the release after v0.1.146, **Settings → Organization → Users** lists
its people, agents and guests from `people.settingsPage`, 25 a page with a
search, reads one person for the phone's page from `people.get`, reads an
agent's keys and the key lines from `tokens.agentKeys` once, never
subscribed, and its invitation labels from `invites.deliveries` with
`profile_ids`, and Organization › General's creators line reads
`orgs.projectCreators`. The release also adds `people.byIds`, which no page
reads yet, and the last-admin check reads only the organization's admins,
with the same sentences. That release first ships these reads, so it is the
backend's floor for its app, a new floor the floors above do not hold. An
app from it, against a backend before it, says on Users, on a user's page
and on the creators line that it could not load them, also in a tab that
was open when the backend went back, until the backend rolls forward. From
that release on, never return the backend to a commit before it; roll
forward instead. An app from before it reads `tokens.listAgentKeys`, which
the release after v0.1.158 removed, so it is on the Instant Rollback list
above. The release adds the index `agent_keys.by_profile_created`, through
which `tokens.agentKeys` reads an agent's newest keys by `created_at`, and which
Convex builds at deploy with no backfill. There is no other schema change
and no release step.

From the release after v0.1.147, the app's Inbox badge, on the desktop top
bar and the phone's bottom Inbox tab, counts unread tasks from
`inbox.summary`, and Mark all as read and Remove all read take their
availability from its seat flags, which v0.1.97 (`92434062`) first shipped.
The task window takes its **New** divider from `inbox.item` and marks a task
read through `messages.readItem` with the item's `through`, which v0.1.97
first shipped, and its tail note's change from the item's `unread_change`,
which counts an unread mention in the description since v0.1.123
(`a7239f99`). The window places the divider and sends the read only once
`inbox.item` answers ok and current. While the person's items are
building or `inbox.item` fails, it waits with no divider and no
read, and it runs a failed `inbox.item` once more by itself. An
app from this release, against a backend before v0.1.97,
shows **…** on the badge, draws no divider and marks no task read on
opening it, also in a tab that was open when the backend went back, until
the backend rolls forward. Against v0.1.97 to v0.1.122 its tail note under
Comments misses a mention in the description. So this app needs a backend
from v0.1.123 on. The floors above, the Milestones window's v0.1.142
(`cf03a6e4`) and the newer ones, already hold that, so this release sets no
new floor. From it on, as from them, never return the backend to a commit
before the newest floor above; roll forward instead. Returning the app alone to an earlier release is safe
against a later backend, because that app counts the loaded groups and
marks loaded messages read through `messages.markRead`, which stays until
the release after v0.1.161 removes both (its paragraph below). The
release changes no server function and needs no step. It is the first whose
app shows the inbox items' reads, which the inbox items paragraph below
lets reach a deployment only once the backfill reported complete there.
Every hosted deployment ran the backfill with v0.1.96, with clean second
dry runs, and the floors since v0.1.97 forbid returning a backend below
PR 299. This release's flow also reads a new read-only dry run on staging
and on production before it ships, which must report no rows that differ,
are missing or are extra.

From the release after v0.1.148, **Settings → Projects → Deleted items**
reads `deletedItems.page`, which v0.1.122 (`3a2da2ba`) first shipped, and
`deletedItems.roles`, `people` and `purgeSummary` with the page's `someone`
and kind-only `via`, which v0.1.131 (`c718c4e5`) first shipped, instead of
`deletedItems.list` and `matches`, and its **Projects** picker reads
`projectNav.page`, `children` and `search`, which v0.1.126 (`1228de4c`)
already holds. So this app needs a backend from v0.1.131 on. Against a
backend before v0.1.131 the page says it couldn't load deleted items when it
opens, as `deletedItems.roles` fails there, also in a tab that was open when
the backend went back. A page already showing keeps the roles it read, while
its people lists say they couldn't load people and **Delete now** says it
couldn't count the items deleted earlier, until the backend rolls forward.
The floors above, the release after v0.1.140's v0.1.141 (`e79e1db9`) and
the newer ones, already hold v0.1.131, so this release sets no new floor.
From it on, as from them, never return the backend to a commit before the
newest floor above; roll forward instead.
Returning the app alone to an earlier release was safe against a later
backend while `deletedItems.list`, `matches` and `item` stayed; the release
after v0.1.160 removed `list` and `matches`, so from it on the app alone
never goes below v0.1.149. The app now
sends a restore of more than 25 items of one organization, or of items in
more than two organizations, as several `deletedItems.restore` calls one
after another, and sends a deferred item again once its project is back,
each with the arguments earlier apps sent. The release changes no server
function, so it has no server change and no release step.

From the release after v0.1.149, the backend's HTTP router no longer loads
Better Auth when a request starts. It registers the `/api/auth/` routes with
the same paths, methods, CORS headers and trusted origins, and imports
`convex/auth.ts` only in the sign-in, OAuth token, registration and
revocation, and authorization server metadata handlers, so REST, MCP, the
file and image links, uploads, billing webhooks and demo reporting no longer
pay for it. A wrong `SITE_URL`, `ADDITIONAL_APP_ORIGINS`, `QIVO_ENVIRONMENT`
or demo setting now fails the routes that read it, the sign-in routes and
the CORS answers of the file and image links among them, rather than every
HTTP action. Every app and demo build now calls the sign-in route, and
outside the demo the OAuth token and metadata routes, after Convex pushes
the functions, and fails the build if one does not answer as expected. No
route's answer changes, so the release sets no floor of its own and needs no
step. Returning the backend to a commit before it, but never before the
newest floor above, only brings the load back. A failed check on staging or
production comes after the push, so that backend may run the new functions
while its domain keeps the earlier app.
[The auth routes check](#the-auth-routes-check) says what a failure means
and what to do. There is no schema change and no backfill.

From the release after v0.1.150, the storage sample at the start of a paid
period reads the organization's stored-byte totals in one step
(`billingSync:storageStep`), so it counts files in Deleted items as current
storage does, instead of scanning the attachment rows of live tasks. While
the organization's totals are not complete, as during a recount, the sample
waits and records nothing, never 0. A reconciliation starts it again once
15 minutes have passed since its start, stops it after 5 starts with a
`billing.storage_sample_failed` audit row, and starts it again 6 hours later
while its charge can still land, so such a period records no storage rather
than 0. Once a recount (`internal/storageTotalsBackfill` with `"recount":
true`) has ended, an operator can start a waiting or stopped sample at once
with `billingSync:restartStorage` and the period the audit row names, as
that function's docstring shows. Each sample records when it read the
totals in the new optional field `billing_periods.storage_sampled_at`. One
that waited or was started again measures them when it runs, files stored
meanwhile included, and Billing says it was "measured on" its date when
that was a day or more after the period's start, and "measured at the start
of this period" otherwise. Taking a late sample from the daily sample
nearest the period's start is later work. Billing is off on every hosted
deployment, so none should hold a paid period whose sample this release
could change, and every period that records storage starts after it.
Before publishing it, check that billing is still off on production or
that `billing_periods` holds no row without `storage_bytes`, since the
release would finish such a period's sample from the totals.

The release adds the hourly cron `storage-daily-samples`, at minute 20,
which records each counted organization's totals once a UTC day, 100
organizations a step, in `storage_daily_samples`, with each day's progress
and database work in `storage_sample_runs`. It skips an organization whose
totals are not complete or whose deletion has begun, writes at most one
sample per organization and day, keeps both tables 400 days and bills
nothing; daily storage billing stays off. A run that stalls resumes at the
first hourly call 15 minutes after its last step, so its remaining samples
come at most about 75 minutes late within its UTC day. A run still
unfinished when its day ends is not resumed, and its remaining
organizations have no sample that day. The demo deployment records none. A
recount makes the job skip the organization until it ends.

The release removes `billing.usageReport`, with its internal
`billing.usageHead` and `billing.storageNowPage`, and `billing.summary` and
`billing.currentUsage`, which v0.1.145 kept for tabs loaded before it, and
adds them to the Instant Rollback list above. An app from before v0.1.145,
also a tab that was open when this release deploys, shows Billing's error
in place of its details and usage until it reloads. An app from v0.1.145 up
to this release says a paid period's sample was measured at the start of the
period "without files in Deleted items", which a sample from this release
does not leave out and may have measured later; no paid period exists yet,
so nobody sees it. This release's app reads `sampled_storage_at`, which
`billing.usageFigures` answers from this release on, and an answer without
it reads as a sample measured at the start, so the app works against any
backend from the floor above.

The release adds two tables and the optional field
`billing_periods.storage_sampled_at`. While no period row holds that field,
Convex deploys a commit before it, keeps the new tables' rows and drops
their indexes, which the deploy forward builds again; a disposable local
backend showed both on 2026-11-06. That earlier code lists `billing_periods`
without the field, so it does not accept a row that holds it, and once a
finished sample has written one, a backend from before the release fails to
deploy. It would also sample a new paid period by the scan again, which
leaves out files in Deleted items, record no daily sample and leave the
samples of an organization it deletes behind. This release is therefore the
backend's newest floor. From it on, never return the backend to a commit
before it; roll forward instead. There is no backfill, since the totals keep
no history. Samples start with the first run after the deploy, and the days
the job does not run have none.

The owner decides on daily storage billing from what the job costs on
staging, a hosted read that needs the owner's approval:

```sh
"${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
  staging npx convex run storageSamples:costReport '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}'
```

It answers each day's run between the two UTC days, at most 62 days apart,
and the sums of their counters, and names no organization. For one day,
the calls are the 24 hourly ticks (`ticks` over `days_in_range`), the
steps (`counts.steps`, the organizations divided by 100, rounded down, plus
one) and the expiry steps (`counts.expiry_steps`, at least one). The reads
and writes of the steps and expiry steps are `documents_read`,
`documents_written`, `bytes_read`, `bytes_written` and `database_queries`,
as Convex measured them, the update of the run row that ends each one
included. The ticks are not in them. Add one indexed read of at most one
run row for each tick, one write of the run row for the tick that starts the
day's run, and one more read and write of it for each tick that resumed the
run (`restarts`). A run row is about 500 bytes. From the release after
v0.1.158, on a deployment with billing on, each tick also reads one index
range of at most one billing period, which is not in the counters either,
and the step that ends a run one more, which is; with billing off, as on
staging, neither runs, and there is nothing to add.
`database_queries` is Convex's own count, not the index ranges the code
opens; a local backend counted 7 before a transaction's first read.
Each sample written (`written`) is one row of about 230 bytes. The rows
retained are the samples the runs of the last 400 days wrote, which is
`written` summed over reports of at most 62 days each that cover those
days, or every `written` less every `expired` in reports kept since the job
began. Deleting an organization removes its samples without a counter, so
after a deletion both figures exceed the rows left. Divide by `orgs` for a
figure per organization and day. `revisions` counts the raises of the
organizations' totals revisions since their previous samples. An attach or
a removal of one file raises it once and writes three totals rows, the
task's, the project's and the organization's. A purge raises it once for
each file it deletes, with the same three writes, and a rename once, with
two. A move raises it once whatever it moves, and writes one row for each
task it moves with files, one for each project they leave, one for the
project they enter and the organization's, so `revisions` alone does not
bound the writes to the totals. It counts nothing for an organization's
first sample, for one recounted since its previous sample, or for a sample
a late run takes after the organization's sample of a later day, so each
raise counts once. A dry run of the storage totals backfill in the same
window gives the cost of a reconciliation.

From the release after v0.1.151, `pickers.mentions` answers the editor's @
mention popup 8 people of the editor's organization at a time in name
order, with the popup's match over names, initials and email, for any seat
of that organization. The task label picker reads `labels.picker` and the
window's labels the workspace does not hold `labels.byIds`, which v0.1.97
(PR #304, `81acac46`) first shipped. The app of that release reads
`pickers.mentions`, so that release is the backend's floor for its app.
An app from it, against a backend before it, says **Couldn't load
people.** in every mention popup, also in a tab that was open when the
backend went back, until the backend rolls forward; its label picker works
against any backend from v0.1.97. From that release on, never return the
backend to a commit before it; roll forward instead. Returning the app
alone to an earlier release is safe against a later backend, because that
app filters the workspace's roster and catalogue and the backend keeps
every function it calls. The reads answer `not_ready` for an organization
whose names are not ready, and the release changes no table, field or
index and has no backfill and no release step.

From the release after v0.1.152, an organization admin can download a ready
organization export from `/exports/<id>` through a link of two minutes that
`orgExport.claimDownload` answers, which also records one automatic attempt
for each admin who asked for the job. The route checks the admin's
authority again on every request and before the backend reads each part,
and streams the archive as one ZIP. At most two backend reads of an archive
run at once, and 16 on the whole public demo, with `429` past them. An
archive served whole sets only the job's `served_at`, which means the
backend read every byte into the response. On a local backend the runtime
read an 11 MB archive within a second, whatever the client took, so a
download the client abandons sets it too. The caps and the checks before
each part therefore cover the backend's reads, not the downloads clients
run. Because the backend cannot know that the client received the archive,
an archive the route served does not count as an export for the deletion
reminder. The route never writes `organizations.last_export_at`, so the
reminder still goes out, and the browser export's `recordExport` still sets
it as before. A later app stage records the download once the browser
confirms it finished. Archives are format 4, with the organization's
Deleted items under `deleted/`, and the export reads 100 tasks a page. No
app calls the link or the route yet. The release adds
optional fields to `org_exports` and `org_export_requests`, which code from
before it does not accept, so from the first export job or link after the
deploy, for as long as such a row stays (30 days after its job ends), never
return the backend to a commit before this release; roll forward instead.
It also adds `deleted_items.received_at`, which a restore writes on the item
it hands a subtask or a link to, so an export running then that reads the
item later calls it partial. The item keeps the field until it is restored
or deleted for good, and a rollback is refused while one does.
Returning the app alone, Vercel Instant Rollback included, is safe, because
no app calls the new functions. A job writes this release's step fields
when it ends a section after the deploy, or earlier when a read of a live
section finds a Deleted item that is not ready, so a rollback is refused
from then on; a job returned to the earlier backend before that finishes as
format 3.
A job collecting at the deploy goes on into the Deleted items section and
finishes as format 4. The release adds the index `org_exports.by_streaming`,
which Convex builds at deploy with no backfill, adds no table and needs no
backfill. The release whose app first calls `claimDownload` makes this
release that app's backend floor, and its own paragraph says so.

From the release after v0.1.153, `notifications.settings`, `setDelivery`,
`beat`, `end`, `claimAlerts` and `claimSummary` hold each login's
Notification delivery setting, its signed-in sessions, its delivery records
and its catch-up checkpoint, and the cron `notification record expiry`
deletes what has expired every 10 minutes. No app calls them yet, so that
release sets no rollback floor and needs no step, and returning the backend
to a commit before it stays safe until an app reads them. The release whose
app first calls them makes this release the backend's floor for that app,
and its own paragraph here says so. The release adds the tables
`account_notifications`, `notification_sessions` and
`notification_deliveries`, with no backfill. From it on, the session delete
trigger also deletes the session's notification row, a deleted login loses
its notification rows, and an organization export lists the three tables
among what it leaves out.

From the release after v0.1.154, the task window keeps about 150 comments
and changes of the open task loaded (`threadRows` in
`convex/lib/limits.ts`). It holds more only until it next lets rows go,
since the page it loaded last and the rows on screen stay. It lets go of
the rows farthest from where the person reads and reads them again
through `snapshot.commentsBefore` and `snapshot.historyBefore`, anchored at
ids the server answered for that task, which every backend from v0.1.98
(`c8691d3d`) answers as this app asks. The release changes no server
function, so it has no server change, no release step and no new rollback
floor. An older app works against its backend, and this app works against
any backend the floors above already hold. Returning the app alone to an
earlier release is safe.

From the release after v0.1.155, the sidebar's **All projects** and the
phone's **Projects** open the project directory, which lists the person's
projects from `projectNav.page` and `search` and a project's sub-projects
from `projectNav.children`, which v0.1.118 (`13f4bcba`) and v0.1.126
(`1228de4c`) first shipped, and stars a project with
`projectNav.setFavorite`, which v0.1.106 (`c786ca15`) first shipped,
instead of filtering the workspace's projects in the browser. Against a
backend before v0.1.126 the directory's search says it couldn't load your
projects, before v0.1.118 the whole directory says so, and before v0.1.106
a star fails, also in a tab that was open when the backend went back, until
the backend rolls forward. The floors above already hold v0.1.126, so this
release sets no new floor. From it on, as from them, never return the
backend to a commit before the newest floor above; roll forward instead.
Returning the app alone to an earlier release is safe, because that app's
directory lists the workspace's projects and its pickers keep listing the
stored favorites first, and the rows stay. The release adds the internal
module `internal/favoritesRepair`
([Recovery and compatibility](#recovery-and-compatibility), the favorites
paragraph), and has no schema change, no backfill and no release step.
Northstar's dataset becomes version 10, which stars a top-level project for
Nora, Leo, Daniel and Ben. A deployment whose Northstar is already seeded
gets them only at its next reset, and a seed refuses there until then, as
for every dataset change; a seed of an absent or empty demo writes version
10, and the public demo's new copies have them.

From the release after v0.1.156, `files.mintUrls` refuses a call that names
more than 100 attachments or more than 1,000 profile pictures, whole and
before its handler reads anything (only the membership check runs first),
and reads each task and each project's access once a call. The app of that
release asks for its file URLs through one queue, at most 100 ids a call and
two calls at a time, apart from its browser export, which still asks for
one file a call beside the queue. It loads description and comment images
as they come near view, and holds pictures and the background while the
page is hidden. It works against any backend. A backend from before the
release reads the access of each image's project on its own. For a task
stored on a top-level project it walks that project's live and archived
sub-projects for every image, up to about 146 index ranges an image at the
design size's 30 live and 40 archived sub-projects. A call of more than
about 28 such images can therefore pass that backend's 4,096-range limit,
and so can a half of 50. The app asks for each half of a failed call once
more. Each image of a half that also fails asks again 5 s later
(`INLINE_IMAGES.retry`) while it stays near view, in calls that split the
same way, and those images show late, a few at a time. So the release sets
no rollback floor and needs no step. Returning the app to an earlier
release stays safe, and so does returning the backend down to the
newest floor above. An app loaded before the release asks for one attachment
a call and works unchanged. It asks for every picture its workspace holds in
one call, which inside the design size is at most 1,000, and a tab whose
organizations together hold more pictures shows initials until it reloads.
The release changes no table, field or index, and there is no backfill.

From the release after v0.1.157, the Roadmap reads its milestone flags for
the weeks on screen from `milestones.between`, over the scope's top-level
project or, in My view, the top-level projects of its rows, instead of the
workspace's copy of every milestone, and My view draws each milestone on its
own project's row. `milestones.between` first shipped in v0.1.97
(`92434062`), and v0.1.103 (`fbcf0214`) made it refuse with
`access_unchecked` where a bound of the caller's own access reads stops a
check; against an earlier backend such a check fails as an error, which the
Roadmap shows with Retry, so it fails closed either way. So this app needs
a backend from v0.1.97 on, which the floors above already hold. The release
changes no server function, sets no new rollback floor and needs no release
step. Returning the app alone to an earlier release is safe, because that
app reads the workspace's milestones, which the backend still sends. There
is no schema change and no backfill.

From the release after v0.1.158, a paid period can be charged for storage
on the average of its organization's daily storage samples instead of the
sample at its start. The Convex variable `DAILY_STORAGE_BILLING` switches
it on when it is exactly `true`, and it is unset on every deployment until
the owner decides from the staging reading. While it is unset nothing
bills differently. Every period is sampled at its start as before, and the
only new work, while billing is on, is one index range in each hourly call
of `storage-daily-samples` and one in the step that ends each day's run,
each finding no period; with billing off, as on every hosted deployment
now, neither reads anything. The variable is read only when a paid period
is recorded, so setting it acts at each organization's next renewal, and
removing it makes later periods sampled at their start again while a daily
period already open stays daily.

A period recorded while it is set holds `storage_basis: 'daily'`, takes no
sample at its start, and is recorded once. Its days are the UTC dates from
its start's date to the day before its end's date. The run of its last day
records it when that day has the organization's sample, normally about a
day or more before the end. When that day has none, the next day's run
records it from its own sample. Until two hours before the end a period is
recorded only once the run of each of its days without a sample has no
row, has finished or has taken no step for 15 minutes, so none can still
write that day's sample. The record stops such a stalled run in the same
transaction, so the run writes no sample of its day afterwards. At the
latest the first hourly call within two hours of the end records it. A day
still without a sample then takes the next reading after it, the next
period's first day included, or else the most recent one before it, an
earlier period's included. Every later run and call tries a period that is
still open, for up to 3 days after its end, then stops with an error log
and a `billing.storage_finalize_stopped` audit row, and
`billingSync:finalizeStorage` with the period and `"operator":true` records
it by the same rules and writes a `billing.storage_finalize_requested`
audit row, as that function's docstring shows. The average, rounded up to a
whole byte, goes through the same allowance, blocks and single charge as a
sample. With no sample of the organization at all the period records no
storage charge and a `billing.storage_unavailable` audit row, never 0. A
subscription that ends or is revoked before the period's recorded end stops
that period's storage charge only while the charge has not been delivered,
since its delivery stops at the end. A charge delivered before the
subscription ended stays, as the charge of a sample at the start, sent
minutes after the start, always did. `billing.usageFigures` answers the
basis and the average, which this release's app shows only for a daily
period, with how many days were estimated. Switching it on also changes
what the pricing page and the administration and organization guides say
about storage, so a docs change goes out before or with it; qivo-internal
`docs/billing-operations.md` keeps the texts.

The release adds the optional fields `storage_basis`, `storage_days`,
`storage_unavailable` and `storage_finalized_at` and the index
`by_storage_open` to `billing_periods`, no table and no backfill. While no
row holds the new fields, a commit before the release deploys, and Convex
drops the index, which the deploy forward builds again. Once the switch is
set and a daily period is recorded, a backend before the release does not
deploy, since its schema validation refuses the period row for the field
`storage_basis`, and that code would also sample the period at its start. A
disposable local backend showed both on 2026-11-07. So from the first daily
period on never return the backend to a commit before this release; roll
forward instead. Until then the floors above stand, and the release sets
none. For the owner's cost reading, each daily period costs one
`billingSync:finalizeStorage` call when it is recorded, reading its period
row, its days' samples (at most 31), until two hours before the end the
run row of each day without a sample in an index range of its own, and a
few documents more, 37 documents and 8 index ranges for 31 days with the
last one missing at 1,000 people in `convex/tests/billing.test.ts`, and
writing the period and its charge, plus one more read and a write of the
run row of each stalled run the record fences, one more call each time a
day's run finds it waiting, and one
`billingSync:finalizeDue` call for each 25 periods a run or call lists. A
period stopped after 3 days costs one write of its row and one audit row.
`billing.usageFigures` reads at most 31 more documents for an admin of an
open daily period.

Switching daily storage billing on is the owner's decision, never a stage's.
First ship the docs change above. Then accept one daily period in the Polar
sandbox, its storage charge sent between about an hour and two days before
the period's end and landing on that period's closing invoice, as the
limits plan requires before daily billing is enabled. Then, with the
owner's approval, set the variable on production:

```sh
"${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
  production npx convex env set DAILY_STORAGE_BILLING true
```

Periods recorded afterwards are daily, and periods already open keep their
basis. From the first daily period on, this release is the backend's floor.
Removing the variable makes later periods sampled at their start again and
leaves open daily periods daily.

From the release after v0.1.158, **Settings → Your preferences → MCP
access** lists its connected apps from `connectedApps.list` and its personal
access tokens from `tokens.personalTokens`, 25 at a time each, newest first,
each with a search and **Load more**, read once on opening and again from
the first batch after a change in that list, never subscribed. That release
first ships these reads, so it is the backend's floor for its app, a new
floor the floors above do not hold. From that release on, never return the
backend to a commit before it; roll forward instead. The release removes
`oauthConnections.list` and `tokens.listMcpTokens`, so an app from before it
cannot list MCP access against this backend. It also removes
`tokens.listAgentKeys`, so an app from before v0.1.147 shows wrong key lines
on Users. Both apps are on the Instant Rollback list above. The release adds
the index `mcp_tokens.by_profile_created`, which Convex builds at deploy
with no backfill. There is no other schema change and no release step.

From the release after v0.1.158, the sidebar's project tree lists the
person's top-level projects from `projectNav.page` and the scope's
sub-projects from `projectNav.children`, which v0.1.118 (`13f4bcba`) first
shipped, instead of the workspace's projects. The floors above already hold
v0.1.118, so the release sets no new floor. The release changes no server
function, and has no schema change, no backfill and no release step.
Returning the app alone to an earlier release is safe. The staging check's
step `ui/sidebar-projects` checks the tree on the deployment's reads, so it
needs a backend from v0.1.118 on.

From the release after v0.1.158, `milestones.section` takes `mine: true`,
which reads My view's milestones from the top-level projects that hold the
caller's own tasks, and the Overview's Milestones section and the phone
Roadmap's agenda read their sections from `milestones.section` with their
sizes as arguments, My view with `mine`. This app's My view milestones need
this backend, so the release is the backend's newest rollback floor. From
it on, never return the backend to a commit before it; roll forward
instead. Returning the app alone to an earlier release is safe, because that
app reads the workspace's milestones, which the projects part still sends.
The staging check's `ui/overview-milestones` step checks on staging that a
project's Overview and My view's read their milestones from
`milestones.section`, My view with `mine`. The release changes no table,
field or index and has no backfill.

From the release after v0.1.158, the Inbox lists its tasks from
`inbox.page`, 50 a page with Previous and Next, which v0.1.123 (`a7239f99`)
first shipped, and a row's actions send `messages.readItem`, `unreadItem`,
`removeItem` and `snoozeItem`, which v0.1.97 (`92434062`) first shipped,
instead of reading the workspace inbox part's messages and sending their
ids. So the Inbox reaches every task with messages, and its search asks the
server and loads no task. This makes v0.1.123 the backend's floor for this
app, which the floors above already hold, so the release sets no new
rollback floor. Against a backend before v0.1.123 the Inbox says it
couldn't load your messages, also in a tab that was open when the backend
went back, until the backend rolls forward. The workspace inbox part stayed
for the desktop alerts until the release after v0.1.161 removed it. The list
shows only what the `inbox_items` rows
hold. The release changes no server function, has no schema change, no
backfill and no release step.

From the release after v0.1.158, a create of a task no longer loads every
task. The release changes no server function, so it sets no new rollback
floor and needs no release step. The app relies on `issues.create`
answering the stored row, which it has since v0.1.6 (`ce4cf109e`), and on
`issues.createParent` answering the new parent's number (`parent_num`),
which it has since v0.1.26 (`1dfbf802b`), and the floors above already
hold far newer backends. The staging check's `ui/create-answer` step
checks the create on the deployment. There is no schema change and no
backfill.

From the release after v0.1.158, the task window's **Assignee** and
**Reviewer**, the owner lists of the Board, the Roadmap, My view and Team
sync, and Team sync's Mention window read their people from
`pickers.taskOwners`, `pickers.syncRecipients` and `pickers.canOwn`, which
v0.1.143 (`4d2720c2`) first shipped, once a batch while they are open, and
name a holder the workspace does not hold from `people.byIds`, which
v0.1.147 (`cd7ff803`) first shipped, instead of the workspace's roster. So
v0.1.143 is the backend floor of this app's pickers and v0.1.147 of its
names; the floors above already hold both, so the release sets no new
floor. Against a backend before v0.1.143, every owner list says "Couldn't
load people." and the Mention window lists no one and posts nothing, also
in a tab that was open when the backend went back, until the backend rolls
forward. Returning the app alone to an earlier release is safe, because
that app reads the workspace's roster, which the backend still sends. The
release changes no server function, has no schema change, no backfill and
no release step.

From the release after v0.1.159, the workspace's projects part
(`workspace.projects`) answers each window's projects with their grants and
team grants, and reads and sends no milestone. The app reads every
milestone it shows through `milestones.get`, `section` and `between`, which
the floors above already hold, the `mine` scope included, and it ignores a
milestones list an earlier backend still sends, so this release sets no new
floor for the backend, and returning the backend to a commit before it,
down to the newest floor above, stays safe for this app. An app from before
this release joins the milestones of every projects part it reads and
cannot load its workspace against a backend from this release on, also in a
tab that was open when the release deploys, until it reloads. So this
release is the app's rollback floor. From it on, never return the app or
the demo alone to a deployment of a commit before it; return the backend
with it, or roll forward (see Rollback and hotfixes). The staging check's
`ui/roadmap-milestones` step moves the run's milestone through a flag's
store write, which takes its row from the Roadmap's range read and its
organization from the store's project, and checks over REST that the
backend saved the move. The release changes no table, field or index, and
has no backfill and no release step.

From the release after v0.1.159, organization admin status gives no access
to project work, so this release is the backend's floor. A backend returned
below it gives organization admins every project again, which widens
access, so roll forward instead. The release sets no app floor and changes
no table, field or index, with no backfill and no release step.

From the release after v0.1.159, the app opens the project the person
opened last after `projectNav.resolve` says they may, else a project
chooser on the navigation reads (`projectNav.page`, `children` and
`search`), and the All projects directory, the sidebar's tree and Search
open a project the workspace does not hold, and a project address, through
`projectNav.resolve`. The reads first shipped in v0.1.118 (`13f4bcba`) and,
for `search`, v0.1.126 (`1228de4c`), which the floors above already hold, so
the release sets no new floor. It changes no server function and has no
schema change, no backfill and no release step. The staging check's step
`ui/startup-selection` checks it on the deployment's reads, so it needs a
backend from v0.1.126 on.

From the release after v0.1.159, the app asks for pictures only for the
signed-in person's own seats and the people its open pages, pickers and
views show, names and paints a person
the workspace does not hold from `people.byIds` through a bounded profile
cache, sends the writes of Settings › Users, a team's page, Settings ›
Teams and Settings › Labels with the values the page showed, whether or
not the workspace holds the person, team or label, checks a new label's
name on `labels.picker`'s `exact` and picks its color from the label's id.
`people.byIds` now answers `avatar`, `sample_avatar` and `plannable_hours`
beside each person's face, which the workspace's people part already sends
every seat. The app reads `people.byIds`, which v0.1.147 (`cd7ff803`)
first shipped, and `exact`, which v0.1.97 (`92434062`) first shipped, and
while the people part sends every profile it reads `people.byIds` only
for references to people who were removed, so the floors above already
hold this app and the release sets no new rollback floor. There is no
schema change, no backfill and no release step.

From the release after v0.1.160, the app opens a numbered project page the
workspace does not hold through `projectSettings.get` by organization and
number, which that release first takes, so its app needs a backend from that
release on; never return the backend below it, roll forward instead. The
release removes `deletedItems.list` and `matches`, which no app from v0.1.149
on reads, so never return the app alone below v0.1.149. It drops the
`search_title` index of `deleted_tasks`, which Convex builds again for an
earlier backend, and has no schema field change, no backfill and no release
step.

From the release after v0.1.160, the app reads the signed-in person's own
profiles, team memberships and teams from `workspace.root`, Team sync's
teams from `teams.picker`, the follower list's people from
`issues.subscribers` and `pickers.taskFollowers`, and every other person,
team and label from the reads that name them, instead of the workspace's
people and catalog parts, which the release removes (`workspace.people`
and `workspace.catalog`). The release first ships `teams.picker`,
`pickers.taskFollowers` and the root's own rows, so it is the backend's
floor for its app, and its backend serves no app before it: that app
subscribes the removed parts and fails to load, also in a tab that was
open when the release deploys, until it reloads. From it on, never return
the backend to a commit before it, and never return the app or the demo
alone to a release before it; roll forward instead. Every earlier
statement here that returning the app alone to an earlier release is safe
holds only against a backend from before this release. There is no schema
change, no backfill and no release step.

From the release after v0.1.161, REST `GET /v1/projects` and MCP
`list_projects` answer one page of projects at a time as `{next_cursor,
projects}`, each top-level project by key followed by its sub-projects by
key, and take `search`, `limit`, `cursor` and `offset`, and the REST and
MCP project reads and the answers of project creates and updates read the
named project and the caller's access to it instead of every project of
the organization. REST `GET /v1/projects/{ref}`, the answers of project
creates and updates, and MCP `get_project`, `create_project` and
`update_project` answer at most 50 of a project's milestones, user grants
and team grants, each with its cursor, and REST `GET
/v1/projects/{ref}/users`, `/milestones`, `/access/users` and
`/access/teams` and MCP `list_project_users` and the new
`list_project_related` page them. REST `GET /v1/inbox` and MCP
`list_inbox` answer one page of inbox items at a time as `{next_cursor,
items}`, newest activity first, take `cursor`, refuse an `offset` other
than `0` and no longer answer `truncated`, each item with every message it
holds, and a change with `all` asks the caller's access project by project.
This release is the backend floor for REST and MCP callers that page these
lists. Returning the backend below it makes both project lists answer every
project as one array in key order, the project details every milestone and
grant without the cursors, the project users every row at once and the
Inbox `{items, truncated}` paged with `offset`, refuses the new arguments
as unknown, answers `404` for the three new routes, does not know
`list_project_related`, and drops the indexes
`projects.by_org_parent_state_key` and `project_reach.by_grantee_root_key`,
which a deploy forward builds again with no change to data. It sets no
floor for the app, which calls none of them, and has no backfill and no
release step.

From the release after v0.1.161, the app reads `projectNav.byIds`, new in
that release, for every project its views, dialogs and pages name, as the
workspace holds no project, so that release is the backend's floor for its app.
From it on, never return the backend to a commit before it; roll forward
instead. The same release adds `projectNav.targets`, with `parent_id` for
the sub-projects under one top-level project, and `projectNav.holds`,
lets `projectNav.page` take `org_id` and `team_id`, adds `lead_id` and
`review_hours` to `projectNav.byIds` rows and `project_archived` to
`taskWindow.task`'s archived answer, none of which an app before it reads.
These navigation reads add no table, field or index, and need no backfill
and no release step.

From the release after v0.1.161, the app raises its desktop notifications
from `inbox.feed`, which that release first ships, a small read of the
person's newest unread Inbox events under ordinary access, instead of the
workspace inbox part, and asks `notifications.beat`, `claimAlerts` and
`claimSummary`, which v0.1.154 (`2898c8c8`) first shipped, which session
shows each one; after a sleep or a lost connection it shows one
notification that new unread activity arrived. In the same release one tab
of each browser profile leads its desktop notifications and calls
`notifications.beat`, with real `active` reports, and `end`, and
**Settings → Your preferences → Notifications** reads
`notifications.settings` and calls `setDelivery`, all first shipped in
v0.1.154. The release removes the workspace inbox part
(`workspace.inbox`), and `messages.markRead`, `markUnread`, `remove` and
`snooze`. So it is the backend's floor for its app's desktop
notifications. Against an earlier backend the app loses only
its feed, a side whose failure holds nothing else, so it shows no desktop
notification. Its backend serves no app before it, whose workspace needs
the removed part and fails to load as a whole. From it on, never return
the backend to a commit before it, and never return the app alone to a
release before it; roll forward instead. There is no schema change, no
backfill and no release step.

From the release after v0.1.161, the app holds no project. It reads every
project it shows from the navigation reads, `projectNav.byIds`,
`projectNav.targets`, `projectNav.holds` and the views' own reads, and the
release removes `workspace.projects` and the root part's `live_projects`
and `next_project_num`. Every earlier app subscribes the removed part at
boot, so this release is the app floor that "Rollback and hotfixes" names.
The backend floor for these reads is the one the paragraph on
`projectNav.byIds` above sets. The staging check's `ui/projects-part`
step boots the run's project's Board and checks that no frame subscribes
`workspace.projects` and that `projectNav.byIds` reads the project, that the
Board's **New task** dialog lists the project's two sub-projects from
`projectNav.targets` and that Team sync's scope menu offers the project from
`projectNav.page` with the home organization, each found by the run's tag,
and writes nothing. The release changes no table, field or index, and needs
no backfill and no release step.

From the release after v0.1.161, the app subscribes no task window and holds
no task. Every view and the task window show what their own reads answer,
and every delay a card, a Roadmap bar or the task window shows comes from
`planning.ownerLoads`. The release removes `workspace.tasks` with its reader
and its hidden load rows, the root part's `active_tasks`, and the five
indexes only that part read: `issues.by_org_archived_window`,
`by_org_task_archived_key` on `issue_links`, `issue_labels` and
`issue_attachments`, and `issue_subscriptions.by_profile_task_archived_key`.
It keeps the `window_key` and `task_key` fields and their writers, so it
changes no stored row, and a backend rollback builds the indexes again at
its deploy. No page or action of the app from the release after v0.1.161
subscribes `workspace.tasks`, so the app floor stays the one "Rollback and
hotfixes" names. The staging check's `ui/own-reads` step, which replaces
`ui/tasks-on-demand`, opens the run's project's Board, a fixture task's
address and the project's Roadmap in fresh loads and checks that each shows
its tasks from its own read. The same release stops a hidden or minimized
tab's or window's reads of an open task (its thread, history, task, links,
attachments and inbox item), the subscriber list, Billing's details and
Organization › General's export and deletion state, and reads them again
when it shows, so news that arrived meanwhile stays unread until then.
Settings › Appearance's own watch of `appearance.get` is removed, not paused,
since the page shows the value the app already reads. This changes no server
function and reads no new query, so it sets no new floor. Its staging check
step `ui/hidden-task-window` mentions Nora on t0 while the page is hidden
and removes that notification again. The desktop shell now reports a window
started hidden at login as hidden until it is first shown, which reaches
people only with a new desktop build. The same release prepares
**Settings → Organization → General → Export data** with the server job
(`orgExport.request`, `status` and `cancel`) and saves its archive through
`orgExport.claimDownload` and the `/exports/` route instead of building a
ZIP in the tab, and removes `orgExport.page`. The route now exposes
`Retry-After` to the app's origins and answers its refusals as attachments
with no body, so a link loaded as a page never replaces the page that
asked. Browsers without a file picker download the link in a hidden frame
of the page. Only a save the desktop app or the browser confirms calls
`orgRemovals.recordExport`, which now takes the export's id and records
only a served archive of that organization that is ready or ended less
than 30 minutes before. It records the save in the new optional field
`organizations.last_export_confirmed_at`, which the export section, the
Delete organization and Cancel subscription questions,
`orgRemovals.state`, Billing's details and the deletion reminder now read
alone. Until this release the browser export set `last_export_at` when its
download started, so an export recorded before this release does not count
as a confirmed save, and the reminder goes out for it. Nothing writes or
reads `last_export_at` any more. Code from before this release does not
accept an organizations row that holds `last_export_confirmed_at`, so once
a save is recorded a backend from before this release fails to deploy; it
is a rollback floor anyway (see Rollback and hotfixes). The field needs no
backfill. The app needs a backend from v0.1.153 (`b4dc7775`) on for its
export, which first shipped `claimDownload` and the route, and the floors
above already hold it. Against a backend from v0.1.153 to before this
release the archive downloads but its record is refused, and the app shows
no confirmed save, so the deletion reminder still goes out. The release
needs no backfill and no release step.

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
rollback floor (see Rollback and hotfixes). Later changes keep the rule,
with one exception. By the owner's decision of 7 November 2026, while
nobody uses the app, a change removes an old function, part or answer field
in the same release that stops using it, as the release after v0.1.159
removes the milestones of the workspace projects part and the release after
v0.1.160 the workspace's people and catalog parts, and its deployment
paragraph names only the floor a later rollback needs.
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
when it stores the row, and each task's relation rows carry its key as
`task_key`. The release that replaced `snapshot.forMe` with the workspace
parts added the fields, and until the release after v0.1.161 a task's key
placed it in the app's task windows of the workspace. From the release
after v0.1.161 the app subscribes no task window and holds no task or
project, so a key places nothing in the app and no read uses one, though
the server still gives every new task and project a key, its relation
rows the task's, and a restore from Deleted items gives a copy stored
before keys one as it writes it back. A task stored before the fields has
no key until the one-time `internal/windowKeysBackfill` gives it one,
which now changes nothing anyone sees, so the backfill needs no run on a
deployment that serves the release after v0.1.161 or later. Earlier
releases do not accept the fields, so a rollback past the release that
added them fails to deploy; it is a rollback floor anyway (see Rollback
and hotfixes).

Each organization's `org_counters` row counts its active tasks and its
live projects (`active_tasks`, `live_projects`). Until the release after
v0.1.161 `active_tasks` sized the app's task windows. From the release
after v0.1.161 the app subscribes no task window and holds no project, so
both counts serve only the organization's usage figures in the operator
console (`convex/model/usage.ts`), which show no count while an
organization is not counted. Every write that adds, archives, restores or
deletes a task or project keeps the counts, and a new organization starts
at zero. An organization created before the release that added them has
none until the one-time `internal/liveCountsBackfill` counts it. Run the
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
counts in a row of its own and never changes another's. From the release
after v0.1.134, Billing's current storage and its Storage by project list
read the totals (`billing.currentUsage` and `billing.storageProjects`), and
from the release after v0.1.144 its current storage reads them through
`billing.usageFigures`.
From the release after v0.1.150 the storage sample at the start of a paid
period reads them too, and a daily job records them; until then that sample
and the legacy `billing.usageReport` scanned the attachment rows. A new
organization starts counted at zero. An
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
lists show them. Settings › Labels shows each label's row as its active
tasks, and the REST and MCP team answers show each team's row as
`member_count`, null for a team without a finished row, from the release
that pages the people, label and team lists.
Every write that changes either keeps the rows, and labels and teams created
since the release that added them start with one. A label or team stored
before has no row until the one-time `internal/labelCountsBackfill` and
`internal/teamCountsBackfill` count it, and a reader shows such a count as
unavailable, never as zero. Run both on every hosted deployment once it serves that release,
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

Each sub-project has `overview_counts` rows with its leaf tasks by status,
its paused leaves and the remaining hours of its leaves not Done, beside a
row for each person with leaves in it, and each active task an
`overview_tasks` row with what those rows hold for it
(`convex/model/overviewCounts.ts`). The Overview's server queries
(`convex/overview.ts`), which the app's Overview calls, read the
`overview_counts` rows. Every task write keeps them, background steps keep
them after a project is archived, restored, moved to Deleted items or
restored from there, and organizations created since the release that
added them are counted from their creation.
An organization stored before has no counts until the one-time
`internal/overviewCountsBackfill` counts it, and the readers answer that its
counts are not ready, never zero. Run it on every hosted deployment once it
serves that release, as the module's header says. Read the dry run first,
then run it, calling again with the answered `cursor` until it answers
`done`. A dry run lists the organizations a run would count, any stored row
that the tasks do not give or that went below zero, any count or regroup
under way, and the rows left without their organization, project or task.
`"recount": true` mends the differing rows.

Earlier releases do not accept the `org_ready` field `overview_counts_at`,
and every new organization and every counted one holds it, so the release
that added the counts is a rollback floor for the backend as soon as it
deploys (see Rollback and hotfixes). Roll forward instead. An earlier
release would also move none of these counts. If counts drift for another
reason, a dry run lists them as differing: run the backfill with
`"recount": true`, calling again with each answered `cursor` until it
answers `done`. A recount deletes each organization's rows and counts its
tasks again, and the readers answer that its counts are not ready until it
ends.

Every inbox item, a person's messages about one task, has an `inbox_items`
row that every message write keeps in step, and each person an
`inbox_state` row that says whether their rows are complete.
`convex/inbox.ts` reads the rows for the capped unread summary, one task's
item and the Inbox's pages of task groups, and answers that a person's Inbox
is not ready while their `inbox_state` is not built, which a page says by
naming the organization in `not_ready`. Since the release after v0.1.147
the app's badge, its Mark all as read and Remove all read and its task
window read the summary and the item, and since the release after
v0.1.158 its Inbox list reads the pages. REST and MCP still read the
messages. A person whose messages were stored before the
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
reads them, and from the release after v0.1.144 so do Billing's **API
calls** and **API calls by account**. Until both backfills report nothing
left, API access says it is not ready to list credentials, a calendar
month whose rows are not all ranked shows its total as not available yet,
and Billing shows such a bucket's calls and accounts as being counted. Run both backfills on every
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

Organization exports run as a server job (`convex/orgExport.ts`), which
**Settings → Organization → General → Export data** starts; the browser
export and its read, `orgExport.page`, are gone. A job keeps its state in `org_exports`, one row per admin
who asked for it in `org_export_requests`, and its archive as compressed
parts in storage, one `org_export_parts` row per part. The archive is
format 4: the live tables under `data/`, then the organization's retained
Deleted items under `deleted/`, each item marked complete or partial. Any
active admin downloads a ready archive from the `/exports/` route through a
two-minute link that `orgExport.claimDownload` answers, which the export
page uses at once: the desktop app downloads it into the Downloads folder, a
browser with the File System Access API streams it into a file the person
chose, and other browsers download it themselves. The route checks the
admin on every request, takes a lease on the job row, and records an
archive it served whole in the job's `served_at`. On a local backend the
runtime read the archive into the response as fast as storage gave it,
whatever the client took, so the lease and the checks before each part and
of each part's size cover the backend's read, not the client's transfer,
and `served_at` means the backend read the whole archive, not that the
client received it. A served archive does not count as an export for the
deletion reminder by itself. Only `orgRemovals.recordExport` writes
`organizations.last_export_confirmed_at`, which the reminder reads, and
which the app calls once the desktop app or the browser confirmed a saved
file of exactly the archive's bytes. It records only a served archive of
that organization that is ready or ended less than 30 minutes before. Other
browsers' downloads record nothing, so the reminder still goes out after
them. The older `organizations.last_export_at`, which earlier releases set
when a browser download started, is no longer written or read.
A ready archive whose file is gone fails as incomplete. A ready archive stays
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
empty and need no backfill.

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

A rollback past the release of the download route and format 4 is refused
by Convex once a job row holds `served_at`, a lease or the step's Deleted
items state, or a request row holds `auto_download_at`, which the first job
after the deploy writes; such rows stay until 30 days after their job ends,
so roll forward instead. It is refused too once a Deleted item holds
`received_at`, which a restore writes when it hands a subtask or a link to
another item, until that item is restored or deleted for good. A job
writes this release's step fields when it ends a section after the deploy,
or earlier when a read of a live section finds a Deleted item that is not
ready, so a rollback is refused from then on; a job returned to the earlier
backend before that finishes as format 3.
Returning the app alone changes nothing, because no app calls the link or
the route.

Each seat's favorite top-level projects are rows in `project_favorites`,
which the app writes only through `projectNav:setFavorite`, the call of the
All projects directory's star from the release after v0.1.155; the
Northstar seed inserts its people's stars from dataset version 10
(`model/projectFavorites.ts` `insertSeededFavorite`), and
`internal/favoritesRepair` deletes and patches what a rollback left. The
table starts empty and needs no backfill. A rename, archive or restore of a
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
among its own, of projects it sees anyway. After rolling forward past a
rollback before the favorites release (v0.1.106), run
`internal/favoritesRepair:run` with `dry_run` true and then false, which
reports and then deletes those rows and brings the stale copies in line,
and leaves the rows of a project in Deleted items, a seat that lost access,
a seat being removed and an organization being deleted; its header gives
the commands. Each hosted run needs the owner's approval, and a repair on
production a verified backup first. A Northstar reset under the earlier
code keeps its seats and recreates its projects with the same ids and
names, so its seats' earlier stars would show again, and the repair cannot
tell them from real ones; reset Northstar once more after the roll forward.

Each login's Notification delivery setting and catch-up checkpoint are rows
in `account_notifications`, its signed-in sessions are rows in
`notification_sessions`, and the alerts granted are rows in
`notification_deliveries`, which only `notifications.ts` writes; no app
calls it yet. The tables start empty and need no backfill. A session's row
goes with its Better Auth session in the session delete trigger, a login's
rows with the login (`notifications:forgetLogin`) and the demo's in its
cleanup, and the cron `notification record expiry` deletes records 15
minutes old and session rows not beaten for 8 days. A rollback past the
release that added the tables deploys, because Convex leaves the rows of
tables the schema does not list alone, but the earlier code deletes no
session row at sign-out, a ban or expiry, and no row of a deleted login.
After rolling forward the cron deletes the session rows not beaten for 8
days and the records expire within 15 minutes. What stays is the account
row of a login deleted meanwhile, or deleted outside Better Auth's API and
the console, such as by a raw component delete, which names a login id
Better Auth never gives again and which nothing reads.

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
