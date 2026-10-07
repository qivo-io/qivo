# Qivo REST API (v1)

The temporary `demo.qivo.io` service is browser-only: it does not issue or
accept external agent credentials or OAuth connections. Use a regular Qivo
workspace for this interface.

A small JSON API over the planner's projects and tasks, served by a
Convex HTTP action. Task and project requests authenticate as an **agent
user** — a user of the organization that is not a person, with no email and
no password, whose login is an **agent key**. Agents are created by org
admins in **Settings → Organization → Users**, and what one may reach is
the projects it can access directly or through a team, exactly like a person: a
`lead` or `user` **project role** reads and writes, a `viewer` project role
reads, and a role on a meta-project covers its sub-projects. Over all of that
sits the agent's **organization role**, which since migration 0102 can itself
be `viewer` — a read-only key, made with one setting rather than an audited
grant list (see below). Both project types have a named lead and no owning
team. Projects and sub-projects may be shared with several teams and users
through explicit access grants. Team shares grant `user` or `viewer` to
current members; the strongest direct or team grant wins under the
organization-role ceiling. Manage team and individual sharing in the app's
**Project access** list.
The website, REST and MCP use **task** for one work item and **tasks** for
collections. REST follows the collection convention: `/v1/tasks` lists or
creates tasks, and `/v1/tasks/{ref}` addresses one task. Related records use
`task_id`. This pre-launch rename replaces the former route and field names;
legacy task endpoint names are not aliases.

The organization API below uses `qva_` agent keys. Only the
[webhook management routes](#generic-webhooks) also accept personal tokens and
OAuth access tokens, allowing MCP subscribers to inspect their callbacks. The separate
[background curation API](#background-curation-api) at `/v1/curation/` uses
operator-issued `qvc_` keys for the global image library and agent prechecks.

Base URL:

```
https://api.qivo.io/v1
```

Against a dev deployment: `https://<deployment>.convex.site/v1`

The normal service also exposes `GET /public/canvas?date=YYYY-MM-DD` outside
the organization API. This public, read-only feed lets the private demo use
the same approved weekly/default Canvas photo. It returns `null` or image and
preview URLs with display credits, never account preferences, custom uploads,
pending images or workspace records. It requires exactly one valid date,
uses public CORS without credentials and sends `Cache-Control: no-store`.
The endpoint returns 404 on demo deployments. It does not grant access to
the authenticated APIs below.

## Authentication

OAuth access tokens and personal `qvt_` tokens authenticate [MCP](mcp.md) and
the webhook management routes below. Other organization REST routes require
`qva_` agent keys. Background curation uses its separate `qvc_` credentials.

Agent-key requests carry the key as a bearer token or in `X-Api-Key`:

```
Authorization: Bearer qva_0123…
```

The secret is shown exactly once, at creation. Only its SHA-256 digest and a
safe display fingerprint (the first 7 and last 5 characters, such as
`qva_012...abcde`) are stored; a revoked key
stops working immediately, and so does **every** key of an agent switched to
Inactive. `401` means the key is missing, unknown, revoked or deactivated;
`403` means the key is valid but the agent lacks the required role or
organization editing is paused for billing;
unreadable objects come back as `404`.

An agent may hold several keys at once, which is how one is rotated without
the agent going dark: mint the new key, move the client over, revoke the old.

Access follows the agent's effective project roles, including team grants:

- **read** — any role: list/fetch the project, its tasks and their comment
  threads.
- **write** — `user` or `lead`: create, edit and delete tasks in the project,
  and post comments on them. A writing role reads too — the agent model has
  no write-without-read grant.

**Two different things are spelled `viewer`.** The one above is a **project
role** — a grant on one project, reported in that project's `access` flags.
The other is the agent's **organization role** (migration 0102; the `org_role`
field in `GET /v1/users`), and it is a *ceiling* rather than a grant: it never
opens a project, it only refuses to let any other path — a `user` or `lead`
grant, a team grant, a project-lead title, a team leadership — exceed read.
They share a word because they are the same idea one altitude apart. An agent whose
`org_role` is `viewer` therefore comes back with
`"access": { "read": …, "write": false }` on **every** project, whatever it
holds there, and task-changing `POST`/`PATCH`/`DELETE` requests return `403`.
Managing that key's own webhooks remains allowed. That is how
a read-only key is made: one setting on the Users page, not a grant list
audited project by project. Nothing in this surface implements it — the cap
lives in the shared access layer (`cappedLevel` in `convex/lib/access.ts`),
applied inside the one authorization computation every surface calls, so the
same profile is read-only here, over MCP and in the browser alike.

> **Migration note.** Org-level `qv_` keys, with their own per-project
> read/write grant list, were removed in migration 0100. They authenticated
> nobody, so their writes landed in the activity feed with no actor, and
> their grants were a second access model maintained by hand beside the real
> one. Replace each with an agent user: create it under Settings →
> Organization → Users, give it a role on the same projects, and swap the
> `qv_` secret for the `qva_` key.

## Request limits and billing

Organization REST requests and MCP share a limit of **300 authenticated
requests per profile per minute**, across that profile's agent keys, personal
tokens and OAuth connections. A deployment-wide limit of **6,000 requests per
minute** applies before authentication across both interfaces. These use fixed
minute windows. CORS preflights do not consume either allowance.

An exceeded limit returns HTTP `429` with `Retry-After: 60`; wait 60 seconds
before retrying. During a recorded billing period, authenticated requests
that pass rate limiting count toward the organization's pooled API allowance,
including requests that later fail validation, routing or permission checks.
Requests rejected for missing/invalid credentials or rate limiting do not add
billable calls. The separate curation API keeps its own limits below.

When organization billing is enabled, unpaid or expired access pauses writes
with a readable HTTP `403` billing refusal. Reading remains subject to the
existing access rules. An organization admin can subscribe or update payment
details under **Settings → Organization → Billing**; machine credentials
cannot manage subscriptions. Billing also shows usage by account and key.

## Endpoints

### Projects

```
GET /v1/projects                → readable ACTIVE projects, with access flags
GET /v1/projects?archived=true  → the archived ones instead (0106)
GET /v1/projects/{id|num|KEY}   → one project (uuid, per-org number, or key);
                                  an explicit ref resolves an archived
                                  project too
GET /v1/projects/{ref}/users    → users who can see that project, for
                                  reporter, assignee and reviewer
                                  selection
```

```json
{
  "id": "…uuid…", "key": "ENC", "num": 2, "name": "Enclosure", "type": "project",
  "parent_id": "…uuid…", "team_id": null, "description": "",
  "archived": false, "archived_at": null,
  "access": { "read": true, "write": false }
}
```

`num` is the durable per-org project number (migration 0050) — it never
changes, while `key` is a display name an admin can rename. Prefer numbers
or uuids in stored configuration.

`team_id` is always `null` for newly created products and sub-projects. It is
retained as a nullable compatibility field for legacy rows; team sharing is
reported through the access model, not project ownership.

The project-user route has the same rows as `GET /v1/users`, plus
`"assignable": true | false`. Every returned row is an existing Qivo profile
that can see the named project. Any row may be used as `reporter_id`;
`assignee_id` and `reviewer_id` additionally require `assignable: true` (the
profile is active and has effective Edit (`user`) or Lead access to the
project, under the organization Viewer ceiling). A user with only View access
remains a valid reporter, but cannot be selected as assignee or reviewer.
Unknown projects and projects the agent cannot read both return `404`. Use
this route when mapping identities for an import instead of guessing from the
organization-wide roster.

**Archived projects** (migration 0106) are projects that have been put away
in the app. They keep every task, comment and attachment they had, but they
are not part of the working set: they are absent from the list above unless
you ask for them, their tasks are absent from `GET /v1/tasks` unless you
name the project (see below), and a `POST /v1/tasks` into one is a 400 that
names the project to restore. `archived_at` is when it happened; `archived`
is the same fact as a boolean.

### Users

```
GET /v1/users       → the organization's users, people and agents alike
GET /v1/users/{id}  → one of them
```

Two rows of that list — a person, and an agent:

```json
[
  { "id": "…uuid…", "name": "Priya Patel",
    "org_role": "user", "kind": "person", "active": true, "plannable_hours": 31 },
  { "id": "…uuid…", "name": "Release Bot",
    "org_role": "viewer", "kind": "agent", "active": true, "plannable_hours": null }
]
```

`kind` is `"person"` or `"agent"`; an agent finds *itself* in this list,
which is how it learns its own uuid. `org_role` is the **organization** role —
`"admin"` · `"user"` · `"viewer"` · `"guest"` — never a project role; what
someone holds on a given project is that project's `access` flags.

That is the whole shape. It carries **no email address**, no auth id, and no
profile picture, deliberately: a roster of addresses is exactly the sort of
thing a key holder should not be handed in bulk. (`job_role`, a free-text profession, was
part of this payload until migration 0096 dropped the column — nothing read
it and no surface could edit it. Clients that stored it should drop it; the
API never branched on it.)

Two of these fields say whether someone is personally eligible to be handed
work, and both are worth reading before the `400` rather than after. `active`
is `false` for a user who has been switched off (migration 0099), and
`org_role` is `"viewer"` for one who is read-only (0102): a viewer holds a
seat and signs in, reads exactly the projects they were added to, and writes
nothing — being assigned a task included. Either way they keep their history
and their name still renders on everything they touched, but neither can hold
*new* work. Effective project Edit (`user`) or Lead access is the third
condition, including inherited access through teams and the parent project;
View access alone is insufficient. The project-user route combines these
conditions into `assignable`, which gates `reviewer_id` exactly as it gates
`assignee_id`. An `assignee_id` or `reviewer_id` naming an ineligible
user is a `400` that says which condition failed:

```json
{ "error": "user \"<uuid>\" is switched off and can hold no new work" }
{ "error": "user \"<uuid>\" is a viewer — a viewer reads the projects they are added to and is never assigned work" }
{ "error": "user \"<uuid>\" needs Edit permission or higher on this project to be assigned work" }
```

For `reviewer_id` the last sentence ends `… to review work` instead; the
other sentences are the same.

A uuid that is not a user of your organization at all answers
`user "<uuid>" not found in your organization` — one sentence for unknown
and out-of-org alike, checked before either role test, so a foreign uuid
never learns anything about the person it names. An otherwise eligible user
who cannot see the task's project answers
`user "<uuid>" has no access to this project`.

Existing assignments survive a downgrade to View or an organization Viewer
role; updates that omit `assignee_id` preserve them. Any explicitly supplied
non-null `assignee_id`, even the current value, requires current eligibility.
Reviewers follow the same rules. Moving a task in the app checks its assignee
and its reviewer against the destination project, except that a task with
active subtasks is never refused for its reviewer: the move clears a
`reviewer_id` the destination would refuse. An agent can be a viewer
too, and that is the read-only key described above: its row here reads
`"kind": "agent"`, `"org_role": "viewer"`, and every project it can reach
comes back `"write": false`.

`plannable_hours` is `integer | null` — that person's own weekly capacity, the
**whole hours** they have for **planned project work**, the work week with
meetings, email and other overhead already taken out. It is an `integer`
column (migration 0095): a plannable week is never a fraction, whichever way it
was set. It is the number the planner divides by: plan
someone at most that many hours in a week, and remember the week is shared
across every project they work on, not only the ones this key can see. It
belongs to the person, not to their team (migration 0092); a newly added
user starts on the organization's default and carries their own value from
then on.

It is **`null` for an agent** (migration 0103), which has no plannable week at
all: an agent is not in the meetings, does not sleep, and can be given a second
task without giving the first one back. Its capacity is treated as unbounded —
its work is never stretched to fit a calendar and it is never over capacity.
Do **not** read that `null` as `0`, which would say the opposite ("nothing left
this week"); branch on it. Unbounded is not literally true of a real agent —
there are rate limits, a budget, a queue — but none of those is a weekly hour
count, and the invented number was worse: an agent handed the org default was
shown at 150% loaded and its work spread over weeks it did not need.

The `/v1/users` roster is **organization-scoped, not project-scoped**: an
agent sees every user of the organization it belongs to, whatever its project
roles say — useful for general identity lookup, but not proof that a user may
be written onto a task. `GET /v1/projects/{ref}/users` is the project-scoped
subset and the authoritative reporter, assignee and reviewer picker.

**Read only.** Setting someone's capacity takes an organization admin or a
leader of a team they belong to (migration 0094), and an agent is **never an
organization admin**: the profile shape refuses it (0100, widened by 0102 to
admit `viewer` and nothing else), because an admin reaches every project
without a grant — the one thing a key must not be able to do if it leaks. And
since 0103 an agent has no plannable week of its own to set either; the setter
refuses one outright. Change a person's hours in the app, or over MCP —
`update_user` there runs as whoever holds the credential and answers to the
same rule. `POST`/`PATCH` on these routes are 404.

### Tasks

Task references are **permanent**: `QN-482` (any case), bare `482`, or the
task uuid. Task numbers are org-scoped (one counter per organization, 0050),
assigned at creation and immutable — a reference survives moves between
sub-projects and any project rename. The `QN` prefix is a fixed product
constant, not data.

```
GET    /v1/tasks                           tasks across all readable projects
                                           that are not archived (0106)
GET    /v1/tasks?project=ENC                scoped to a project (uuid, number
                                           or key; a meta expands to its
                                           sub-projects) — naming an ARCHIVED
                                           project is how you read its tasks
       &status=todo &priority=high         enum filters
       &assignee=<profile-uuid>            the stored assignee, also while
                                           a reviewer owns the task
       &search=text                        matches task ID, title and description fragments
                                           (substring; * acts as a wildcard)
       &archived=true                      the ARCHIVED tasks instead (0070);
                                           the default lists active ones only.
                                           A task's archive and its PROJECT's
                                           are different axes: this flag is
                                           the first, `project=` is the second
       &limit=100 &offset=0                limit ≤ 200
GET    /v1/tasks/{ref}                     ref: QN-482 | 482 | uuid — resolves
                                           archived tasks too
POST   /v1/tasks                           requires write on the target
                                           sub-project (see below)
PATCH  /v1/tasks/{ref}                     requires write
DELETE /v1/tasks/{ref}                     requires write
```

Search is case-insensitive: every whitespace-separated fragment must match the
task ID (`QN-<num>`), title or description, in any order and anywhere inside a
word. `search=upd%20firm` finds “Add signed firmware updates and rollback”.
Explicit `*` wildcards within fragments remain supported; other punctuation is
literal.


POST body — `project` (uuid, number or key) and `title` are required. Tasks live in
sub-projects: name the sub-project directly as `project`, or name the project
as `project` and one of **its** sub-projects as `sub_project`. Naming a
project without a `sub_project` is a `400` listing the sub-projects the key
can write to; a `sub_project` that belongs to a different project is a `400`
— a task is never created under another project's sub-project (moving one
later is the app's Move dialog, not the API):

```json
{
  "project": "USB",
  "sub_project": "ENC",
  "title": "Fix hinge tolerance",
  "description": "Markdown text",
  "status": "todo",
  "priority": "high",
  "assignee_id": "…profile uuid… or null",
  "reviewer_id": "…profile uuid… or null",
  "reporter_id": "…profile uuid…",
  "start_week": "2026-07-06", "end_week": "2026-07-20",
  "due_date": "2026-07-24",
  "remaining_hours": 8,
  "paused": false
}
```

Tasks have Reporter, Assignee and Reviewer. The reporter identifies the Qivo
user who reported the work and is fixed when the task is created. Omitting
`reporter_id` on POST defaults it to the authenticated user. To attribute an
import to another user, supply an existing Qivo profile returned by
`GET /v1/projects/{destination}/users`; `null` is not accepted. The browser
always uses its signed-in user and never offers a reporter picker.

The selected reporter must have access to the destination project. It may
be inactive or an organization viewer because reporting is attribution rather
than workload. A non-null `assignee_id` must name a row from the same route
whose `assignable` flag is true. Thus neither field can point at a source-system-only identity or a Qivo
user who cannot see the project. Malformed ids return `400`; unknown and
foreign ids return `user "<uuid>" not found in your organization`, while a
same-organization profile without project access returns
`user "<uuid>" has no access to this project`. The API never substitutes a
different user when a requested reporter is invalid.

**Reviewer.** `reviewer_id` follows the assignee's rules: a non-null value
must be a row with `assignable: true`, `null` clears it, and an ineligible
user gets the sentences above, ending `… to review work`. Malformed values
return `reviewer_id must be a profile uuid or null`. A reviewer may be the
same user as the assignee. While a task is in `review` with a reviewer set, it
is the reviewer's task: the app counts its remaining time against the
reviewer's week and shows the reviewer as its owner. In every other status the
assignee owns it. A task with active subtasks has no reviewer of its own: a
PATCH setting a new non-null `reviewer_id` on one is a `400` (`a task with
subtasks has no reviewer of its own; set reviewers on its subtasks`), while
clearing one always passes. A request may set only `reviewer_id`.

PATCH accepts the same fields except `reporter_id`, `project` and `sub_project`.
Any PATCH containing `reporter_id`, including `null` or the current reporter,
returns `400` with `reporter_id is set when a task is created and cannot be changed`;
other fields in that request also remain unchanged. Moving a
task between projects is not supported over the API (the app's Move dialog
handles the label rules; the task's number never changes). Unknown fields are ignored; invalid values are
rejected with `400` and a message. `title` is trimmed and capped at 80
characters (a longer one is a `400`; the same shared rule holds in the app
and over MCP). `status` ∈ backlog · todo · progress ·
review · done; `priority` ∈ urgent · high · medium · low. `paused` (a
boolean) holds the work: only a To Do, In Progress or In Review task can be
paused — asking for it on a Done or Backlog task, on POST or PATCH, is a
`409` (`a Done or Backlog task cannot be paused`) — and a status move to
either of those resumes the task. The reason belongs in a comment; the flag
carries no text. `start_week`, `end_week` and `due_date` must be real calendar
dates in `YYYY-MM-DD` form, or `null` to clear; impossible dates are refused
instead of rolling into the next month. `start_week` and
`end_week` must be set (or cleared) together, with `start_week` ≤ `end_week`
— on PATCH the rule applies to the patched result, so setting one of them is
fine when the other is already set. Both dates denote week starts and the
end week is included: on a Monday-based calendar, `2026-09-21` through
`2026-09-28` is a two-week plan. Use the organization's **Workdays start on**
setting (Settings → Organization → General); the organization REST API does
not expose that setting, so obtain it from the user or signed-in browser
before calculating week dates. `remaining_hours` accepts finite nonnegative
numbers, rounded to one decimal place, or `null` to clear. Numeric overflow
(for example `1e309`) is refused. `remaining_hours` was named
`estimate_hours` until 2026-07-17 (0063 — the field now means hours of work
*left*); the old name is no longer recognized, so a PATCH still sending
`estimate_hours` falls under "unknown fields are ignored" — update callers.

Tasks with active subtasks are groups. Responses include `is_group: true`;
their stored `status` is dormant and must not be displayed or counted as
their own workflow status. Status filters return ordinary tasks only, and a
PATCH containing `status` on a group returns `400` with
`status cannot be set on a task with subtasks — update its subtasks instead`.
When its last active subtask is detached, deleted or archived, the task
resumes its saved status. Archived parents retain `is_group: true` while
they have attached subtasks. Child visibility does not change grouping;
this flag reveals no child identities.

A task **with active subtasks** has no remaining time of its own (0066;
archived subtasks stopped counting in 0070): a PATCH
sending a non-null `remaining_hours` for one is a `400`
(`remaining_hours cannot be set on a task with subtasks — it is the sum
of their remaining time`; `null` passes as a no-op) — the hours live on the
subtasks, and clients compute the parent's shown value as their recursive
sum. Such tasks return `remaining_hours: null` in the shape below. The API
cannot set `parent_id` (response-only), so this only ever bites PATCH.
Writing `remaining_hours` also stamps the read-only `remaining_set_at`
(0072): a remaining time is a measurement, and the planning math anchors on
when it was taken — the server stamps the moment the value *changes* (an
unchanged value writes nothing), clears the stamp with the hours, and ignores
any `remaining_set_at` a client sends (unknown-field rule).

**Review time.** A task that enters `review`, whether created there by POST or
moved there by PATCH, gets its project's review time as `remaining_hours`
(2 h unless the project lead sets another in the app), with a fresh
`remaining_set_at` even when the hours are unchanged. A non-null
`remaining_hours` in the same request wins; `null` or no value takes the
review time. Leaving `review` keeps whatever remaining time is there, and a
PATCH that stays in `review` changes nothing. A group cannot change status,
so it never gets one. The review time is not exposed on the project routes.

PATCH also accepts `archived: true | false` (0070 — the Active/Archived axis,
orthogonal to `status`). Archiving a task archives its subtasks with it;
restoring one also restores its parent chain (both server-side cascades).
Archived tasks disappear from the default list (`?archived=true` finds
them), stop counting as workload, and in the app leave every normal view for
the Archive page. Where the legacy per-team setting applies, restoring a
still-`done` task **restarts its auto-archive clock** (0071), so a restore
holds for the full threshold rather than being re-swept the next night. New
teamless projects have no automatic archive threshold yet. `archived` matching the current state is
a no-op `200` returning the full task. Sending `archived` on POST is a `400` — tasks
are created active. In the app, archiving unfinished work requires a written
reason (stored as a comment); the API does not enforce that — API callers
state their reasons in their own systems, or POST a comment alongside.

Task shape returned by all task endpoints:

```json
{
  "id": "…uuid…", "key": "QN-3", "num": 3, "project_id": "…uuid…",
  "project_key": "ELEC", "project_num": 2,
  "title": "…", "description": "…", "status": "todo", "is_group": false, "priority": "high",
  "assignee_id": "…uuid or null", "assignee_name": "Leo Martins",
  "reviewer_id": "…uuid or null", "reviewer_name": "Aisha Rahman",
  "reporter_id": "…uuid or null", "reporter_name": "Nora Berg",
  "parent_id": null, "start_week": null, "end_week": null, "due_date": null,
  "remaining_hours": 8, "remaining_set_at": "…timestamp or null…",
  "paused": false,
  "archived": false, "archived_at": null,
  "created_at": "…", "updated_at": "…"
}
```

`DELETE` returns `{ "deleted": true, "id": "…", "key": "QN-3" }`.

### Comments

The task's discussion thread (migration 0054) — the same comments the app
shows on the task window's discussion spine:

```
GET  /v1/tasks/{ref}/comments   the full thread, oldest first (read)
POST /v1/tasks/{ref}/comments   { "body": "Markdown text" }      (write)
```

```json
{
  "id": "…uuid…", "task_id": "…uuid…",
  "author_id": "…uuid…", "author_name": "Release Bot",
  "body": "Markdown text", "created_at": "…",
  "edited_at": null, "edited_by_id": null, "edited_by_name": null
}
```

A comment created here is authored by **the agent itself** — it is a user,
so it speaks under its own name instead of landing as the anonymous
"Someone" an org-level key used to produce. Attribution is still
server-stamped precisely so it cannot be forged: passing `author`/`author_id`
is rejected with `400`. You are only ever yourself. `POST` returns `201`
with the created comment; a blank `body` is a `400`. Editing or deleting
comments is not supported over the API (in the app that is the author or a
project lead). Comments are deleted with their task.

**Mentions and inbox messages (0074/0075/0114).** Description and comment
markdown may carry the app's mention form — `@[Display Name](user:<profile
uuid>)` (the label may not contain square brackets; mention syntax inside code
spans or fenced blocks renders literally and does not notify). A mention (in a
comment, or newly added to a description) delivers an inbox message to that
user, and any API write that changes a task — or comments on it — messages
everyone **subscribed** to that task. Since 0114 that is the whole rule:
subscribers, not "the assignee", who is simply subscribed by having been
assigned. Being @mentioned or leaving a comment subscribes you too, so an
agent that comments on a task starts receiving its news. Whoever a task passes
to starts following it as well: the reviewer when the task enters `review`
with a reviewer set (or a reviewer is set while it is there), who reads
`Ready for your review`, and the assignee when it leaves `review` again or
loses its reviewer there. A reviewer set in any other status is not
subscribed, and a task with subtasks stays with its assignee, so clearing its
reviewer subscribes nobody.

There is no subscribe endpoint. Subscribing is a person's own notification
preference, expressed in the app, and this API has no way to read an inbox
back — so a subscription made here would be signing up for something you
could not collect.

All of it happens server-side, inside the same transaction as the write, so
it needs nothing from the caller; unknown or out-of-org uuids in mention
position are silently ignored, as are users without visibility into the
project — a subscription never outlives the project access that justified it.

Every write here is the agent's, and the server is what says so. Each
endpoint is one internal function — resolve the ref, check the rules, make
the write and record the trail, in one transaction — and that function takes
the authenticated caller explicitly, so there is no anonymous path for a
write to arrive on. (Before 0115 this surface wrote with elevated
credentials and no session identity, so a task INSERT or PATCH was
**actor-less** and everyone subscribed to the task was told "Someone" had
changed it.) The subscriber sees the agent's name, and the activity trail
records that agent as the actor even when task creation selects a different
`reporter_id`. Selecting a reporter never rewrites who performed the
operation. Task responses expose reporter, assignee and reviewer, with no
separate creator fields. The agent is not notified of its own changes.

## Examples

```sh
# readable projects
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/projects"

# who can be assigned work, and how many hours a week each of them has
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/users"

# valid reporters and assignees for Enclosure
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/projects/ENC/users"

# open high-priority tasks in Enclosure
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/tasks?project=ENC&priority=high"

# create a task
curl -X POST -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"project":"ENC","title":"Fix hinge tolerance","priority":"high","reporter_id":"<profile uuid>"}' \
  "$BASE/tasks"

# move it to review (QN-26, qn-26 and 26 are equivalent); remaining_hours
# becomes the project's review time, 2 h by default
curl -X PATCH -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"status":"review"}' "$BASE/tasks/QN-26"

# hand it to a reviewer (a row with assignable: true), or clear with null
curl -X PATCH -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"reviewer_id":"<profile uuid>"}' "$BASE/tasks/QN-26"
```

## Side effects and audit trail

Organization API writes leave the same trail the app leaves, and they are **signed**: an
`activity_events` feed row whose actor is **the agent itself**, with detail
`via the REST API (<key name>)`. The org-level `qv_` keys this replaced left a
null actor and that footnote, which read as "someone, somehow" in a feed whose
whole job is saying who did what; an agent is a user, so it signs its own work.
The key is still named beside it, because an agent may hold several and "which
key did this" is the question you ask when one has to be rotated. An update's feed
row names both sides of every changed field before the provenance suffix —
e.g. `(status To Do → In Progress, remaining 80 h → 40 h) — via the REST API
(<key name>)`; description edits quote both sides as ~80-char excerpts
(`description “old…” → “new…”`). A reviewer change names both people
(`reviewer unset → Aisha Rahman`), and a move into `review` lists the review
time it set (`status In Progress → In Review, remaining 6 h → 2 h`).
Comments are the deliberate exception — no activity row is written,
matching the app, where the comment itself is the feed entry on the
discussion spine. Task numbers come from the same
per-organization counter the app uses (0050), so API- and app-created
tasks share one sequence. `last_used_at` on the key updates on every
authenticated request.

## Storage

- `agent_keys` — one row per key, hanging off the **agent's own profile**
  (`profile_id`): name, `key_prefix` (the display fingerprint; the legacy
  column name is retained), `key_hash` (SHA-256),
  `created_by`, created/last-used/revoked timestamps (migration 0100). The
  table is indexed by hash (`by_hash`), which is how a bearer secret finds
  its row. An agent may hold several, and deleting the agent takes its keys
  with it.
- What a key may reach is **not** stored beside it. Direct grants live in
  `project_access`; team grants in `project_team_access` apply through current
  `team_members`. These are the same grants used for every person, read through
  `canSeeProject` and `hasProjectLevel`
  (`convex/lib/access.ts`), the predicates every surface calls, which apply
  the whole access model (org admin, project and sub-project leads, direct or
  explicit team grant) under the organization-role ceiling. They are asked *as the
  agent*, inside the request's own transaction, so the answer this API gives, the
  answer MCP gives and the answer the app gives are one computation rather
  than three kept in step.

Authentication is the one step that cannot run as the caller — you need the
row to learn who you are — so credential lookup is its own internal query
(`convex/machine/auth.ts`), run before dispatch; the endpoint function then
re-asserts the profile it was handed, so an agent deleted or deactivated
between lookup and dispatch still answers `401`. The old `api_keys` and
`api_key_project_access` tables — the `qv_` keys and their separate
per-project grant list — were dropped by migration 0100.

## Background curation API

`https://api.qivo.io/v1/curation` is a separate, global curation workspace.
An operator creates a named access key in **Qivo Admin → Background images → Agent access**.
The secret is shown on creation; its database row stores a SHA-256 hash and
display fingerprint. Keys expire after **365 days**, can be revoked, and
stop working when their issuing account loses platform-operator access.
The key and issuer are checked again inside each dispatched operation.

Use `Authorization: Bearer qvc_…`, with the full secret: `qvc_` followed by
64 lowercase hexadecimal characters. This API accepts neither organization
agent keys (`qva_`) nor personal MCP tokens (`qvt_`), and has no `X-Api-Key`
fallback. A curation key cannot access organization projects or MCP tools.
It can read the shared image library and submissions, including proposals
from other curation keys, and record an agent precheck.

| Method and path, relative to `/v1/curation` | Result |
| --- | --- |
| `GET /images` | Image page; `status=pending` by default. |
| `GET /images/{id}` | One image with preview, credits and review metadata. |
| `POST /images/{id}/review` | Record an agent precheck; optionally propose a date. |
| `GET /submissions` | Shared submission page, newest first. |
| `GET /submissions/{id}` | Submission status, preview if available, and the date's current image. |
| `POST /submissions` | Submit an Unsplash photo-page URL and recurring date; `202`. |
| `POST /submissions/{id}/review` | Record an agent precheck on an open submission. |

Other successful operations return `200`. Lists contain up to 24 rows and
return `isDone` plus `continueCursor` (`null` when finished). Pass the returned
cursor as the next request's URL-encoded `cursor` parameter. Image lists use
`images`; submission lists use `submissions`. For images, `status` accepts
`pending`, `approved` or `removed`, and the optional `agent_review` filter
accepts `unreviewed`, `approved` or `declined`. Keep the same filters while
paging; query each human status to inspect the whole library.

Image records expose original `image_url`, compressed `preview_url`, `title`, `creator`, `source_url`, `license`,
`license_url` and `attribution`, together with human `status` and optional
`agent_review`, `agent_review_note`, `agent_reviewed_at`, `agent_review_id`
and `agent_reviewer`. Removed images retain provenance but have no preview.
Images saved through the operator uploader also expose their generated
`filename` and optional `location`. The filename joins the first 20 characters
of the title and creator with `_`, lowercases them and replaces spaces with
dashes, for example `misty-mountain-peaks_sam-lim.jpg`. Unsafe filename
punctuation is replaced with dashes. These fields may be absent on older
images; an empty location is omitted. The filename is retained image metadata;
`image_url` remains an opaque Convex storage URL.
Use `preview_url` to display and inspect the image and preserve its credit/license metadata.
It is null while compression is pending or if no derivative is available; the
original remains at `image_url` for actual Canvas rendering. Submission image
metadata also includes `preview_url`. `preview_version` identifies the encoding revision when present.
Library image records also expose `preview_byte_size` (bytes), read from the stored
WebP file, or null when no preview file is available. This includes existing previews
without regeneration. Original dimensions and file size remain in `width`, `height`,
and `byte_size`.
Preview creation or regeneration does not approve or assign images.
Storage IDs, raw provider metadata and download URLs are not exposed here.
Generic operator uploads may have empty `source_url` and `license_url` strings;
their `license` is `Permission confirmed by uploader`. Do not render empty
values as links or treat that permission assertion as a verified provider
license. Manually uploaded library files can be JPEG, PNG or static WebP.
The dated source-link attachment flow below remains JPEG-only.

### Submitting a source link

Send a JSON object containing `url` and `date`. Optional `title` and `creator`
are nonblank strings up to 300 characters; optional `reason` is nonblank and
up to 2,000 characters. The URL must be an HTTPS Unsplash photo page ending
in its 11-character photo ID, with or without a descriptive slug. The server
stores a canonical photo-page URL and drops tracking queries/fragments.
Direct image-CDN links, other hosts and arbitrary download URLs are refused.

`date` is a recurring **ISO week key `W01`–`W53`**, without a year.
Each image runs Monday–Sunday in UTC; week 1 contains January 4 and week 53
applies only in years that have it. For example, `W52` proposes the same week
number each year, even though its calendar dates vary. Legacy `MM-DD` values
remain accepted and map through the fixed reference year 2026 (`12-25` → `W52`).
A legacy `02-29` key is refused; actual leap days use their normal ISO week.
Proposals retain their supplied key, while final calendar writes use `WNN`.

The response is `{ "submission": { ... }, "idempotent": false }`. A new
source link normally has `status: "needs_file"` and `image_url: null`.
Submission does **not** scrape or download the page, verify the photo's
existence/license, or change the calendar. An operator must attach a
legitimately obtained JPEG and confirm its source/license before final review.
If the image is already in the library, the proposal is `pending`; a source
previously removed by a human produces a `declined` proposal. See the
[image-library workflow](background-image-library.md).

`Idempotency-Key` is optional and scoped to the curation key. When supplied,
use 1–100 letters, numbers, dots, colons, underscores or hyphens. Otherwise,
the canonical photo identity and date provide the request key. Repeating
the same request returns the original submission with `idempotent: true`
and still uses HTTP `202`; reusing that request key with changed metadata
returns `409`. At most 1,000 source-link submissions may await files at once.

### Agent prechecks and human decisions

Both review routes accept `decision: "approved" | "declined"` and a
required nonblank `reason` of at most 2,000 characters. The image review
route also accepts an optional `date` in `W01`–`W53` format (or a legacy `MM-DD` alias). An **approved image
precheck with a date** creates a pending week proposal or returns the existing
proposal's `submission_id`; without a date, that field is `null`. The submission
review route does not change its requested date.

These decisions update `agent_review`, not the image's human `status`.
An agent-approved image stays pending human review; an agent-declined image
keeps its bytes. Agents cannot finally approve/remove library images,
accept/decline submissions as humans, or assign/clear calendar weeks.
Prechecks on images with a final human decision, or closed submissions,
return `409`. Human submission statuses are `needs_file`, `pending`,
`accepted` and `declined`. An operator's final acceptance approves the
available image and assigns the requested week together, after checking
that the current calendar assignment and reviewed precheck have not changed.

### Request limits and errors

POST bodies require `Content-Type: application/json` and a JSON object no
larger than **16 KiB in UTF-8 bytes**. Unknown JSON fields are rejected.
Each key permits **120 authenticated requests per 60-second window**;
requests that later fail validation or routing also count. On `429`, wait
the number of seconds in `Retry-After` before retrying. Poll and paginate
within that allowance.

Errors are JSON objects with an `error` string: `400` for invalid input,
`401` for a missing/invalid/inactive key, `404` for unknown resources/routes,
`405` for an unsupported method, `409` for a review conflict or business
rule, and `429` for throttling. Unexpected failures return a generic `500`.
Responses use `Cache-Control: no-store`; `401` includes
`WWW-Authenticate: Bearer`. Unauthenticated `OPTIONS` preflights allow
`Authorization`, `Content-Type` and `Idempotency-Key`, without credentialed
CORS.

### Curation examples

Set `QIVO_CURATION_KEY` to the secret obtained from the operator console.
Replace the photo and resource placeholders with real IDs.

```sh
CURATION_BASE=https://api.qivo.io/v1/curation

# Inspect images awaiting both agent and human review.
curl -H "Authorization: Bearer $QIVO_CURATION_KEY" \
  "$CURATION_BASE/images?status=pending&agent_review=unreviewed"

# Propose an Unsplash source link for December 25; no image is downloaded.
curl -X POST -H "Authorization: Bearer $QIVO_CURATION_KEY" \
  -H "Content-Type: application/json" -H "Idempotency-Key: winter-selection-1" \
  -d '{"url":"https://unsplash.com/photos/<photo-id>","date":"W52","reason":"Winter landscape for review"}' \
  "$CURATION_BASE/submissions"

# Record a precheck on a stored image and propose its calendar date.
curl -X POST -H "Authorization: Bearer $QIVO_CURATION_KEY" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approved","reason":"Image inspected; suitable landscape","date":"W52"}' \
  "$CURATION_BASE/images/<image-id>/review"

# Inspect the proposal's current human status.
curl -H "Authorization: Bearer $QIVO_CURATION_KEY" \
  "$CURATION_BASE/submissions/<submission-id>"
```

## Operator demo reporting transport

The normal backend accepts **`POST /internal/demo-metrics`** outside `/v1`.
This deployment-to-deployment route feeds **Qivo Admin → Demos**. It is not an
organization-agent API, and is unavailable on the demo backend itself.

The demo's scheduled internal publisher sends JSON every 15 minutes with
`Authorization: Bearer <DEMO_METRICS_SECRET>`. The same dedicated server secret
is configured on the normal receiver and the demo sender; agent, OAuth and
browser-session credentials do not authorize it. Requests must declare
`Content-Type: application/json`, finish within 30 seconds and fit within
900,000 bytes. The receiver checks streamed bytes even without Content-Length,
grants no browser CORS permission and sends `Cache-Control: no-store`.

The version-1 report contains generation/tracking/coverage timestamps,
lifetime/current workspace counts, at most 800 UTC daily creation/storage
buckets, the latest storage sample and aggregate browser/OS/country counts
for seven days, 30 days and 12 calendar months. Workspace records, identities,
IP addresses, raw User-Agent strings and credentials are excluded. The receiver
projects only these fields, validates values and timeline ordering, and caches
only a report newer than its current copy. Repeated or delayed valid reports
leave a newer copy intact.

Responses are `204` for an accepted or already superseded valid report, `401`
for missing/wrong authorization, `404` when disabled or sent to the demo
backend, `415` for a non-JSON content type, `413` for an oversized body, `408`
for a stalled upload and `400` for invalid report data. `adminDemo:metrics`
exposes the cached aggregate only through the normal app's platform-operator
gate; it adds no public REST reporting read endpoint.

The demo Vercel runtime also serves `GET /api/demo-visitor` on the **demo app
origin**, returning a short-lived signed coarse-country context or `null`.
The anonymous sign-in flow uses that context for aggregate attribution; it
does not authorize REST access. Direct Convex geolocation headers are ignored.
Setup, runtime-secret scopes and measurement limitations are documented in
[public demo operations](public-demo-operations.md#connect-demo-reporting).

## Conformance

The surface is pinned twice. `convex/tests/rest.test.ts` (part of
`npx vitest run`) byte-asserts every refusal sentence, the response shapes
and the activity grammar against the in-repo endpoint functions;
`tests/contract/rest.test.mts` (`npm run test:contract`) replays the
contract over the real wire — status codes, headers and bodies against a
running deployment.

The curation HTTP shell is covered by `convex/tests/curationHttp.test.ts`;
`convex/tests/curation.test.ts` exercises its key, precheck, submission and
human-final boundaries, and `convex/tests/panoramaCuration.test.ts` checks
source URL/date validation. `tests/contract/curation.test.mts`
checks the live curation mount, credential-family refusals and preflight
headers without creating submissions or image files.

## Generic webhooks

REST webhooks use the same event definitions, filters, callback verification,
Standard Webhooks signatures and delivery queue as
[MCP Events](mcp.md#task-events-and-webhook-delivery). Authenticate these routes
with the owning agent key, personal token or a current OAuth access token for
the owning connection. OAuth requires `qivo:read`. Read-only users can manage
their own subscriptions without gaining rights to change tasks.

| Method | Path | Result |
| --- | --- | --- |
| POST | `/v1/webhooks` | Create or refresh a subscription, `201` |
| GET | `/v1/webhooks` | List this credential's unexpired subscriptions, including disabled ones, `200` |
| DELETE | `/v1/webhooks/{id}` | Stop this credential's subscription, `204` |
| GET | `/v1/webhooks/organization` | Organization administrators list all unexpired subscriptions, `200` |
| DELETE | `/v1/webhooks/organization/{id}` | Organization administrators remove a subscription, `204` |

POST accepts the same params as MCP `events/subscribe`, without the `_meta`
envelope. Supply `name`, optional `arguments`, and `delivery` containing
`mode: "webhook"`, a public HTTPS `url` and a `whsec_` signing `secret`. Optional
`ttlMs` requests a lifetime. Positive integers are clamped between 60 seconds
and seven days; zero, negative and non-integer values are refused. Omit it or
send null for no expiry. MCP uses a seven-day default when this field is omitted; explicit
null requests no expiry on both interfaces. Example:

```json
{
  "name": "task.updated",
  "arguments": { "project_id": "<project UUID>" },
  "delivery": {
    "mode": "webhook",
    "url": "https://receiver.example/qivo",
    "secret": "whsec_<base64-encoded signing key>"
  }
}
```

The callback must verify signatures and echo the initial verification challenge.
POST returns `id`, `refreshBefore`, `cursor: null` and `truncated: false`. Invalid
input and callback verification failure return `400`. Unknown events and
missing/inaccessible filtered tasks or projects return `404`; authorization
failures return `403`, subscription quota exhaustion returns `429`, and server
configuration errors return `500`. GET returns an array of `id`, `name`,
`arguments`, `delivery` (mode and URL only), `refreshBefore`, `status`,
`disabled_at`, `disabled_reason`, `failed_since`, `last_failure_at`,
`last_success_at` and `last_status`. It includes disabled subscriptions and never
returns secrets. Omitted or null `ttlMs` gives no expiry and `refreshBefore: null`.
A requested positive integer TTL is clamped between 60 seconds and seven days.
Delivery failure streaks lasting seven days disable subscriptions when a further
attempt fails. A `2xx` clears the streak. `410` stops only that event, leaving the subscription and its failure
streak unchanged. `408`, `425` and `429` retry. Repeating POST verifies the
callback and preserves pending retries before expiry. Renewing an active
subscription preserves its failure streak and health history. Verified recovery
of a disabled subscription clears the streak and re-enables delivery, while
retaining previous success, failure and HTTP-status history. Quiet callbacks
are not probed. Finite subscriptions must be renewed before expiry to remain
active through the health window. Registration removes expired registrations
and reclaims quota held by revoked/deleted credentials and removed accounts.
Deleting then registering again cannot revive the deleted registration's
queued events. Registering after expiry also starts fresh.
DELETE is idempotent for absent subscriptions. Another credential's existing
subscription answers `404`, even when both credentials belong to the same person
or agent. OAuth access tokens from the same grant share ownership. Token expiry,
rotation or individual access-token revocation does not cancel its subscriptions;
disconnect the connected app or unsubscribe. A new OAuth connection is a new owner.

Organization routes require a personal token or OAuth connection belonging to an
active person with the organization administrator role. Agent keys cannot use
these routes. OAuth administrator deletion also requires `qivo:write`. These
routes let administrators inspect and remove subscriptions that consume shared
quota, including callbacks owned by inactive users. They do not expose signing
keys or transfer subscription ownership.

Event names are `task.created`, `task.updated`, `task.deleted` and
`comment.created`. Filters take task and exact sub-project UUIDs. Parent
meta-project filters are refused because they cannot contain tasks. The shared
[MCP Events delivery contract](mcp.md#task-events-and-webhook-delivery) describes
payloads, access checks, retry limits, expiration, exclusions and lack of replay.
There are no application-specific bridges or UI settings for webhook management.
