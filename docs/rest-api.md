# Qivo REST API (v1)

The temporary `demo.qivo.io` service is browser-only: it does not issue or
accept external agent credentials or OAuth connections. Use a regular Qivo
workspace for this interface.

A small JSON API over the planner's projects and tasks, served by a
Convex HTTP action. Task and project requests authenticate as one user of the
organization, in one of two ways. An **agent key** (`qva_`) acts as an
**agent user**, a user of the organization that is not a person, with no
email and no password. Agents are created by org admins in **Settings →
Organization → Users**. A **personal access token** (`qvt_`) acts as the
person who created it under **Settings → Your preferences → MCP access**. Either
way, what the caller may reach is the projects that user can access directly
or through a team: a `lead` or `user` **project role** reads and writes, a
`viewer` project role reads, and a role on a meta-project covers its
sub-projects. Over all of that sits the user's **organization role**, which
can itself be `viewer` (for an agent since migration 0102), a read-only seat
made with one setting rather than an audited grant list (see below). The
credential itself can also be read-only. Both project types have a named lead and no owning
team. Projects and sub-projects may be shared with several teams and users
through explicit access grants. Team shares grant `user` or `viewer` to
current members; the strongest direct or team grant wins under the
organization-role ceiling. Manage team and individual sharing in the app's
**Project access** list or with the [project access routes](#project-access),
one user or team at a time.
The website, REST and MCP use **task** for one work item and **tasks** for
collections. REST follows the collection convention: `/v1/tasks` lists or
creates tasks, and `/v1/tasks/{ref}` addresses one task. Related records use
`task_id`. This pre-launch rename replaces the former route and field names;
legacy task endpoint names are not aliases.

The organization API below takes `qva_` agent keys and `qvt_` personal access
tokens. OAuth access tokens are bound to the MCP server, so only the
[webhook management routes](#generic-webhooks) also accept them, allowing MCP
subscribers to inspect their callbacks. The separate
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

Every route under [Endpoints](#endpoints) takes either credential:

- A `qva_` **agent key** acts as its agent. Use it for automation that should
  have its own identity, project access and name in the activity feed.
- A `qvt_` **personal access token** acts as the person who created it, with
  that person's permissions. Use it for actions only a person may take, such
  as setting someone's plannable hours, or for scripts a person runs as
  themselves. The same token also authenticates [MCP](mcp.md).

OAuth access tokens authenticate MCP and, here, only the webhook management
routes, whose credential rules are under [Generic webhooks](#generic-webhooks).
Background curation uses its separate `qvc_` credentials.

Requests carry the credential as a bearer token or in `X-Api-Key`:

```
Authorization: Bearer qva_0123…
Authorization: Bearer qvt_0123…
```

The secret is shown exactly once, at creation. Only its SHA-256 digest and a
safe display identifier (for an agent key the first 7 and last 5 characters,
such as `qva_012...abcde`) are stored. A revoked key or token stops working
immediately, and so does **every** credential of a user switched to Inactive.
A personal token also stops while Qivo blocks its owner from signing in, and
gets a deactivated user's answer. A personal token with an expiry is refused
from that instant on, like a revoked one. A request already accepted when its
credential is revoked or expires can still finish. In the app, **New token**
offers **Never** or a last day, and a token with a last day expires when that
day ends in the creator's time zone.
`GET /v1/me` reports which credential a request used and what it may do.

`401` means the credential is missing, unknown, revoked, expired or belongs to
a deactivated user. Once an organization's deletion begins, a key or token of
that organization that would otherwise work, also one the deletion has
already removed or one of a user deactivated there, gets `403` with
`this organization is being deleted` instead. The sentence of a `401` depends
on the credential:

| Failure | Agent key | Personal access token |
|---|---|---|
| missing or unrecognized | `missing agent key (Authorization: Bearer qva_…)` | the same |
| unknown | `unknown agent key` | `unknown personal access token` |
| revoked or expired | `this agent key has been revoked` | `this personal access token has been revoked or has expired` |
| user deactivated | `this agent has been deactivated` | `this account has been deactivated` |

A request without a recognizable credential cannot be told apart, so it keeps
the agent key's sentence. A `qvo_` OAuth token on these routes gets that
sentence too. `403` means the credential is valid but the user lacks the
required role, the credential can only read, or organization editing is
paused for billing. Unreadable objects come back as `404`.

A comment past its author's posting rate on the task is a `429`, and a
comment on a task whose comments Qivo is still counting a `503`, each with
`Retry-After` (see [Comments](#comments)).

A request that keeps conflicting with changes other requests make to the
same data at that moment, such as many comments posted at once to one task,
or many tasks created at once in one organization, is a `503` with
`Retry-After: 1` and `{"error": "the request conflicted with
other changes made at the same time and changed nothing; send it again"}`.
Qivo first retries such a conflict itself, twice at most. A change that
keeps running out of time, which a busy server and such conflicts can cause,
is retried the same way and is the same `503` with `{"error": "the request
took too long and changed nothing; send it again, or change less at once if
it keeps happening"}`. The `503` means the request saved nothing, so wait
the `Retry-After` seconds and send the same request again. A change too
large to finish in time runs out every time, so if the time out repeats,
split the change into smaller requests. Creating a webhook subscription is the exception, as
[Generic webhooks](#generic-webhooks) describes. A `409` is a different
answer. It refuses a change that carried `expected` because someone changed
one of those fields since you read it, and the request saved nothing (see
[Refusing a change when a field changed since you read
it](#refusing-a-change-when-a-field-changed-since-you-read-it)). Unlike a
`503`, never send a `409`'s request again unchanged, because Qivo refuses it
again. Read the record, decide whether your change still applies, and send
it with the values you read now. A failure that is not a
refusal, such as a server limit, is a `500` with `{"error": "internal
error"}`, and Qivo keeps its details in its own logs. A `500` does not say
whether a change was saved, so read the task or list before you send a
change again.

Match a refusal by its HTTP status, not its sentence. In October 2026 the
sentences lost their em dashes: `that project is archived — restore it
first` now reads `that project is archived, so restore it first`, for
example. The activity rows of REST and MCP writes changed the same way (see
[Side effects and audit trail](#side-effects-and-audit-trail)), and rows
stored before keep their old text.

An agent may hold several keys at once, and a person several tokens, which is
how one is rotated without going dark: mint the new one, move the client over,
revoke the old.

Organization admins see every credential in the organization under
**Settings → Organization → API access**: each member's personal tokens and
connected apps as well as agent keys, with their owner, access, last use and
calls per usage period. An admin can revoke any of them there. The token or
connection then answers like any revoked credential, and its owner sees it as
revoked by an admin in their own list.

Access follows the user's effective project roles, including team grants:

- **read**: any role, to list and fetch the project, its tasks and their
  comment threads.
- **write**: `user` or `lead`, to create, edit and delete tasks in the
  project and post comments on them. A writing role reads too; the access
  model has no write-without-read grant.
- **your own**: following a task, changing your own [inbox](#inbox) and
  editing or deleting your own [comments](#comments) need only read access to
  the task, as in the app. They are still changes, so a credential that can
  only read is refused them.

A readable project the user cannot write answers `403` with
`this agent has no write access to that project` for an agent key and
`your account has no write access to that project` for a personal token.

**Read-only credentials.** Every credential either can make changes or can
only read, by the same rule as on MCP (`credentialAccess` in
`convex/lib/access.ts`). A personal token can make changes only when it has
change access and has not expired; a token stored without an access setting
can only read. When a person creates a token in the app, **Allow changes**
(on by default) gives change access, and the expiry stays **Never** unless
they pick a last day. Neither can be changed later.
An agent key can make changes only when its agent's organization role is
`user`. A read-only credential still reads everything its user can, and every
project comes back `"access": { "read": …, "write": false }`. Every `POST`,
`PUT`, `PATCH` and `DELETE` request returns `403` with
`{"error": "this credential can only read"}` for a personal token and
`{"error": "this agent is a Viewer and can only read"}` for a Viewer agent's
key, before Qivo resolves any reference, so the answer is the same whether or
not the reference exists. Managing the credential's own webhooks remains
allowed.

**Two different things are spelled `viewer`.** The one above is a **project
role** — a grant on one project, reported in that project's `access` flags.
The other is the user's **organization role** (the `org_role` field in
`GET /v1/users`; agents can be `viewer` since migration 0102), and it is a
*ceiling* rather than a grant: it never
opens a project, it only refuses to let any other path — a `user` or `lead`
grant, a team grant, a project-lead title, a team leadership — exceed read.
They share a word because they are the same idea one altitude apart. A user whose
`org_role` is `viewer` therefore comes back with
`"access": { "read": …, "write": false }` on **every** project, whatever it
holds there. For an agent that makes its key a read-only credential, so every
`POST`, `PUT`, `PATCH` and `DELETE` request returns `403` with
`{"error": "this agent is a Viewer and can only read"}` before Qivo resolves
any project or task reference. That is how a read-only key is made, with one
setting on the Users page rather than a grant list audited project by project.
A Viewer person's token may be able to make changes, but every change to a
task, and every new comment, link or attachment, still refuses with `your
account has no write access to that project`, the refusal a missing grant
produces. Changes to a project, its access and milestones, project creation,
labels, teams and plannable hours refuse a Viewer person with each rule's own
sentence, the one anyone without that right gets, such as `requires lead
access to this project`. As in the app, a Viewer person may still follow
tasks, manage their own inbox and edit or delete comments they wrote. Nothing
in this surface implements either rule. They live in the shared access layer
(`credentialAccess` and `cappedLevel` in `convex/lib/access.ts`), which REST,
MCP and webhook management all call, so the same user is read-only here, over
MCP and in the browser alike. A Standard user agent (`org_role` `user`) that
holds only a `viewer` project role gets `this agent has no write access to
that project` on that project instead.

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
tokens and OAuth connections. A deployment-wide limit of about **6,000
requests per minute** applies before authentication across both interfaces.
It is kept as 16 counters of 375 requests each, and every request counts on
one picked at random, so a busy minute can be refused a little before 6,000.
These use fixed minute windows. CORS preflights do not consume either allowance.

An exceeded limit returns HTTP `429` with `Retry-After` set to the whole
seconds left in the current minute, from 1 to 60, and the same number in its
sentence. The per-profile limit answers such as `{"error": "too many requests,
at most 300 a minute for one person or agent. Try again in 17 seconds."}`, and
the deployment-wide limit such as `{"error": "Qivo is receiving too many
requests right now. Try again in 17 seconds."}`. Wait that long before
retrying.
Every authenticated request that passes rate limiting counts
as one API call, including requests that later fail validation, routing or
permission checks. During a paid billing period, these calls count toward the
organization's pooled API allowance. Without a paid billing period, calls are
counted per calendar month (UTC) and are never charged. Requests rejected for
missing/invalid credentials, or by one of these two request limits, are not
counted. A request refused by a limit of the data, such as a comment past
[the comment limits](#comments), passed the request limits and counts as a
call. The separate curation API keeps its own limits below.

A request body may hold at most **1 MiB** (1,048,576 bytes of UTF-8). Qivo
checks the size after authentication, before routing, and answers a longer
body with `413` `{"error": "a request body must be at most 1 MiB. Send less
in one request."}`. Such a request
still counts as a call. A declared `Content-Length` over the limit is refused
without keeping the body. Files never travel in these bodies; see
[Attachments](#attachments).

Qivo answers a request only after its whole body has arrived, even when the
answer does not depend on it, such as a `401`, a `429` or this `413`. Once
Qivo knows such an answer, it waits at most 5 seconds more for the rest of
the body, and less when no bytes arrive for 1 second. It reads at most
32 MiB of the rest, and does not wait at all for a body whose
`Content-Length` declares more than 32 MiB. If the rest takes longer, which
for a body just over the limit means an upload slower than about 2 Mbit/s,
or the body is longer than 32 MiB, the request can end with the connection
closed, or with a `502` from the hosting front end, instead of Qivo's
answer. Treat either like a network error, and check the credential and the
body's size before you send it again. A body Qivo reads to answer, such as
an authenticated request's body within the limit, has no such deadline. A
client that sends `Expect: 100-continue` over HTTP/1.1 gets `100 Continue` at
once, so it sends the whole body before any answer. Over HTTP/2 the hosting
front end sends no `100 Continue`, so such a client sends the body only once
its own wait for one ends, after 1 second for curl.

The hosting front end hands a request to Qivo only once about 0.5 MiB of its
body, or about 5 seconds of a steady upload, has arrived. A body that stops
arriving before that gets no answer, and the front end resets the
connection after about 15 seconds. Treat that like a network error too.

A request that takes a JSON body needs a JSON object. Anything else, such as
invalid JSON, an array or a number, is a `400` (`request body must be
JSON`). A string or field name holding an unpaired surrogate, such as a lone
`\ud83c` escape left when text is cut in the middle of an emoji, is a `400`
(`request body holds an unpaired surrogate, which UTF-8 cannot encode`). A
body whose bytes are not UTF-8, such as text a client encoded as Latin-1, is
a `400` (`request body is not valid UTF-8`). Such text cannot be stored as
sent, so the request changes nothing. These rules hold for
`POST /v1/webhooks` too.

Every route but a `GET` refuses a body field it does not take with `400`,
such as `unknown field "parnet"; this request takes project, sub_project,
parent, …`, so a misspelled field never falls back to a default. A route that
takes no body, such as `DELETE /v1/tasks/{ref}`, accepts an empty body or
`{}` and refuses any field (`unknown field "x"; this request takes no body`).
A `GET` request's body is never used, only read and dropped like any
unused body. Every route also refuses a query
parameter it does not take, such as `unknown query parameter "stauts"; this
request takes project, status, …`, or `…; this request takes no query
parameters`, so a misspelled filter never answers an unfiltered list. Either
refusal names at most 10 fields or parameters and then counts the rest, such
as `and 5 more`. A name longer than 100 characters is cut and ends with `…`.
Fields a route refuses with their own sentence, such as `project_id` on a task, keep
that sentence. Before October 2026 most routes ignored unknown fields and
query parameters, and a body that was not UTF-8 was stored with U+FFFD in
place of each bad byte sequence.

When organization billing is enabled, unpaid or expired access pauses writes
with a readable HTTP `403` billing refusal. Reading remains subject to the
existing access rules. An organization admin can subscribe or update payment
details under **Settings → Organization → Billing**; machine credentials
cannot manage subscriptions. Billing also shows usage by account, each with
**View credentials**, which opens **API access** on that account, and **API
access** shows each credential's calls in the current or an earlier period. While writes are paused, an organization admin can still revoke any
credential on **API access**, revoke or delete an agent's keys or make the
agent Inactive in the app, which also stops its reads.

An organization admin's personal access token can also take access away
while writes are paused, as in the app. It can remove someone from a project
(`DELETE /v1/projects/{ref}/access/users/{user}` or
`…/access/teams/{team}`) or from a team
(`DELETE /v1/teams/{id}/members/{user}`) when `on_held_tasks` is `leave`, the
default. Keeping them as Viewers or reassigning their tasks writes more, so
it gets the `403` refusal of any other write until writes are allowed again,
and so does the same removal by anyone who is not an organization admin.

## Limits

Each limit below is the same here, over MCP and in the app, and the
[Limits](guide/limits.md) guide page lists every one. A text counts UTF-16
code units, the count a browser's text field uses, after Qivo trims spaces
and line breaks from both ends, and Qivo stores the trimmed text. A task
description or comment keeps the spaces that start its first line, because
Markdown reads them. Most emoji count as two. A request past a limit is refused with the sentence in the
table and changes nothing. The refusal is a `400`, except for a request body
over its size (`413`), a full webhook quota (`409`), the request rate and the
comment posting rate (`429`, with `Retry-After`), and a comment on a task
whose comments Qivo is still counting (`503`, with `Retry-After`; see
[Comments](#comments)). A number outside its range is refused, never moved
into the range.

<!-- limits:start (written by scripts/limits-docs.mjs) -->

### Text

| Limit | Value | Past the limit |
| --- | --- | --- |
| Task title | 255 characters | a task title must be at most 255 characters. Shorten it. |
| Task description | 20,000 characters | a task description must be at most 20,000 characters. Formatting counts too. Shorten it. |
| Comment | 20,000 characters | a comment must be at most 20,000 characters. Formatting counts too. Shorten it. |
| Project or sub-project name | 80 characters | a project name must be at most 80 characters. Shorten it. |
| Project description | 500 characters | a project description must be at most 500 characters. Shorten it. |
| Team name | 80 characters | a team name must be at most 80 characters. Shorten it. |
| Milestone name | 80 characters | a milestone name must be at most 80 characters. Shorten it. |
| Label name | 40 characters | a label name must be at most 40 characters. Shorten it. |
| Archive reason | 500 characters | an archive reason must be at most 500 characters. Shorten it. |
| Search text | 200 characters | a search must be at most 200 characters. Search for fewer words. |

### Files and images

| Limit | Value | Past the limit |
| --- | --- | --- |
| Attachment file name | 255 characters | a file name must be at most 255 characters. Rename the file and attach it again. |
| Attachment media type | 255 characters | a file's media type must be at most 255 characters. Send a media type such as application/pdf. |
| Attachment size | 20 MiB per file | a file must be at most 20 MiB, this organization's attachment limit. Attach a smaller file. |
| Uploads in progress | 20 uploads in progress per person in an organization | you already have 20 uploads in progress, the most one person can have at once. Try again once one has finished. An upload that is never finished stops counting an hour after it started. |

### Tasks and organizations

| Limit | Value | Past the limit |
| --- | --- | --- |
| Active subtasks per task | 100 active subtasks | the parent task already has 100 active subtasks, the most a task can have. Archive or remove one of them first. |
| Subtasks a move to another project carries | 200 subtasks, archived ones included | this task has more than 200 subtasks, archived ones included, and a move to another project carries them all. Restore some archived subtasks and remove them from this task first, or move it within its project. |
| Attachments per task | 100 attachments, description images included | this task already has 100 attachments, images in its description included, the most a task can have. Remove one first. |
| Links per task | 100 links | this task already has 100 links, the most a task can have. Remove one of its links first. |
| Labels per task | 20 labels | this task already has 20 labels, the most a task can have. Remove one first. |
| Comments per task | 1,000 comments | this task has reached 1,000 comments, the most a task can have. Ask a project lead to delete comments until it has fewer than 1,000, then post again. |
| Comments one person or agent posts on one task | 10 comments in any 60 seconds | too many comments on this task, at most 10 in any 60 seconds from one person or agent. Try again in 60 seconds. |
| Followers per task | 100 followers | this task already has 100 followers, the most a task can have. Someone must unfollow it first. |
| People mentioned in one text | 100 people | a text can mention at most 100 people. Remove some mentions and save again. |
| Milestones per project week | 1 milestone in each calendar week, for a project and its sub-projects together | this project already has a milestone in that week, and a project can have at most 1 milestone a week. Pick another week, or move that milestone first. |
| Tasks one access removal reassigns | 120 tasks | a removal can reassign at most 120 tasks at once, fewer when the change is too large for one request. Keep the people as Viewers or reassign some of the tasks first. |
| People with open tasks one access removal settles | 700 people | a removal that keeps people as Viewers or reassigns their tasks can take access from at most 700 people with open tasks at once. Leave the tasks with them, or remove some of the team's members first. |
| Sub-projects and access entries one project archive, restore, rename or key change updates | 2,000 sub-projects and access entries | archiving, restoring or renaming a project, or changing its key, can update at most 2,000 sub-projects and access entries at once. Each sub-project counts, and each person or team with access counts once for the project and once for each sub-project they have their own access to. Archive all of its sub-projects on their own first, or remove some access. |

### Numbers and settings

| Limit | Value | Past the limit |
| --- | --- | --- |
| Plannable hours per week | 1 to 168 hours | plannable hours per week must be a whole number of hours from 1 to 168. |
| Remaining hours of a task | 0 to 99,999.9 hours | remaining hours must be a number from 0 to 99,999.9. Enter a number in that range. |
| Review hours of a project | 0 to 999 hours | review hours must be a number from 0 to 999. Enter a number in that range. |
| Snooze | 366 days ahead | a snooze can be at most 366 days ahead. Pick an earlier time. |

### REST and MCP requests

| Limit | Value | Past the limit |
| --- | --- | --- |
| Tasks per list page | 1 to 200 tasks | limit must be a whole number of tasks from 1 to 200. |
| Inbox items per list page | 1 to 200 items | limit must be a whole number of items from 1 to 200. |
| Comments per list page | 1 to 50 comments | limit must be a whole number of comments from 1 to 50. |
| People per workload page | 1 to 200 people | limit must be a whole number of people from 1 to 200. |
| Workload weeks | 1 to 52 weeks | weeks must be a whole number from 1 to 52. |
| Users per list page | 1 to 200 users | limit must be a whole number of users from 1 to 200. |
| Labels per list page | 1 to 200 labels | limit must be a whole number of labels from 1 to 200. |
| Teams per list page | 1 to 200 teams | limit must be a whole number of teams from 1 to 200. |
| Team members per list page | 1 to 200 members | limit must be a whole number of members from 1 to 200. |
| Subtasks per list page | 1 to 200 subtasks | limit must be a whole number of subtasks from 1 to 200. |
| Linked tasks per list page | 1 to 200 linked tasks | limit must be a whole number of linked tasks from 1 to 200. |
| Followers per list page | 1 to 200 followers | limit must be a whole number of followers from 1 to 200. |
| Attachments per list page | 1 to 200 attachments | limit must be a whole number of attachments from 1 to 200. |
| Projects per list page | 1 to 200 projects | limit must be a whole number of projects from 1 to 200. |
| Tasks per inbox change | 100 tasks | tasks must name at most 100 tasks per call. Send the rest in another call. |
| Webhook subscription lifetime | 60,000 to 604,800,000 milliseconds | ttlMs must be a whole number of milliseconds from 60,000 (1 minute) to 604,800,000 (7 days), or null for no expiry. |
| Webhook subscriptions per organization | 100 subscriptions | an organization can have at most 100 unexpired webhook subscriptions, and one agent key, token or OAuth connection at most 20. Delete an unused subscription first. |
| Webhook subscriptions per agent key, token or OAuth connection | 20 subscriptions | an organization can have at most 100 unexpired webhook subscriptions, and one agent key, token or OAuth connection at most 20. Delete an unused subscription first. |
| Webhook callback URL | 2,048 characters | a callback URL must be at most 2,048 characters. Use a shorter URL. |
| Event subscription request | 16,384 characters | an event subscription request must be at most 16,384 characters. Send fewer or shorter parameters. |
| Request body | 1 MiB | a request body must be at most 1 MiB. Send less in one request. |
| Requests per person or agent | 300 requests per minute | too many requests, at most 300 a minute for one person or agent. Try again in 60 seconds. |

<!-- limits:end -->

## Endpoints

### Me

```
GET /v1/me   → who this credential acts as, its organization's settings,
               the billing pause and the credential itself
```

```json
{
  "user": {
    "id": "…uuid…", "name": "Release Bot", "org_role": "user", "kind": "agent",
    "active": true, "plannable_hours": null, "email": null
  },
  "organization": {
    "id": "…uuid…", "name": "Northstar Labs", "slug": "northstar-labs",
    "date_format": "YYYY-MM-DD", "week_start": 1, "week_one_rule": "first4day",
    "default_plannable_hours": 32, "max_attachment_mb": 20,
    "project_creators": "users", "can_create_projects": true
  },
  "billing": { "read_only": false, "reason": null },
  "credential": {
    "kind": "agent_key", "access": "write", "expires_at": null, "name": "CI key"
  }
}
```

A personal token answers its person, with `email` set, and for example
`"credential": { "kind": "personal_token", "access": "write",
"expires_at": null, "name": "Reporting script" }`.

Call it first. It tells a client who it is, how the organization's calendar
works and whether it can make changes, before it plans a request that would
be refused.

- `user` is the caller's own `GET /v1/users` row plus `email`, which is
  `null` for an agent.
- `organization` holds the settings that shape requests. `week_start` is the
  **Workdays start on** setting, `0` (Sunday) through `6` (Saturday). It is
  the first day of every planning week, so compute `start_week` and
  `end_week` from it. `week_one_rule` is **Week 1 of the year** (`first4day`, `jan1` or
  `firstfull`), `date_format` is how the app displays dates (the API always
  uses `YYYY-MM-DD`), `default_plannable_hours` is the weekly capacity a new
  person starts with, and `max_attachment_mb` is the upload limit per file
  in MiB. `slug` is the organization's part of app links such as
  `https://qivo.io/app/<slug>/tasks/qn-26`.
- `project_creators` is the **Who can create new projects?** setting:
  `admins`, `users` (the default) or `selected`. `can_create_projects` says
  whether this user may create a top-level project under it, by the same
  rule as the app's **New project** button. A Standard user agent counts as
  a standard user, and a Viewer agent never may.
- `billing.read_only` is `true` while organization billing pauses editing,
  and while the organization is read-only before its deletion. `reason` is
  then the sentence writes are refused with, which names the deletion date
  in the second case, otherwise `null`. An organization admin can still
  remove access ([Request limits and billing](#request-limits-and-billing)).
  No plan, price or usage is included. Once deletion begins, every request
  is refused with `403` and `this organization is being deleted`, also one
  with a key or token the deletion has already removed.
- `credential.access` is `write` when this credential may make changes and
  `read` when it can only read, such as a Viewer agent's key. It is the same
  rule that refuses writes (see Authentication). A write still needs Edit
  access on the project and an organization that billing does not pause.
- `credential.kind` is `agent_key` or `personal_token`, and `name` is the
  key's or token's name. `expires_at` is the instant a personal token stops
  working, or `null`. It is `null` for an agent key, which never expires, and
  for a token created to never expire.

The response never contains a secret, a hash or a display identifier.

### Projects

```
GET   /v1/projects?search=&limit=&cursor=
                                  → one page of the ACTIVE projects you
                                    can read, in tree order, with access
                                    flags
GET   /v1/projects?archived=true  → the archived ones instead (0106)
GET   /v1/projects/{id|num|KEY}   → one project you read or manage
                                    (uuid, per-org number, or key) with
                                    its lead, settings, completion,
                                    milestones and grants; an explicit
                                    ref resolves an archived project too
GET   /v1/projects/{ref}/users    → users with access to that project, for
                                    reporter, assignee and reviewer
                                    selection
POST  /v1/projects                → create a project or sub-project (write)
PATCH /v1/projects/{ref}          → change its settings or lead, archive or
                                    restore it (write)
```

A page of the list, with a top-level project and one of its
sub-projects:

```json
{
  "next_cursor": "…",
  "projects": [
    { "id": "…uuid…", "key": "SENS", "num": 1, "name": "Luma Sensor", "type": "meta",
      "parent_id": null, "team_id": null, "description": "",
      "archived": false, "archived_at": null,
      "access": { "read": true, "write": false } },
    { "id": "…uuid…", "key": "ENC", "num": 2, "name": "Enclosure", "type": "project",
      "parent_id": "…uuid…", "team_id": null, "description": "",
      "archived": false, "archived_at": null,
      "access": { "read": true, "write": true } }
  ]
}
```

`GET /v1/projects` answers one page of projects at a time, `limit` of them
at most, 50 by default and 1 to 200, as for [users](#users). The order is
the tree's: each top-level project by key, followed by its sub-projects by
key, with the ids breaking ties. Keys compare by their bytes, so digits
come before letters and a key before the longer keys it begins (`A`, `A1`,
`AB`). Pass `next_cursor` unchanged, URL-encoded, as `cursor` for the next
page, with the same `archived` and `search`, and stop when it is `null`. A
page can hold fewer than `limit` projects, or none, while `next_cursor` is
set, because each page reads a bounded amount however many projects you
reach. A short or empty page is never the end of the list. Only a `null`
`next_cursor` is. `limit` may change from one page to the next.

The active list holds every active top-level project you can see, also one
you see only because you can read one of its sub-projects, and every active
sub-project you can read. `archived=true` holds every archived top-level
project you can see, each followed by its archived sub-projects you can
read, and the archived sub-projects you can read of an active project, at
that project's place without the project's own row; their `parent_id`
names it. An organization admin's pages hold what their own leads, grants
and team shares reach, as anyone's.

`search` keeps the projects whose own name holds every whitespace-separated
word of it, in any order, ignoring case and accents, or whose key is the
whole search, ignoring case, so `search=sensor%20luma` and `search=sens`
both find Luma Sensor. A match does not bring its sub-projects along, and a
matching sub-project shows without its parent's row. The search runs over
the whole list on the server before `limit`, so it can answer short or
empty pages with a `next_cursor` before it reaches a match, and it reads no
task and no file. An empty `search` lists everything, and a `search` holds
at most 200 characters.

A cursor works only for the organization, caller, side of the archive and
search it came from, on REST and MCP alike, so a `next_cursor` from `GET
/v1/projects` continues `list_projects` on MCP. Two searches that differ
only in case or accents share their cursors. Pages are not a snapshot. A
project created, archived, restored, shared or unshared while you page, or
one whose key changes, lands where it then belongs, so a page may miss it
or show it again until you start again from the first page.

These requests are a `400`, checked in this order after any unknown query
parameter:

- `limit` that is not a whole number from 1 to 200: `limit must be a whole
  number of projects from 1 to 200.`
- `offset` other than `0`: `offset does not apply to projects; pass
  next_cursor as cursor`
- a `search` longer than 200 characters: `a search must be at most 200
  characters. Search for fewer words.`
- `archived` other than `true` or `false`: `archived must be true or false`
- a page before Qivo has prepared the organization's projects for these
  pages: `this list cannot be read until this organization's projects are
  ready; try again in a few minutes`
- a `cursor` that is not the `next_cursor` of an earlier page of the same
  list: `cursor must be the next_cursor of an earlier page`
- a caller far past the sizes Qivo is built for, whose check of which
  projects they can see stops at the fixed limits of one request: `Qivo
  could not finish checking which projects you can see in one request.
  Contact support@qivo.io so we can help.` The whole page is refused, never
  answered with a project missing.

Until November 2026 `GET /v1/projects` answered every readable project at
once, as an array in key order, and refused `search`, `limit`, `cursor`
and `offset` as unknown query parameters. Code that read the array now
finds an object; read its `projects` and follow `next_cursor` until it is
`null`.

`GET /v1/projects/{ref}` answers the same row with these fields added:

```json
{
  "lead_id": "…uuid…", "lead_name": "Leo Martins",
  "review_hours": null, "effective_review_hours": 2, "track_delay": true,
  "completion": { "status": "ok", "done": 12, "total": 30, "percent": 40 },
  "milestones": [{ "id": "…uuid…", "name": "Prototype validated", "date": "2026-11-02" }],
  "grants": {
    "users": [{ "id": "…uuid…", "name": "Emil Strand", "level": "user" }],
    "teams": [{ "id": "…uuid…", "name": "Hardware", "level": "viewer" }]
  }
}
```

- `lead_id` and `lead_name` name the project's lead. A sub-project without a
  lead of its own is led by its parent's lead.
- `review_hours` is the project's own **Review time**, or `null` when it uses
  its parent's or the 2-hour default. `effective_review_hours` is the time a
  task entering `review` gets.
- `completion` is the project's **Completion** on the app's Overview. It
  counts the active tasks without subtasks in the project, or for a
  top-level project in its sub-projects you can read that are not archived,
  and `done` counts those that are Done. A task with an active subtask in
  any project that is not archived counts as a group and is left out, as in
  the app, also when that subtask is hidden from you or sits in another
  top-level project. `percent` is rounded, and `0` when `total` is `0`. Its
  `status` is `ok`. Qivo keeps these counts as tasks change, so they hold
  whatever the project's size. For a moment after any project of the
  organization is archived, restored, moved to Deleted items or brought
  back from it, and while Qivo counts an organization again, it is
  `{"status": "counting", "done": null, "total": null, "percent": null}`,
  so ask again later. That includes a project in another top-level
  project, because older versions of Qivo let a subtask sit in another
  top-level project than its parent. A `PATCH` that restores a project
  answers its completion as `counting` too, unless it is a top-level
  project with no live sub-project you can read, which answers `ok` with
  zero counts, and one that archives a project answers `null`, as for any
  archived project. In a project with so many sub-projects that the request
  has no room left to read their counts, it is `{"status": "unavailable",
  "done": null, "total": null, "percent": null}` instead. Neither ever
  fails the read or a `PATCH`.
  `completion` is `null` for an archived project. A new project answers `ok`
  with zeros, because it holds no tasks, unless you manage it without
  reading it, such as a sub-project an organization admin creates under a
  project they only manage with someone else as its lead, which answers
  `unavailable` as described below. `status` arrived in November 2026,
  and `counting` later that month, so treat a `status` you do not know as
  no completion.
- `milestones` are the milestones of the top-level project, ordered by date.
  A sub-project shows its parent's, because milestones live on the top-level
  project's roadmap.
- `grants` are the project's own individual and team grants, as its
  **Project access** list shows them, ordered by name. A sub-project also
  inherits its parent's grants, which the parent's own read lists. Anyone who
  can read or manage the project sees its grants, as in the app.

An organization admin manages every project of the organization, also one
they take no part in. Admin status gives no access to a project's work, so
`GET /v1/projects` leaves such a project out, while `GET` and `PATCH
/v1/projects/{ref}`, the [project access](#project-access) routes and a
create's `parent` find it. The single-project read then answers its row
with `access.read` `false`, its lead, settings and grants, `completion` as
`{"status": "unavailable", "done": null, "total": null, "percent": null}`
(`null` once it is archived) and `milestones` as `null`, because
completion and milestones are planning data. The
[milestone](#milestones) routes and `GET /v1/projects/{ref}/users` need to
read the project. A project you neither read nor manage answers `404`,
exactly like an unknown one.

The writes below, and the [project access](#project-access) and
[milestone](#milestones) routes, answer `403` with the read-only sentence for
a read-only credential before any reference is resolved, like every other
write.

`num` is the durable per-org project number (migration 0050) — it never
changes. `key` is the short code the app shows. The app has no screen that
changes a key, but only numbers and uuids are guaranteed to stay the same, so
prefer them in stored configuration. Keys are unique within the organization,
archived projects included. A new project's key comes from its name, with a
number added when another project already holds it (`TES`, then `TES2`).

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
Unknown projects and projects the caller cannot read both return `404`. Use
this route when mapping identities for an import instead of guessing from the
organization-wide roster.

On a parent project the rows are the people with access to the parent
itself: its lead and its individual or team grants. These
are the people its **Project access** list shows in the app. Someone who
reaches the parent only through one of its sub-projects is listed under that
sub-project, not under the parent. A caller that sees the parent only through
one of its sub-projects may still call this route for the parent.

**Archived projects** (migration 0106) are projects that have been put away
in the app. They keep every task, comment and attachment they had, but they
are not part of the working set: they are absent from the list above unless
you ask for them, their tasks are absent from `GET /v1/tasks` unless you
name the project (see below), and a `POST /v1/tasks` into one is a 400 that
names the project to restore. `archived_at` is when it happened; `archived`
is the same fact as a boolean.

#### Creating a project or sub-project

```
POST /v1/projects  {"name": "Luma Mount", "parent": "SENS", "lead_id": "…uuid…",
                    "description": "Housing and optics"}
```

Only `name` is required. Without `parent` the request creates a top-level
project, and with `parent` (a project number, key or uuid) a sub-project
under it. Qivo picks the id, the number, the key (from the name, as in the
app) and the position in the list. The answer is the `201` single-project
read, `access` flags included.

- A top-level project follows the organization's **Who can create new
  projects?** setting, the same rule as the app's **New project** button.
  `GET /v1/me` reports it as `organization.can_create_projects`. A refusal
  names the setting, for example `only org admins and standard users can
  create projects`. A Standard user agent counts as a standard user for this
  setting, including the **Can create projects** box under `selected`. A
  Viewer agent never creates projects.
- A sub-project needs managing its parent, as its lead or an organization
  admin, whatever the setting (`requires lead access to this project` for
  someone who only reads it), and the parent must be an active top-level
  project. A parent the caller neither reads nor manages answers `400` with
  `parent project not found`, exactly like an unknown one.
- `lead_id` defaults to the caller. A lead must be an active admin, standard
  user or guest of the organization; a Viewer is refused with `a viewer cannot
  lead a project, so make them a standard user first`. Only a person may name
  someone else, so an agent leads every project it creates and is refused
  with `only people can change who has access, not agents` otherwise. An
  agent that leads projects cannot be made a Viewer until an organization
  admin hands them over, so setting it to Inactive is the way to stop it at
  once.
- A creator who names someone else as the lead of a top-level project gets
  User access to it, as in the app, so the project stays in their sight.
  That includes an organization admin, since admin status gives no access
  to a project's work.
- `name` is trimmed, may not be blank (`a project name cannot be blank`) and
  holds at most 80 characters (`a project name must be at most 80
  characters. Shorten it.`), counted as in [Limits](#limits), so most emoji
  count as two. `description` is trimmed and at most 500 characters (`a
  project description must be at most 500 characters. Shorten it.`), and
  `null` means none.
- The body takes no grants. `access` and `team_access` are refused with
  `give access one user or team at a time, under /v1/projects/{ref}/access`,
  `key` with `a project's key comes from its name and cannot be written`, and
  `parent_id` and `type` with `a project's parent is set when it is created,
  with parent`. Send `parent` to create a sub-project. Any other field the
  route does not take is refused with `400`.

#### Changing a project

```
PATCH /v1/projects/{ref}  {"name": "…", "description": "…", "review_hours": 3,
                           "track_delay": false, "lead_id": "…uuid…",
                           "archived": true, "expected": {"name": "…"}}
```

Every field is optional, and the answer is the single-project read. Changing a
project needs managing it, as its lead or an organization admin (`requires
lead access to this project` for someone who only reads it). A lead handover alone on a top-level project
follows the rule for managing its users instead, so someone who is neither an
organization admin nor its lead gets `no permission to manage users on this
project`.

- `name` and `description` follow the rules for creating.
- `review_hours` is a number of hours from 0 to 999, kept to 0.1 h, or `null`
  to use the parent's or the default again. Any other value is a `400` with
  `review hours must be a number from 0 to 999. Enter a number in that range.`
- `archived: true` archives the project, and a top-level project's active
  sub-projects with it; `archived: false` restores it, with the sub-projects
  archived along with it, and a sub-project's archived parent too (which
  needs managing the parent). Qivo archives or restores before it changes the
  other fields, so one request may restore and rename, or archive and hand
  over the lead. The archive or restore and a rename share one budget of
  2,000 sub-projects and access entries (see [Limits](#limits)) and of the
  data one change can read. A project tree past that data is a `400`
  (`this project, or the top-level project above it, has sub-projects that hold more data than one change can read, so it cannot be archived or restored at once. Shorten the longest project names or descriptions there, or delete some of those sub-projects first.`), and nothing changes. When a request that archives or
  restores and renames is refused on that budget, send the archive or
  restore and the rename as two requests, which each get the whole budget.
  A top-level project that more people have among their favorites than one
  change can update is a `400` (`more people have this project among their favorites than one change can update, so it cannot be archived, restored or renamed at once. Contact support@qivo.io so we can help.`),
  and nothing changes. One request that archives or restores and renames
  it updates each favorite once, so two requests would meet the same
  refusal.
  A project takes no archive reason, as in the app, where only
  archiving a task asks for one. A body with `archive_reason` is a `400`
  (`only tasks take an archive reason; archive a project with archived
  alone`), and nothing changes.
- `lead_id` hands over the lead. Only a person may do it; an agent is refused
  with `only people can change who has access, not agents`. The outgoing lead
  keeps User access, and the new lead's own grant goes, because the lead role
  carries their access.
- `expected` holds the values you last read of the fields the request
  changes, from `name`, `description`, `review_hours`, `track_delay` and
  `lead_id`, and the request saves nothing when someone changed one of them
  since. `lead_id` is the lead the single-project read shows. See [Refusing a
  change when a field changed since you read
  it](#refusing-a-change-when-a-field-changed-since-you-read-it).
- `key`, `access` and `team_access` are refused with the sentences `POST`
  gives them, and `parent`, `parent_id` and `type` with `a project's parent
  is set when it is created, with parent`. Any other field the route does
  not take is a `400`, and a body with nothing to change is a `400` (`no
  recognized fields to update`).

Creating, renaming, archiving and restoring a project and handing over its
lead write the app's activity rows (`created`, `renamed`, `archived`,
`restored`, `changed the lead of`), signed with the provenance described
under [Side effects and audit trail](#side-effects-and-audit-trail). Changes
to the description, review time or delay tracking write none, as in the app.
A request that renames a project and hands over its lead writes only
`renamed`. Deleting a project and inviting a guest by email stay in the app
([Stays in the app](#stays-in-the-app)).

### Project access

```
PUT    /v1/projects/{ref}/access/users/{user}  {"level": "user" | "viewer",
                                                "expected"?: {"level": …}}
DELETE /v1/projects/{ref}/access/users/{user}  [{"on_held_tasks": …}]
PUT    /v1/projects/{ref}/access/teams/{team}  {"level": "user" | "viewer",
                                                "expected"?: {"level": …}}
DELETE /v1/projects/{ref}/access/teams/{team}  [{"on_held_tasks": …}]
```

These give, change or remove one person's or one team's grant on a project
or sub-project, as the app's **Project access** list does. `{user}` and
`{team}` are uuids from `GET /v1/users` and `GET /v1/teams`; one outside the
organization answers `404` (`user not found`, `team not found`).

Only a person who is an organization admin or the project's lead may change
access. Others get `no permission to manage users on this project`, and an
agent gets `only people can change who has access, not agents`, whatever its
grants. A Viewer can only receive a `viewer` grant. The lead's access comes
with the lead role, so a grant for the lead is refused with `that user leads
this project; hand the lead to someone else first`.

`PUT` answers `{"project_id", "user" | "team": {"id", "name"}, "level",
"changed"}`; giving the level someone already has changes nothing.
`expected.level` is the level you last read for that user or team in the
project's `grants`, or `null` when the project listed no grant of their own,
and `PUT` saves nothing when it changed since (see [Refusing a change when a
field changed since you read
it](#refusing-a-change-when-a-field-changed-since-you-read-it)).

Removing access can hide open tasks from the people working on them. These
are the tasks of the project and its sub-projects that are not Done, whose
assignee, or reviewer on a task without subtasks, could see them before and
cannot after. `DELETE` takes an optional JSON body whose `on_held_tasks` decides
what happens to them:

- `"leave"` (the default, also for an empty body) removes the access and
  lists those tasks as `stranded`, or counts them in `hidden` when you
  cannot see them. They keep their assignee and reviewer.
- `"keep_as_viewer"` gives each of those people a Viewer grant on the
  project, so they keep the tasks and can read the project. They can change
  only what another grant of their own still allows, such as a sub-project
  where they have User access. Removing a person's grant that is already Viewer with this choice is
  refused, because it would change nothing.
- `{"reassign_to": "<user uuid>"}` hands every one of those tasks, in the role
  that person had, to that user, and `{"reassign_to": null}` leaves them
  unassigned. The new holder must be able to work on each task once the
  access is gone, by the usual assignee rules.

`PUT` takes only `level` and `expected`, and `DELETE` only `on_held_tasks`.
Any other field is refused with `400`, such as `unknown field
"on_held_task"; this request takes on_held_tasks`, so a misspelled choice
never falls back to `leave`.
Both check the body before the path, so a bad body is a `400` even when the
project, user or team is unknown.

The removal and its choice land together or not at all. If any task cannot
be reassigned, the access stays and nothing changes. One removal reassigns at
most 120 tasks, and fewer when the change is too large for one request.
Their followers' inbox messages arrive moments after the removal. A larger
handover is a `400` with `a removal can reassign at most 120 tasks at once,
fewer when the change is too large for one request. Keep the people as
Viewers or reassign some of the tasks first.` (without the Viewer choice when
you cannot give it) and nothing changes. Keeping people as Viewers is refused
the same way when their grants do not fit in one request, with `a removal can
keep only as many people as Viewers as fit in one request, so remove some of
these people first or reassign the tasks`. A team's removal that keeps people
as Viewers or reassigns their tasks is a `400` when more than 700 of its
members hold open tasks in those projects, with
`a removal that keeps people as Viewers or reassigns their tasks can take
access from at most 700 people with open tasks at once. Leave the tasks
with them, or remove some of the team's members first.` Leaving the tasks has no such number. Any removal whose
people and tasks are too many to check in one request is a `400` with
`a removal can check only as many people and tasks as fit in one request, so
remove fewer people at once, such as some of a team's members, or reassign
some of the tasks first`. Nothing changes after either refusal. The answer is
`{"project_id", "user" | "team", "removed", "stranded", "kept_as_viewer",
"reassigned", "hidden"}`, where `stranded` and `reassigned` list `{"id",
"key", "title", "user_id", "role"}` for the tasks you can see once the
access is gone, `hidden` is `{"tasks", "user_ids"}`, the number of the
other tasks and the uuids of the people who held them, with no task id,
key or title, and `kept_as_viewer` the user uuids given a Viewer grant. An
organization admin who manages a project without reading it, or anyone who
removes their own access, gets those tasks in `hidden`. Removing access
that is not there answers `removed: false`.
Every change writes one `changed access on` activity row.

```sh
# give Emil User on the PCB sub-project, then take it away and hand his
# open tasks there to Leo
curl -X PUT -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"level":"user"}' "$BASE/projects/PCB/access/users/<Emil's uuid>"
curl -X DELETE -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"on_held_tasks":{"reassign_to":"<Leo's uuid>"}}' \
  "$BASE/projects/PCB/access/users/<Emil's uuid>"
```

### Milestones

```
POST   /v1/projects/{ref}/milestones       {"name": "…", "date": "2026-11-02"}
PATCH  /v1/projects/{ref}/milestones/{id}  {"name"?, "date"?, "expected"?}
DELETE /v1/projects/{ref}/milestones/{id}  [{"expected": {"name"?, "date"?}}]
```

Milestones live on a top-level project's roadmap. Naming a sub-project in
`{ref}` adds the milestone to its top-level project, as the app does, and a
milestone id must belong to the top-level project of `{ref}`, else `404`
`milestone not found`. Writing a milestone needs Edit (`user`) access on the
top-level project, so a grant on a sub-project alone is refused with `no
write access to this project`. An archived project takes no new milestones
(`that project is archived, so restore it first`).

`date` is a real calendar day as `YYYY-MM-DD` (`date must be YYYY-MM-DD`,
`date must be a valid calendar date`), usually the first day of a planning
week. `name` is trimmed, may not be blank (`a milestone name cannot be
blank`) and holds at most 80 characters (`a milestone name must be at most
80 characters. Shorten it.`).

A top-level project holds at most one milestone in each calendar week of
its organization, whose weeks begin on the organization's first day of the
week, and a milestone named on a sub-project counts for its top-level
project. A `POST`, or a `PATCH` that changes `date`, into a week that
already holds another of the project's milestones is a `400` that names the
week and that milestone, such as `this project already has the milestone
“Launch” in the week of 2026-11-02 (W45), and a project can have at most 1
milestone a week. Pick another week, or move that milestone first.`, in the
organization's date format, and changes nothing. A `PATCH` that only
renames a milestone is not refused, and neither is one that moves it within
its own week, unless another milestone stored before the rule shares that
week. Two
requests that claim the same week at the same time cannot both succeed.
Different projects can each have a milestone in the same week. `POST` answers `201` and `PATCH` `200` with
`{"id", "name", "date", "project_id"}`, where `project_id` is the top-level project;
`DELETE` answers `{"deleted": true, "id"}`.
`GET /v1/projects/{ref}` lists them. Each write narrates `added milestone`,
`renamed milestone`, `moved milestone` or `deleted milestone`. A `PATCH` that
changes neither the name nor the date writes no row.

`PATCH` takes an optional `expected` with the `name` and `date` you last read
of the fields it changes. `DELETE` takes an optional JSON body
`{"expected": {…}}` with either or both, because a deleted milestone cannot
be restored. An empty body still deletes without a check. Either request
saves nothing when someone changed one of those fields since (see [Refusing a
change when a field changed since you read
it](#refusing-a-change-when-a-field-changed-since-you-read-it)). `POST`
takes no `expected`, and refuses it with `expected applies only when
changing an existing milestone`.

### Teams

```
GET    /v1/teams?search=&limit=&cursor=               → one page of teams, with member counts
GET    /v1/teams/{id}                                 → one team
GET    /v1/teams/{id}/members?search=&limit=&cursor=  → one page of the team's members
POST   /v1/teams                                      {"name": "…"}
PATCH  /v1/teams/{id}                                 {"name": "…", "expected"?: {"name": "…"}}
PUT    /v1/teams/{id}/members/{user}                  [{"leader": true | false}]
DELETE /v1/teams/{id}/members/{user}                  [{"on_held_tasks": …}]
```

A team is `{"id", "name", "member_count"}` in the list, in `GET
/v1/teams/{id}` and in the answers of `POST` and `PATCH`, and no answer
embeds its members. `member_count` is the number of its members, as the
member list counts them: people and agents, inactive ones included. It is
`null` for a moment while Qivo counts the team, never `0` for a count it
does not have, so do not read `null` as an empty team. Right after someone
is removed from the organization, the count can still include them for a
moment while the member list no longer does, until Qivo has finished
removing their memberships. Everyone in the organization reads every team
and its members, guests and Viewers included, as in the app. Teams are
named by uuid only, because two teams may share a name. An unknown uuid,
one from another organization or text that is no uuid answers `404` `team
not found`, and a `{user}` outside the organization answers `404` `user not
found`.

```json
{
  "next_cursor": "…",
  "teams": [{ "id": "…uuid…", "name": "Hardware", "member_count": 4 }]
}
```

`GET /v1/teams` answers one page of teams at a time, in name order,
ignoring case and accents, then by id. Paging, `search` and the refusals
work as for [users](#users), with `limit must be a whole number of teams
from 1 to 200.` and `offset does not apply to teams; pass next_cursor as
cursor`.

```json
{
  "next_cursor": "…",
  "team": { "id": "…uuid…", "name": "Hardware", "member_count": 4 },
  "members": [
    { "id": "…uuid…", "name": "Leo Martins", "leader": true },
    { "id": "…uuid…", "name": "Release Bot", "leader": false }
  ]
}
```

`GET /v1/teams/{id}/members` answers one page of the team's members at a
time, each `{"id", "name", "leader"}`, with the team as `GET
/v1/teams/{id}` answers it on every page. `leader` is `true` for a person
who leads the team. Only people with the organization admin or Standard
user role lead teams, so an agent or a Viewer never reads `true`. A guest
is never a member, so an old membership a guest still holds is neither
listed nor counted. Members come in name order, ignoring case and accents,
then by id. `search` keeps the members whose name holds every word of it,
within this team only, and `member_count` stays the whole team's. A member
renamed a moment ago can sort and match by the earlier name for a moment,
so a search by the new name can miss them until then; their `name` is
always the current one. Paging and the refusals work as for
[users](#users), with `limit must be a whole number of members from 1 to
200.` and `offset does not apply to team members; pass next_cursor as
cursor`, and a cursor works only for the team it came from. The paging is
checked before the team, so a wrong `limit` is a `400` even for a team that
does not exist. A member missing from one page you hold is not removed from
the team; follow `next_cursor` until it is `null`.

Until November 2026 `GET /v1/teams` answered every team at once, as an
array, and every team answer, `GET /v1/teams/{id}`, `POST` and `PATCH`
included, embedded the team's whole `members` array and no `member_count`.
`search`, `limit`, `cursor` and `offset` were unknown parameters, and `GET
/v1/teams/{id}/members` was an unknown route. Code that read the array now
finds an object, and code that read a team's `members` finds them missing;
read `teams` and `GET /v1/teams/{id}/members`, and follow `next_cursor`
until it is `null`.

Only organization admins create teams; anyone else gets `only organization
admins can create teams`. An organization admin or a leader of the team
renames it with `PATCH`, and anyone else gets `requires an organization admin
or a leader of this team`. `name` is trimmed and may not be blank (`a team
name cannot be blank`) or longer than 80 characters (`a team name must be at
most 80 characters. Shorten it.`). `PATCH` changes only `name`, and its
optional `expected` holds the `name` you last read, so the rename saves nothing when
someone renamed the team since (see [Refusing a change when a field changed
since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it)).
Any other field is a `400` (`unknown field "nmae"; this request takes name,
expected`), and a body without `name`, such as `{}`, is a `400` (`no
recognized fields to update`). Deleting a team stays in
the app ([Stays in the app](#stays-in-the-app)). `POST` answers `201` and
`PATCH` `200` with the team as `{"id", "name", "member_count"}`, and a new
team's `member_count` is `0`. Neither writes an activity row, as in the
app.

Members decide who sees the projects shared with the team, so changing them
needs a person who is an organization admin or a leader of the team. An agent
is refused with `only people can change who has access, not agents`, whatever
its role. `PUT` adds the user as a plain member when they are not one yet,
and `leader` makes or unmakes them a leader. A guest is never a member (`a
guest is never a team member`). Making an agent or a Viewer a leader is
refused (`an agent cannot lead a team`, `a viewer is never a team leader`),
and then nobody is added. `PUT` answers `{"team_id", "user": {"id", "name"},
"leader", "changed"}`; a call that changes nothing answers `changed: false`.

`DELETE` removes the member, leadership included. Their open tasks in the
projects the team shares, and in those projects' sub-projects, that they can
no longer see afterwards are settled by `on_held_tasks`, as for [project
access](#project-access):

- `"leave"` (the default, also for an empty body) lists them as `stranded`,
  or counts them in `hidden` when you cannot see them.
- `"keep_as_viewer"` gives the person a Viewer grant on the project the team
  shared that showed each task, which is the task's own sub-project when the
  team shares it and otherwise its top-level project. This needs the right to manage that
  project's users (an organization admin or its lead), so a team leader
  without it is refused with `no permission to manage users on this project`
  and can still leave the tasks.
- `{"reassign_to": "<user uuid>"}` or `{"reassign_to": null}` hands the tasks
  over, by the usual assignee rules.

`PUT` takes only `leader` and `DELETE` only `on_held_tasks`, as for project
access. Any other field is refused with `400`, such as `unknown field
"leadr"; this request takes leader`, and the request changes nothing. As for
project access, the body is checked before the team and user.

The removal and its choice land together or not at all. One removal
reassigns at most 120 tasks, and fewer when the change is too large for one
request. Their followers' inbox messages arrive moments after the removal. A
larger handover, or Viewer grants too many for one request, is a `400` and
nothing changes.
The answer is
`{"team_id", "user", "removed", "stranded", "kept_as_viewer",
"reassigned", "hidden"}`, shaped as for project access, so the tasks in
projects you cannot see count in `hidden`; removing someone who is not a
member answers `removed: false`. Each change writes the app's activity row
(`added`, `removed`, `made` a leader, `demoted`), signed as described under
[Side effects and audit trail](#side-effects-and-audit-trail), and a Viewer
grant also writes `changed access on` for its project.

```sh
# make Leo a leader of the team, then remove Emil and hand his open tasks to Leo
curl -X PUT -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"leader":true}' "$BASE/teams/<team uuid>/members/<Leo's uuid>"
curl -X DELETE -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"on_held_tasks":{"reassign_to":"<Leo's uuid>"}}' \
  "$BASE/teams/<team uuid>/members/<Emil's uuid>"
```

### Users

```
GET   /v1/users?search=&limit=&cursor=  → one page of the organization's users, people and agents alike
GET   /v1/users/{id}                    → one of them, read directly
PATCH /v1/users/{id}                    → set that person's plannable_hours (write)
```

A page with two rows, a person and an agent:

```json
{
  "next_cursor": "…",
  "users": [
    { "id": "…uuid…", "name": "Priya Patel",
      "org_role": "user", "kind": "person", "active": true, "plannable_hours": 31 },
    { "id": "…uuid…", "name": "Release Bot",
      "org_role": "viewer", "kind": "agent", "active": true, "plannable_hours": null }
  ]
}
```

`GET /v1/users` answers one page of users at a time, `limit` of them at
most, 50 by default and 1 to 200. Every user of the organization is on it:
people and agents, inactive people, Viewers, guests and seats not yet
claimed. Users come in name order, ignoring case and accents, then by id,
and that order compares names by their UTF-8 bytes, so it differs from a
browser's sort for some scripts. Pass `next_cursor` unchanged, URL-encoded,
as `cursor` for the next page, with the same `search`, and stop when it is
`null`. A page can hold fewer than `limit` users, or none, while
`next_cursor` is set, because each page reads a bounded amount however large
the organization is. A short or empty page is never the end of the list.
Only a `null` `next_cursor` is. `limit` may change from one page to the
next.

`search` keeps the users whose name holds every whitespace-separated word of
it, in any order, ignoring case and accents, so `search=lee%20sam` finds Sam
Lee and `search=zoe` finds Zoë. It runs over the whole list on the server
before `limit`, so a search that matches few users can answer short or
empty pages with a `next_cursor` before it reaches them. An empty `search`
lists everyone, and a `search` holds at most 200 characters.

A cursor works only for the organization, caller and search it came from,
on REST and MCP alike, so a `next_cursor` from `GET /v1/users` continues
`list_users` on MCP. A changed search starts a new list, from the first
page, but two searches that differ only in case or accents, such as `Café`
and `cafe`, share their cursors. Pages are not a snapshot. A user added or
renamed while you page lands where their name puts them, so a page may miss
them or show them again. A user missing from the pages you have read is not
gone until `next_cursor` is `null`; to check one user, read `GET
/v1/users/{id}`.

These requests are a `400`, checked in this order after any unknown query
parameter:

- `limit` that is not a whole number from 1 to 200: `limit must be a whole
  number of users from 1 to 200.`
- `offset` other than `0`: `offset does not apply to users; pass
  next_cursor as cursor`
- a `search` longer than 200 characters: `a search must be at most 200
  characters. Search for fewer words.`
- a page before Qivo has prepared the organization's names for name order:
  `this list cannot be read until this organization's names are ready; try
  again in a few minutes`
- a `cursor` that is not the `next_cursor` of an earlier page of the same
  list: `cursor must be the next_cursor of an earlier page`

`GET /v1/users/{id}` reads that one user directly, by a uuid in any case,
however large the organization is. An unknown id, one from another
organization and text that is no uuid all answer `404` `user not found`.

Until November 2026 `GET /v1/users` answered every user at once, as an
array sorted with a locale-aware comparison, and `search`, `limit`,
`cursor` and `offset` were unknown parameters. Code that read the array now
finds an object; read its `users` and follow `next_cursor` until it is
`null`.

`kind` is `"person"` or `"agent"`; an agent finds *itself* in this list,
and `GET /v1/me` answers its own row directly. `org_role` is the
**organization** role, `"admin"`, `"user"`, `"viewer"` or `"guest"`, and never
a project role. What someone holds on a given project is that project's
`access` flags.

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
{ "error": "user \"<uuid>\" is a viewer, who reads the projects they are added to and is never assigned work" }
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

Existing assignments survive a downgrade to View, an organization Viewer
role or a switched-off account; updates that omit `assignee_id` preserve them.
Sending the task's current `assignee_id` again is not a change and passes
even when that person is no longer eligible, as in the app. Any other non-null
`assignee_id` requires current eligibility. Reviewers follow the same rules.
Moving a task in the app checks its assignee and its reviewer against the
destination project, except that a task with
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
across every project they work on, not only the ones this credential can
see. It belongs to the person, not to their team (migration 0092); a newly
added user starts on the organization's default and carries their own value
from then on.

It is **`null` for an agent** (migration 0103), which has no plannable week at
all: an agent is not in the meetings, does not sleep, and can be given a second
task without giving the first one back. Its capacity is treated as unbounded —
its work is never stretched to fit a calendar and it is never over capacity.
Do **not** read that `null` as `0`, which would say the opposite ("nothing left
this week"); branch on it. Unbounded is not literally true of a real agent —
there are rate limits, a budget, a queue — but none of those is a weekly hour
count, and the invented number was worse: an agent handed the org default was
shown at 150% loaded and its work spread over weeks it did not need.

The `/v1/users` roster is **organization-scoped, not project-scoped**: a
caller sees every user of the organization it belongs to, whatever its project
roles say — useful for general identity lookup, but not proof that a user may
be written onto a task. `GET /v1/projects/{ref}/users` is the project-scoped
subset and the authoritative reporter, assignee and reviewer picker.

**Setting plannable hours.** `PATCH /v1/users/{id}` with
`{ "plannable_hours": 32 }` sets that person's weekly capacity and answers
their updated row. It is the one user field the API changes. An optional
`expected` holds the `plannable_hours` you last read, so the request saves
nothing when someone changed them since (see [Refusing a change when a field
changed since you read
it](#refusing-a-change-when-a-field-changed-since-you-read-it)). Any other
field is a `400` (`unknown field "name"; this request takes plannable_hours,
expected`), and a body without `plannable_hours`, such as `{}`, is a `400`
(`no recognized fields to update`). The value is a whole number from 1 to 168, otherwise a
`400` with `plannable hours per week must be a whole number of hours from 1
to 168.`
Like the app and MCP's `update_user`, it takes an organization admin or a
leader of a team the person belongs to (migration 0094), and nobody else,
yourself included. Anyone else gets `403` with `only an organization admin
or a leader of one of this person's teams can set their plannable hours`,
whoever the target is. Qivo checks a team leader against at most 256 of the
person's teams in one request, so a leader setting the hours of a person in
more teams gets `400` with `Qivo could not finish checking this person's
teams in one request. Ask an organization admin to change these hours.` An
organization admin is not refused this way.
An unknown or foreign id is `404` `user not found`.
An agent has no plannable week (0103), so naming one is a `400` with `an
agent has no plannable week, because its capacity is unbounded`. The change writes
no activity row, as in the app.

In practice this route needs a person's token. An agent is **never an
organization admin**, because an admin manages every project without a
grant, the one thing a key must not be able to do if it leaks. The profile
shape refuses it (0100, widened by 0102 to admit `viewer` and nothing else).
It never leads a team either, because only people lead teams. A leaked agent
key therefore cannot set anyone's capacity. `POST` on these routes is 404.

### Tasks

Task references are **permanent**: `QN-482` (any case), bare `482`, or the
task uuid. Task numbers are org-scoped (one counter per organization, 0050),
assigned at creation and immutable — a reference survives moves between
sub-projects and any project rename. The `QN` prefix is a fixed product
constant, not data.

```
GET    /v1/tasks                           active tasks across all readable
                                           projects that are not archived (0106)
GET    /v1/tasks?project=ENC                scoped to a project (uuid, number
                                           or key; a meta expands to its
                                           sub-projects). Naming an ARCHIVED
                                           project is how you read its tasks
       &status=todo &priority=high         enum filters; status takes several
                                           values separated by commas
                                           (status=todo,progress)
       &assignee=<profile-uuid>            the stored assignee, also while
                                           a reviewer owns the task
       &owner=<profile-uuid>               whose work it is, the reviewer
                                           while the task is in review with
                                           one, else the assignee
       &search=text                        matches fragments of the fields the
                                           app's task filter searches (below;
                                           substring; * acts as a wildcard),
                                           at most 200 characters
       &archived=true                      the ARCHIVED tasks instead (0070),
                                           one project at a time. It needs
                                           `project=` and answers a page
                                           (see Archived tasks below). The
                                           default lists active ones only.
                                           A task's archive and its PROJECT's
                                           are different axes. This flag is
                                           the first, `project=` the second
       &limit=50                           limit 1 to 200, 50 by default
       &offset=0                           refused unless 0; page with cursor
       &cursor=<next_cursor>               the next page, of active and
                                           archived tasks alike
GET    /v1/tasks/{ref}                     ref: QN-482 | 482 | uuid — resolves
                                           archived tasks too; adds labels and
                                           the first 50 of its subtasks,
                                           links, followers and attachments,
                                           each with a cursor (below)
GET    /v1/tasks/{ref}/subtasks            a page of its subtasks, by number
GET    /v1/tasks/{ref}/links               a page of its links
GET    /v1/tasks/{ref}/followers           a page of its followers, by name
GET    /v1/tasks/{ref}/attachments         a page of its files, oldest first
       ?limit=50                           limit 1 to 200, 50 by default
       &offset=0                           refused unless 0; page with cursor
       &cursor=<next_cursor>               the next page of that list
POST   /v1/tasks                           requires write on the target
                                           sub-project (see below)
PATCH  /v1/tasks/{ref}                     requires write; also moves the
                                           task, sets its parent and adds or
                                           removes labels; `expected` refuses
                                           it when a field it changes changed
                                           since you read it
DELETE /v1/tasks/{ref}                     requires write; moves the task
                                           to Deleted items (below)
```

Search is case-insensitive: every whitespace-separated fragment must match the
task ID (`QN-<num>`), title, description, status name (`To Do`, `In
Progress` and so on, except on a task with subtasks, whose own status is
dormant), priority name, assignee name or a label name, in any order and
anywhere inside a word. These are the fields the app's task filter searches.
`search=upd%20firm` finds “Add signed firmware updates and rollback”, and
`search=in%20progress%20anna` finds Anna's tasks in progress.
Explicit `*` wildcards within fragments remain supported; other punctuation is
literal. A `search` holds at most 200 characters, on active and archived
lists alike, and a longer one is a `400` with `a search must be at most 200
characters. Search for fewer words.` A search of active tasks reads, in list
order, the label names of the tasks their other fields do not match, then
the descriptions of those their labels do not match either. It reads a
task's labels only when one of the organization's label names contains a
fragment of the search, or a part of one between `*` wildcards, or when the
organization has more than 1,000 labels. It goes on across pages like any
list, so a search that matches few tasks, such as one by task ID, may answer
several short or empty pages with a `next_cursor` before it finds them.

Active lists answer an object, the cursor first:

```json
{
  "next_cursor": "…",
  "tasks": [{ "id": "…uuid…", "key": "QN-3", "archived": false, "…": "…" }]
}
```

Tasks come in creation order (`created_at`), oldest first, with tasks
created at the same moment ordered by number. MCP's `list_tasks` uses the
same order. Pass `next_cursor` unchanged, URL-encoded like any query value,
as `cursor` for the next page, and stop when it is `null`. A page can hold
fewer than `limit` tasks, or none, while `next_cursor` is set, because each
page reads a bounded amount however large the organization is. A short or
empty page is never the end of the list. Only a `null` `next_cursor` is.
`limit` may change from one page to the next. Each row's `description`
reads the task's description and its `last_comment_at` the task's newest
comment, and a row whose parent is not on the page reads that parent. A
row whose reads do not fit in the rest of a page ends the page
before it, and the next page starts with it. The first task a page looks at
always answers, so paging moves on. If it is an active group stored before
the rule of one level of subtasks, with more tasks under it than the page
can read, its row has `start_week` and `end_week` set to `null` and a
`progress` of `0` of `0` with `partial: true`, as a single task's read
describes below.

A cursor works only for the organization, caller, project, filters and
search it came from, whether you name the project by uuid, number or key. A
changed filter or search starts a new list, from the first page. A cursor
from `GET /v1/tasks` does not continue a `list_tasks` list on MCP,
even with the same search, because a `*` in a REST search widens it and on
MCP it stays literal.

Pages are not a snapshot. A task created while you page lands at the end of
the list. A task restored from Deleted items or from the archive keeps its
creation time, so once you have paged past that time you miss it until you
start again from the first page. So does a task of a project you gain
access to while you page.

A page reads only the projects the list covers, side by side, and never
tasks of projects you cannot read. In a very large organization a list can
be refused when the request has no room for a page beside your projects and
access, or when the list covers more projects than one page can open side
by side. If the list covers too many projects, name a project to list one
project's tasks instead.

A `limit` that is not a whole number from 1 to 200 is a `400` with `limit
must be a whole number of tasks from 1 to 200.` Until October 2026 a list
without `limit` held up to 100 tasks, and Qivo moved a `limit` or `offset`
out of range into it, so `limit=500` answered 200 tasks and `limit=0`
answered 100. A `search` longer than 200 characters gets its sentence,
above, before the cursor or the page is read. These requests to an active
list are a `400`:

- `offset` other than `0`: `offset does not apply to active tasks; pass
  next_cursor as cursor`
- a `cursor` that is not the `next_cursor` of an earlier page of the same
  list: `cursor must be the next_cursor of an earlier page`
- a list too large to read, as above, for either cause: `the task list
  could not be read within the request's limits; pass project to list one
  project's tasks`. Naming a project helps only when the list covers too
  many projects.

Until November 2026 active lists answered an array paged with `offset`, a
`cursor` without `archived=true` was a `400`, and every request read the
active tasks of the organization's active projects.

#### Archived tasks

`archived=true` lists archived tasks one project at a time and needs
`project`. Naming a project lists its archived tasks and those of all its
sub-projects you can read, archived sub-projects included. The app's Archived
tasks page leaves out a sub-project archived on its own. Tasks come most
recently archived first, and tasks archived at the same moment keep one fixed
order across pages. The answer is the same object as an active list's,
with the same rows:

```json
{
  "next_cursor": "2~9c41e07a…",
  "tasks": [{ "id": "…uuid…", "key": "QN-3", "archived": true, "…": "…" }]
}
```

Pass `next_cursor` unchanged, URL-encoded like any query value, as `cursor`
for the next page, and stop when it is `null`. The cursor is encrypted and has
no readable parts. Older cursors that start with `1~` are refused, so start
again from the first page. A page can hold fewer than `limit` tasks, or none,
while `next_cursor` is set, because each page reads a bounded amount however
large the archive is. Tasks archived after you start paging appear at the
start of the list, so start again to see them. If an archived group has more
tasks under it than one request can read, such as thousands of subtasks, its
row has `start_week` and `end_week` set to `null` and a `progress` of `0` of
`0` with `partial: true`, so paging still moves past it.

To find every archived task you can read, take two steps. First page
projects with `GET /v1/projects` and `GET /v1/projects?archived=true`,
each until its `next_cursor` is `null`.
Archived tasks can sit in active projects as well as archived ones, and both
lists include sub-projects. Then page `archived=true` for each top-level
project, the rows whose `parent_id` is `null`. Each covers all its
sub-projects you can read, even when you can read only some of them. To read
one sub-project's archive alone, name that sub-project.

A page reads only the projects it lists, side by side, and never tasks of
projects you cannot read. A project with more than 200 projects to list,
itself and its sub-projects you can read, is refused, for an organization
admin as for anyone. Name its sub-projects one at a time instead.

These requests are a `400`:

- `archived=true` without `project`: `archived=true needs project, because
  archived tasks are listed one project at a time`
- `offset` other than `0` with `archived=true`: `offset does not apply to
  archived tasks; pass next_cursor as cursor`
- a `cursor` that is not a `next_cursor`: `cursor must be the next_cursor of
  an earlier page`
- a project too wide to list together, as above: `this project has too many
  sub-projects to list their archived tasks together; name one of its
  sub-projects`

Until October 2026, `archived=true` listed the archived tasks of every
readable project as an array paged with `offset`, and read the
organization's whole archive on every request.


POST body — `project` (uuid, number or key) and `title` are required. Tasks live in
sub-projects: name the sub-project directly as `project`, or name the project
as `project` and one of **its** sub-projects as `sub_project`. Naming a
project without a `sub_project` is a `400` listing the sub-projects the caller
can write to; a `sub_project` that belongs to a different project is a `400`.
A task is never created under another project's sub-project; a PATCH can
move it later (below). A `project` or `sub_project`
the caller cannot read answers exactly like an unknown one, with `400`
`project must name a project by uuid, number or key` or `sub_project must name
a sub-project by key, number or uuid`. This includes the other sub-projects of
a parent the caller sees only because it can access one of its sub-projects,
and the `400` for a project named without `sub_project` lists and counts only
sub-projects the caller can read:

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
  "parent": "QN-482",
  "start_week": "2026-07-06", "end_week": "2026-07-20",
  "due_date": "2026-07-24",
  "remaining_hours": 8,
  "paused": false
}
```

`parent` makes the new task a subtask of another task, named by key, number
or uuid. A POST that sends `parent_id` or `project_id` instead is refused
(see PATCH below). The caller must be able to read the parent and needs Edit
access on the parent's project, because the parent becomes a group and
loses its own remaining hours. A parent the caller cannot read answers `400` with `parent
task not found`; one it can read but not edit answers `403` with `no write
access to the parent task`. The new task's project still comes from
`project` and `sub_project`. A subtask may live in another sub-project than
its parent, but not in another top-level project. Such a parent answers
`400` with `a subtask must be in the same project as its parent task, in any
of its sub-projects`. A task has one level of subtasks, at most 100 active
ones; archived subtasks do not count. A parent that is a subtask itself
answers `400` with `the parent task is a subtask, and a subtask cannot have
subtasks of its own`, and a parent with 100 active subtasks `400` with `the
parent task already has 100 active subtasks, the most a task can have.
Archive or remove one of them first.`

Tasks have Reporter, Assignee and Reviewer. The reporter identifies the Qivo
user who reported the work and is fixed when the task is created. Omitting
`reporter_id` on POST defaults it to the authenticated user. To attribute an
import to another user, supply an existing Qivo profile returned by
`GET /v1/projects/{destination}/users`; `null` is not accepted. The browser
always uses its signed-in user and never offers a reporter picker.

The selected reporter must have access to the destination project. It may
be inactive or an organization viewer because reporting is attribution rather
than workload. A non-null `assignee_id` must name a row from the same route
whose `assignable` flag is true. On a subtask, a new assignee or reviewer
must also be able to see every task above it; otherwise the request is a
`400` with `a subtask can only be assigned to someone who can see every task
above it` (or `… reviewed by …` for `reviewer_id`). `assignable` does not
check this, because it describes the project, not the task. Thus neither field can point at a source-system-only identity or a Qivo
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

PATCH accepts the same fields except `reporter_id`. Any PATCH containing
`reporter_id`, including `null` or the current reporter, returns `400` with
`reporter_id is set when a task is created and cannot be changed`; other
fields in that request also remain unchanged. `project_id` and `parent_id`
are response fields. POST and PATCH both refuse a body that sends either
with `400` (`project_id cannot be written; move a task with project and
sub_project` or `parent_id cannot be written; send parent, or null to
detach`) rather than ignore it, and nothing is created or changed.
Any other field the route does not take is refused with `400`, so a
misspelled `parent` cannot create a top-level task; invalid values are
rejected with `400` and a message.

PATCH also takes `expected`, the values you last read of the fields the
request changes, keyed as a read names them. The keys are `title`,
`description`, `status`, `priority`, `assignee_id`, `reviewer_id`, `start_week`,
`end_week`, `due_date`, `remaining_hours`, `paused`, `parent_id` with
`has_hidden_parent` for `parent`, and `project_id` for a move. When someone
changed one of them since, the PATCH is a `409` and nothing changes. See
[Refusing a change when a field changed since you read
it](#refusing-a-change-when-a-field-changed-since-you-read-it). POST takes no
`expected`, and refuses it with `expected applies only when changing an
existing task`.

**Moving a task.** `project` and `sub_project` on PATCH move the task, named
exactly as on POST. Name the destination sub-project directly as `project`, or
its project as `project` and the sub-project as `sub_project`. `sub_project`
without `project` is a `400`. The move follows the app's Move dialog. The
caller needs Edit access on both the current and the destination sub-project;
a readable destination it cannot write answers `403`, and one it cannot read
answers like an unknown one. An archived destination is a `400`. The task's
assignee, and the reviewer of a task without subtasks, must be able to work in
the destination, and everyone assigned to or reviewing its active subtasks
must be able to see it; otherwise the PATCH is a `400` and nothing changes. A
group's own reviewer who cannot work there is cleared. An `assignee_id` or
`reviewer_id` in the same PATCH, `null` included, takes the place of the
current one in this check, and a new one is checked against the destination.
A moved task keeps its number, its labels, its links and its subtasks.
Naming the current sub-project changes nothing.

A move within the task's top-level project moves only the task. A move to a
sub-project of another top-level project also moves every subtask,
archived ones included, that is not already in that top-level
project. The caller needs Edit access on each of their projects (otherwise
`400`, `moving this task would move a subtask in a project you cannot edit;
someone who can edit that project can move it`). A subtask in a project that is being
moved to Deleted items refuses the move for everyone, admins included, with
`400` `a subtask of this task is being moved to Deleted items; try again
when that finishes`. The assignee and the reviewer of
each active subtask must be able to work in the
destination (otherwise `400`, `someone assigned to or reviewing a subtask of
this task cannot edit that sub-project; give them Edit access there, or
change who works on that subtask first`); a group's own reviewer who cannot
is cleared. A task with more than 200 subtasks, archived ones included,
cannot move to another top-level project (otherwise `400`, `this task has
more than 200 subtasks, archived ones included, and a move to another
project carries them all. Restore some archived subtasks and remove them
from this task first, or move it within its project.`). A move whose task and subtasks are
too large for one request is a `400` with `this task and its subtasks are
too large to move to another project in one request; remove some subtasks
from this task first, restoring archived ones to do so, or move it within
its project`. A task with 200 subtasks, archived ones included, moves in
one request when their titles and descriptions are of ordinary length.
Long descriptions on many of them can make a smaller family too large. A
REST move reaches that point sooner than the same move through MCP or the
app, because its answer reads the active subtasks again. Any other
change whose task and subtasks are too
large for one request, such as an archive, a new parent or a restore, is a
`400` with `this task and its subtasks are too large to change in one
request; detach some subtasks first`. Each moved subtask
sends `task.updated`, but only the task itself gets an activity row and an
inbox message. A subtask moved to
another top-level project must leave its parent in the same request, with
`parent: null` or a new parent in the destination's top-level project;
otherwise the PATCH is a `400` with `a subtask stays in its parent task's
project; to move it to another project, detach it from its parent in the
same change`. A parent in a project you cannot see counts as being in the
subtask's own top-level project, so moving such a subtask to another
top-level project also needs `parent: null` or a new parent there.

**Parent.** `parent` sets the task's parent, named by key, number or uuid,
and `null` detaches it. The rules are those of `parent` on POST, against
the task's project after any move in the same PATCH. Setting the
parent to the task itself is a `400`, and so is a parent that is archived
while the task is active. A task with subtasks, archived ones included,
cannot get a parent: `400` with `this task has subtasks, so it cannot become
a subtask; a subtask cannot have subtasks of its own`. `null` always
detaches. A new parent must be
visible to the task's assignee and reviewer and to everyone working on its
subtasks. An `assignee_id` or `reviewer_id` in the same PATCH, `null`
included, counts in place of the current one.

**Labels.** `add_labels` and `remove_labels` are arrays of label ids or
names (any case) from `GET /v1/labels`. A task's labels change one label at
a time, never as a replacement list. Adding a label the task already has, or
removing one it does not have, changes nothing. An unknown label is a `400`
(`label "<ref>" not found`), and so is a label in both lists. A task carries
at most 20 labels. `remove_labels` applies before `add_labels`, so one PATCH
can swap labels on a full task, and a label past 20 is a `400` (`this task
already has 20 labels, the most a task can have. Remove one first.`) that
changes nothing.

**Order.** One PATCH may combine all of this. It applies the move first,
then the parent, then the other fields with the archive toggle, then the
labels, and finally posts `archive_reason`. All of it lands or none of it
does. Each step that changes something writes its own activity row, and a
PATCH that changes nothing writes none. `title` is trimmed and holds at most
255 characters (a longer one is a `400`, `a task title must be at most 255
characters. Shorten it.`; the same shared rule holds in the app and over
MCP). `description` is markdown, trimmed, of at most 20,000 characters, on
POST and PATCH (a longer one is a `400`, `a task description must be at most
20,000 characters. Formatting counts too. Shorten it.`). Characters are
counted as in [Limits](#limits), so most emoji count as two. Until October
2026 a title held at most 80 characters, counted as Unicode code points, and
a description was stored untrimmed. `status` ∈ backlog · todo · progress ·
review · done; `priority` ∈ urgent · high · medium · low. `paused` (a
boolean) holds the work. Only a To Do, In Progress or In Review task can be
paused. Asking for it on a Done or Backlog task, on POST or PATCH, is a
`400` (`a Done or Backlog task cannot be paused`), and a status move to
either of those resumes the task. A task with subtasks holds no work of its
own, so `paused: true` on one is a `400` (`a task with subtasks cannot be
paused; pause its subtasks instead`); `false` clears a stored flag. The
reason belongs in a comment; the flag carries no text. `start_week`, `end_week` and `due_date` must be real calendar
dates in `YYYY-MM-DD` form, or `null` to clear; impossible dates are refused
instead of rolling into the next month. `start_week` and
`end_week` must be set (or cleared) together, with `start_week` ≤ `end_week`
— on PATCH the rule applies to the patched result, so setting one of them is
fine when the other is already set. A group calculates both dates from its
subtasks and refuses them on PATCH (see **Group dates** below). Both dates
denote week starts and the end week is included: on a Monday-based calendar,
`2026-09-21` through `2026-09-28` is a two-week plan. Use the organization's **Workdays start on**
setting, `organization.week_start` in `GET /v1/me`, before calculating week
dates. `remaining_hours` accepts numbers from 0 that round to at most
99999.9, rounded to one decimal place, or `null` to clear. So `99999.94`
saves `99999.9`, and `99999.95` is refused. Any other value, numeric
overflow such as `1e309` included, is a `400` with `remaining hours must be
a number from 0 to 99,999.9. Enter a number in that range.` MCP gives the same
sentence for any such number. Until October 2026 REST took any finite
nonnegative number and refused other values with `remaining_hours must be a
non-negative number or null`. `remaining_hours` was named
`estimate_hours` until 2026-07-17 (0063; the field now means hours of work
*left*). The old name is no longer recognized, so a request still sending
`estimate_hours` is refused as an unknown field. Update callers.

Tasks with active subtasks are groups. Responses include `is_group: true`;
their stored `status` is dormant and must not be displayed or counted as
their own workflow status. Status filters return ordinary tasks only, and a
PATCH containing `status` on a group returns `400` with
`status cannot be set on a task with subtasks, so update its subtasks instead`.
For a task in an active project, only active subtasks in active projects
count. A subtask in an archived project, such as a sub-project archived on
its own, does not make it a group. A task in an archived project counts
every active subtask. When its last such subtask is detached, deleted or
archived, or that subtask's project is archived, the task resumes its saved
status. Restoring that project makes it a group again, and background steps
clear its own `remaining_hours` moments later, as attaching a subtask does.
They do the same for a task that is still a group when its own project is
restored after its subtasks' project. Archived parents retain `is_group: true` while they have attached subtasks.
Child visibility does not change grouping; this flag reveals no child
identities.

**Group dates.** A group's `start_week` and `end_week` are calculated from
the subtasks the caller can read, at any depth. `start_week` is the earliest
start and `end_week` the latest end of the scheduled ones, including `done`
subtasks. Both are `null` when none is scheduled. A nested group counts only
through its own subtasks, and the calculation stops at a subtask the caller
cannot read, so the tasks below it do not count. Like `is_group`, an active
group counts only active subtasks, while an archived group counts its whole
subtree. Subtasks in archived projects do not count while the group's own
project is active. Two credentials with different access can therefore get
different dates for the same group. The group's own stored dates are not
used while it is a group, and subtask changes never write them. They apply
again when its last active subtask is detached, deleted or archived. A PATCH
containing `start_week` or `end_week` on a group, including `null` or the
current value, returns `400` with `start_week and end_week cannot be set on a
task with subtasks; its dates come from its subtasks`, and the other fields
in that request remain unchanged. Change the subtasks' dates instead.

A task **with active subtasks** has no remaining time of its own (0066;
archived subtasks stopped counting in 0070, and subtasks in archived
projects do not count for a task in an active project): a PATCH
sending a non-null `remaining_hours` for one is a `400`
(`remaining_hours cannot be set on a task with subtasks, because it is the sum
of their remaining time`; `null` passes as a no-op) — the hours live on the
subtasks, and clients show the parent's value as the sum over its unfinished
subtasks at any depth. Such tasks return `remaining_hours: null` and
`remaining_set_at: null` in the shape below, also while they still store
hours of their own from before their subtasks counted, and
the single-task read adds that sum as `group_remaining_hours`. Attaching a
subtask clears its new parent's own hours.
Writing `remaining_hours` also stamps the read-only `remaining_set_at`
(0072): a remaining time is a measurement, and the planning math anchors on
when it was taken — the server stamps the moment the value *changes* (an
unchanged value writes nothing) and clears the stamp with the hours. A move
to another sub-project keeps it. A request that sends `remaining_set_at` is
refused as an unknown field.

**Review time.** A task that enters `review`, whether created there by POST or
moved there by PATCH, gets its project's review time as `remaining_hours`,
with a fresh `remaining_set_at` even when the hours are unchanged. The review
time is the project's `effective_review_hours` in the
[single-project read](#projects), 2 h unless a lead sets another in the app
or with [`PATCH /v1/projects/{ref}`](#changing-a-project). A non-null
`remaining_hours` in the same request wins; `null` or no value takes the
review time. Leaving `review` keeps whatever remaining time is there, and a
PATCH that stays in `review` changes nothing. A group cannot change status,
so it never gets one.

PATCH also accepts `archived: true | false` (0070 — the Active/Archived axis,
orthogonal to `status`). Archiving a task archives its subtasks with it;
restoring one also restores its parent chain (both server-side cascades).
Both reach subtasks and parents in other projects, so the caller needs User
access on every project the cascade changes. Otherwise the PATCH is a `400`
with `archiving this task would change a subtask in a project you cannot edit;
someone who can edit that project can archive it` or `restoring this task
would change a parent task in a project you cannot edit; someone who can
edit that project can restore it`, and nothing changes. A subtask or parent in a project that is being
moved to Deleted items refuses the PATCH for everyone, admins included, with
`a subtask of this task is being moved to Deleted items; try again when that
finishes` or `a parent of this task is being moved to Deleted items; try
again when that finishes`. Restoring a subtask whose parent already has 100
active subtasks brings it back as a top-level task: the answer's `parent_id`
is `null`, and its followers are told it left its parent. So does restoring
a subtask whose parent was deleted after the subtask was archived, even when
the parent is back from Deleted items, because that delete takes every such
subtask off the parent. A PATCH that names that parent as `parent` to keep it
is a `400` with `this task's parent was deleted after this task was
archived, so the task comes back as a top-level task; restore it without
naming that parent`. Archived tasks
disappear from the default list
(`?archived=true&project=<ref>` finds them, see [Archived tasks](#archived-tasks)),
stop counting as workload, and in the app leave every normal view for
the Archived tasks page. A nightly sweep archives tasks that have been `done` for
30 days. Restoring a still-`done` task **restarts its auto-archive
clock** (0071), so a restore holds for the full threshold rather than being
re-swept the next night. A move to another sub-project restarts it too, for
the task and each subtask that moves with it. `archived` matching the current state is
a no-op `200` returning the full task. Sending `archived` on POST is a `400` — tasks
are created active. In the app, archiving unfinished work requires a written
reason, which becomes a comment. The API does not require one, but
`archive_reason` (a string) in a PATCH with `archived: true` posts it the
same way, as a comment by the caller, trimmed, at the moment of the archive.
It is posted only when that PATCH archives the task, so not for a task that
was already archived, and a blank reason posts nothing. `archive_reason`
without `archived: true` is a `400` (`archive_reason needs archived set to
true`). It is at most 500 characters after trimming, counted like a
description, the same limit as the reason the app's delete window shows in
Deleted items. A longer one is a `400` (`an archive reason must be at most 500
characters. Shorten it.`) and the PATCH changes nothing, also for a task that is already
archived. Until October 2026 the limit was 20,000 characters. The reason is a
comment, so it needs room under [the comment limits](#comments): on a task with
1,000 comments or more, past your 10 comments in 60 seconds there, or while
Qivo counts its comments, the PATCH archives nothing, changes no other field
and answers as a comment `POST` would, with the sentence saying that the task
was not archived, such as `this task has reached 1,000 comments, the most a
task can have, so the archive reason cannot be posted and the task was not
archived. Archive it without a reason, which the app allows once its work is
Done, or ask a project lead to delete comments until it has fewer than
1,000.` The same PATCH without `archive_reason` archives the task, because it
posts nothing.

Task shape of a list row from `GET /v1/tasks`:

```json
{
  "id": "…uuid…", "key": "QN-3", "num": 3, "project_id": "…uuid…",
  "project_key": "ELEC", "project_num": 2,
  "title": "…", "description": "…", "status": "todo", "is_group": false, "priority": "high",
  "assignee_id": "…uuid or null", "assignee_name": "Leo Martins",
  "reviewer_id": "…uuid or null", "reviewer_name": "Aisha Rahman",
  "owner_id": "…uuid or null",
  "reporter_id": "…uuid or null", "reporter_name": "Nora Berg",
  "parent_id": null, "has_hidden_parent": false,
  "start_week": null, "end_week": null, "due_date": null, "delay": null,
  "remaining_hours": 8, "remaining_set_at": "…timestamp or null…",
  "paused": false, "progress": null,
  "archived": false, "archived_at": null,
  "created_at": "…", "updated_at": "…",
  "last_comment_at": "…timestamp or null…",
  "url": "https://qivo.io/app/northstar-labs/tasks/qn-3"
}
```

`GET /v1/tasks/{ref}`, `POST /v1/tasks` and `PATCH /v1/tasks/{ref}` answer
the single-task shape, which adds twelve fields:

```json
{
  "group_remaining_hours": null,
  "labels": [{ "id": "…uuid…", "name": "Hardware", "color": "#4C9AFF" }],
  "subtasks_next_cursor": null,
  "subtasks": [{ "id": "…uuid…", "key": "QN-4", "title": "…", "status": "todo" }],
  "has_more_subtasks": false,
  "links_next_cursor": null,
  "links": [{ "kind": "blocked_by", "id": "…uuid…", "key": "QN-9", "title": "…", "status": "progress" }],
  "following": true,
  "followers_next_cursor": "…cursor…",
  "followers": [{ "id": "…uuid…", "name": "Priya Patel" }],
  "attachments_next_cursor": null,
  "attachments": [{ "id": "…uuid…", "name": "wiring.pdf", "size_bytes": 48213, "…": "…" }]
}
```

`subtasks`, `links`, `followers` and `attachments` each hold the first page
of one of the task's lists, at most 50 rows, and each `<list>_next_cursor`
is the cursor of the rest of that list, `null` only when the list ends on
that page. Read the rest from the list's own route (below). Most tasks hold
fewer than 50 of each, so every cursor is `null` and the arrays are whole.
`has_more_subtasks` is `true` exactly when `subtasks_next_cursor` is set.
`labels` holds every label of the task, at most 20. `following` says
whether the caller follows the task, from the caller's own follow, also
when they are past the first page of `followers`. See
[Following](#following). `attachments` lists the task's files with download
links, minted only for the files on that page, in the shape
[Attachments](#attachments) describes. When one request cannot read every
first page, such as the answer of a `PATCH` that archived a large group, a
list it had no room for holds no rows and a cursor at its start, and an
archived group's subtasks, which always read their first subtask, hold the
subtasks the room allowed and a cursor, so a list is never shown as
complete when it is not.

A task's four lists page on their own routes, one page of one list at a
time, without reading the task's text or its other lists:

```
GET /v1/tasks/{ref}/subtasks?limit=&cursor=      { "next_cursor": …, "subtasks": [ … ] }
GET /v1/tasks/{ref}/links?limit=&cursor=         { "next_cursor": …, "links": [ … ] }
GET /v1/tasks/{ref}/followers?limit=&cursor=     { "next_cursor": …, "followers": [ … ] }
GET /v1/tasks/{ref}/attachments?limit=&cursor=   { "next_cursor": …, "attachments": [ … ] }
```

Each row has the shape of the same list in the single-task shape. A page
holds at most `limit` rows, 50 by default and 1 to 200. Pass a task's
`<list>_next_cursor`, or a page's `next_cursor`, unchanged and URL-encoded,
as `cursor` to that list's route for the same task, and stop when
`next_cursor` is `null`. `limit` may change from one page to the next. An
archived group's subtask page can hold fewer than `limit` rows, or none,
while `next_cursor` is set, because each page reads a bounded amount however
many subtasks the group has. A short or empty page is never the end of a
list. Only a `null` `next_cursor` is.

The lists keep their order, with ties broken by id: subtasks by task
number, links by the other task's number, followers by name, ignoring case
and accents and comparing the names by their UTF-8 bytes, so the order
differs from a browser's sort for some scripts, and attachments oldest
first. A cursor works only for the organization, caller, task and list it
came from, and for subtasks only while the task stays active, or archived,
as it was. It works on REST and MCP alike, so a cursor from `GET
/v1/tasks/{ref}` or MCP `get_task` continues on `GET
/v1/tasks/{ref}/subtasks` and on MCP `list_task_related`. Pages are not a
snapshot. A subtask, link, follower or file added, removed or renamed while
you page can be missed or shown twice; read the task again to start afresh.
A task holds at most 100 files, so `GET
/v1/tasks/{ref}/attachments?limit=200` answers every file in one page, and a
client that resolves the description's `att:<id>` images reads them all
with that one request.

A list call checks the caller first, and a task the caller cannot read
answers `404` like an unknown one. These requests are a `400`,
checked in this order after any unknown query parameter, the task coming
between the `offset` and the `cursor`:

- `limit` that is not a whole number from 1 to 200: `limit must be a whole
  number of subtasks from 1 to 200.`, or of linked tasks, followers or
  attachments
- `offset` other than `0`, with the list's own words: `offset does not
  apply to subtasks; pass next_cursor as cursor`, `offset does not apply to
  linked tasks; pass next_cursor as cursor`, `offset does not apply to
  followers; pass next_cursor as cursor` or `offset does not apply to
  attachments; pass next_cursor as cursor`
- a `cursor` that is not the `next_cursor` of an earlier page of the same
  list, task and caller: `cursor must be the next_cursor of an earlier
  page`
- a list with more rows than one request reads and sorts, twice its
  per-task limit, which only data stored before that limit, or followers
  that a new assignee or reviewer added past theirs, can reach: `this task
  has more subtasks than Qivo can list in one request. Contact
  support@qivo.io so we can help.`, `this task has more linked tasks than
  Qivo can list in one request. Contact support@qivo.io so we can help.`,
  `this task has more followers than Qivo can list in one request. Contact
  support@qivo.io so we can help.` or `this task has more attachments than
  Qivo can list in one request. Contact support@qivo.io so we can help.`
  The single-task shape then holds no rows of that list and a cursor at its
  start, which answers this on the list's route.
- a check of which projects the caller can see that a fixed limit of one
  request stopped: `Qivo could not finish checking which projects you can
  see in one request. Contact support@qivo.io so we can help.` The
  single-task read refuses whole with the same sentence, and so do the
  answers of `POST /v1/tasks` and `PATCH /v1/tasks/{ref}`, whose change is
  then not made. Only a person far past the sizes Qivo is built for, such
  as one in hundreds of teams, meets it.

Until November 2026 these arrays held every row, `/attachments` was the
only one of the four list routes, and an archived group listed only the
subtasks one read could reach. Code that reads one of the arrays as the
whole list now reads its first 50 rows without an error; follow the cursors
to read the rest.

`owner_id` is whose work the task is. It is the reviewer while the task is in
`review` with a reviewer set, else the assignee, and always the assignee on a
group. `url` is the address the app's **Copy link** gives. `parent_id` is
the parent task's uuid when the caller can read the parent. Otherwise it is
`null` and `has_hidden_parent` is `true`, so a subtask under a task the
caller cannot read is not mistaken for a top-level task.

The single-task fields name only tasks the caller can read. `subtasks` lists
the first page of the direct subtasks it can read, by number. An active task lists its active
ones, also those in an archived project, which do not make it a group while
its own project is active, and an archived task lists all of them. `links` lists the task's links
whose other task it can read, with `kind` as seen from this task (`blocks`,
`blocked_by` or `relates`). `labels` are ordered by name.
`group_remaining_hours` is `null` for a task without subtasks. For a group it
is the remaining time the app shows, which is the sum over the unfinished
subtasks at any depth that the caller can read, or `null` when none has hours.
Like the group's dates, it counts only active subtasks of an active group,
leaves out subtasks in archived projects while the group's project is active,
and stops at a subtask the caller cannot read. `is_group` still reports
subtasks the caller cannot read, without identifying them. Their dates do not
count toward the group's `start_week` and `end_week`.

`progress` is `null` for a task without subtasks. For a group it is the
**Progress** of the app's task window, `done` of `total` tasks without
subtasks under it, at any depth, that the caller can read:

```json
{ "progress": { "done": 2, "total": 3, "percent": 67, "partial": true } }
```

It counts the same subtasks as the group's dates, scheduled or not, and
`done` counts those that are Done. `percent` is rounded, and `0` when
`total` is `0`. `partial` is `true` when some of the group is hidden from
the caller, such as a subtask it cannot read, so the true completion is
unknown. The app then says "Completion unknown".

An archived group can have more tasks under it than one request can read,
such as thousands of subtasks. So can an active group stored before the rule
of one level of subtasks, whose subtasks have subtasks of their own. Its
single-task shape then still lists the first page of its direct `subtasks`,
but `start_week` and `end_week` are `null`, `progress` is `0` of `0` with
`partial: true` and `group_remaining_hours` is `null`. The dates,
`progress` and `group_remaining_hours` always come from the group's whole
subtree, never from the first page of `subtasks`. An archived group's
subtasks page in number order on `GET /v1/tasks/{ref}/subtasks` to the
end, however many there are. The answer of a `PATCH`, such as one that
archives such a group, takes the same shape.

`delay` is the app's projected delay, the verdict its Roadmap and task
window show:

```json
{ "delay": { "status": "behind", "projected_end_week": "2026-10-26" } }
```

`status` is `ok`, `behind` or `late`, the app's **On track**, **Currently
delayed** and **Delayed**. `projected_end_week` is the first day of the week
the work is projected to finish. It is `null` when `late` rests only on a
passed due date, and for a finish after the year 9999. `delay` itself is
`null` when the task's project does not track delay, when the task or its
project is archived, and when the app shows no verdict, such as for a Done
task or one with neither a plan nor a due date. The projection uses the
owner's plannable hours and their other scheduled work, counted as the app
counts it for the caller. For organization admins and users that includes
work in projects they cannot read, without naming it. For viewers and
guests it includes only work they can read or own, so two callers can get
different verdicts for one task. A group with subtasks the caller cannot
read can only be `late`, as in the app. The server judges today's date in
UTC, so near midnight or a week boundary it can differ from the app, which
uses the browser's time zone.

`delay` can also be:

```json
{ "delay": { "status": "unavailable", "projected_end_week": null } }
```

Qivo says this when the owner's other open work is too large for it to
read in one request, or it could not finish checking which projects the
caller can see. It can happen for any caller, a viewer or guest included,
also when most of that work is in projects they cannot read. A list row
also says it when its page did not read the owner's other work. A list
reads the other open work of each page's owners within a fixed share of
the page's budget, so the rows of a person with very much open work can say
`unavailable` on every page. An organization admin or user gets every owner
that share holds. A guest or organization Viewer gets the work of the first owner on
the page whose task needs it, and the tasks of other owners on that page
that need their owner's work say `unavailable`. Read such a task with `GET
/v1/tasks/{ref}` for its own verdict. Qivo never counts the work it could
not read as free time. `unavailable` also replaces `late` on a task whose
due date has passed, because the projected week rests on that work.
`unavailable` arrived on single tasks in October 2026 and on list rows in
November 2026, so treat a `status` you do not know as no verdict.

`last_comment_at` is when the newest comment on the task was posted, or
`null` when it has none. Editing a comment does not change it, and deleting
the newest one makes the one before it the newest.

`DELETE` moves the task to **Deleted items**, as deleting it in the app does,
and returns `{ "deleted": true, "id": "…", "key": "QN-3" }`. Its comments,
attachments, links, labels and follows go with it, its inbox messages are
deleted, and its active subtasks become top-level tasks at once and its
archived ones a moment later. Their followers' inbox messages arrive
moments after the delete. From then on the task
answers `404` like an unknown one, while its number, uuid and files stay
reserved. A person can restore it in the app under **Settings → Projects →
Deleted items**, and the API has no restore. A nightly job deletes it for
good 30 days after the delete. Deleted items records the credential the
request came with (see [Side effects and audit
trail](#side-effects-and-audit-trail)).

### Links

Two tasks of the organization share at most one link. One blocks the other,
or they relate. A link's `kind` is always read from the task in the path:

```
GET    /v1/tasks/{ref}/links                 a page of its links (read)
POST   /v1/tasks/{ref}/links                 { "task": "QN-9", "kind": "blocked_by" }
DELETE /v1/tasks/{ref}/links/{kind}/{other}  remove that link
```

`GET` answers `{ "next_cursor": …, "links": [ … ] }`, the task's links
whose other task the caller can read, by that task's number, in the
single-task `links` shape, a page at a time as the
[single-task shape](#tasks) describes.

`kind` is `blocks`, `blocked_by` or `relates`, and `task` and `{other}` are
task refs. Adding or removing a link needs read access to both tasks and
Edit access on at least one, the rule the app uses. A task the caller cannot
read answers like an unknown one (`400` `task must name a task by key,
number or uuid` for `task`, `404` for `{other}`); two readable tasks
without Edit access on either answer `403`. `POST` answers `201` with the
link as seen from `{ref}`, in the single-task `links` shape. Sending the
same link again changes nothing, while a different link between the same
two tasks is a `400` (`these tasks are already linked`). Remove it first. A
task cannot be linked to itself. A task is an end of at most 100 links, and
a new link to a task that has 100 is a `400` naming it (`QN-9 already has
100 links, the most a task can have. Remove one of its links first.`). `DELETE` answers `{ "removed": true |
false, "kind": "…", "id": "…", "key": "QN-9", "title": "…", "status": "…" }`
naming the other task; `removed` is `false` when no link of that kind
existed. Adding a link writes a `linked` activity row against the blocking
task (for `relates`, against the one whose uuid sorts first), with the
provenance; removing one writes none, as in the app.

### Labels

The organization's labels, which any member may read:

```
GET   /v1/labels?search=&limit=&cursor=  one page of labels, in name order
POST  /v1/labels                         { "name": "Hardware", "color": "#4C9AFF" }
PATCH /v1/labels/{id}                    { "name": "…", "color": "…", "expected"?: {…} };
                                         {id} is an id or name
```

A label is `{ "id": "…uuid…", "name": "Hardware", "color": "#4C9AFF" }`.
`GET /v1/labels` answers one page of labels at a time,
`{"next_cursor": "…", "labels": […]}`, in the order of the app's Labels
settings page, by name in any case and compared by UTF-8 bytes, so a name
that starts with an accented letter comes after z. Labels stored with one
name before names were unique come in the order they were created. `search`
keeps the labels whose name holds every word of it, in any order, ignoring
case and accents. Paging, `search` and the refusals work as for
[users](#users), with `limit must be a whole number of labels from 1 to
200.` and `offset does not apply to labels; pass next_cursor as cursor`,
except that the labels list needs no prepared names, so it is never refused
for them. Until November 2026 `GET /v1/labels` answered every label at
once, as an array, and took no query parameters, so code that read the
array must now read `labels` and follow `next_cursor` until it is `null`.
Names are trimmed, at most 40 characters (`a label name must be at most 40
characters. Shorten it.`) and unique in the organization in any case. A
color is `#` followed by six hex digits; a label stored before that rule
reads as `#8A8F98`. Creating a label needs an organization admin,
or a person or agent with the User role and Edit access to a top-level
project (a sub-project alone is not enough), and answers `201`; it
writes a `created label` activity row with the provenance. Qivo checks
that rule by reading the caller's own project access, teams and the
projects they lead. When those are too many to read in one request, the
create is a `400` (`you belong to too many projects and teams for Qivo to
check in one request whether you may create labels; an organization admin
can create this label`) and creates nothing. Renaming and
recoloring are for organization admins only, as on the app's Labels
settings page, and are checked before the label is looked up. `PATCH` takes
an optional `expected` with the `name` and `color` you last read of the
fields it changes, and saves nothing when someone changed one of them since
(see [Refusing a change when a field changed since you read
it](#refusing-a-change-when-a-field-changed-since-you-read-it)); `POST`
takes no `expected`, and refuses it with `expected applies only when
changing an existing label`. Deleting a label is not offered over the API. Put labels on a task with `add_labels`
and `remove_labels` on `PATCH /v1/tasks/{ref}`.

### Comments

The task's discussion thread (migration 0054) — the same comments the app
shows on the task window's discussion spine:

```
GET    /v1/tasks/{ref}/comments   the newest comments, oldest first (read)
       ?limit=50                  1 to 50, 50 by default
       &before=<comment id>       the comments posted before that one
POST   /v1/tasks/{ref}/comments   { "body": "Markdown text" }      (write)
PATCH  /v1/comments/{id}          { "body": "Markdown text",
                                    "expected"?: { "body": "…" } }  (write)
DELETE /v1/comments/{id}          [{ "expected": { "body": "…" } }] (write)
```

```json
{
  "id": "…uuid…", "task_id": "…uuid…",
  "author_id": "…uuid…", "author_name": "Release Bot",
  "body": "Markdown text", "created_at": "…",
  "edited_at": null, "edited_by_id": null, "edited_by_name": null
}
```

`GET` answers a JSON array of the task's newest comments, oldest first in
the order they were posted. It holds at most `limit` comments, and fewer
when they are long, because one call reads at most about 8 MiB of comments.
To read further back, pass the `id` of the first comment in the array as
`before`, and repeat until the array is empty. Only an empty array means
there are no earlier comments. A `limit` that is not a whole number from 1
to 50 is a `400` (`limit must be a whole number of comments from 1 to 50.`),
and so is a
`before` that is not the id of a comment on this task (`before must be the
id of a comment on this task`).

A comment created here is authored by **the caller**, which is the agent
itself for an agent key and the person for a personal token. An agent is a
user, so it speaks under its own name instead of landing as the anonymous
"Someone" an org-level key used to produce. Attribution is still
server-stamped precisely so it cannot be forged, and passing
`author`/`author_id` is rejected with `400` (`comments cannot be attributed
over the API; a comment is always authored by the agent posting it`, or for
a personal token `comments cannot be attributed over the API; a comment is
always authored by the person posting it`). You are only ever yourself. `POST` returns `201` with
the created comment; a blank `body` is a `400`. A comment body is at most
20,000 characters after trimming, counted like a description, on `POST` and
`PATCH`; a longer one is a `400` (`a comment must be at most 20,000
characters. Formatting counts too. Shorten it.`). Comments go to Deleted items with their task and come back
with it.

A task holds at most **1,000 comments**, counted across every author and
every way of posting: the app, REST, MCP and archive reasons. A `POST` to a
task that already has 1,000 or more is a `400` (`this task has reached 1,000
comments, the most a task can have. Ask a project lead to delete comments
until it has fewer than 1,000, then post again.`). Only a comment's author or
a lead of the task's project can delete it. A task that held more than 1,000
before the limit
keeps them all and takes no new comment until deletes bring it under 1,000.
Each comment deleted frees one place, and editing a comment changes nothing.
A delete that is refused, or of a comment already gone, frees nothing.

One caller may post at most **10 comments on one task in any 60 seconds**
of server time. Every key, token and OAuth connection of the same agent or
person shares the allowance, with the app and MCP, and so do archive
reasons. Each post stops counting 60 seconds after it was saved; a deleted
comment still counts until then. Past the allowance a `POST` is a `429` with
`Retry-After` set to the whole seconds until the oldest of those posts stops
counting, and the same number in its sentence: `{"error": "too many comments
on this task, at most 10 in any 60 seconds from one person or agent. Try
again in 42 seconds."}`. Other authors, and your posts on other tasks, are
not affected. Waiting does not promise that the task still has room for the
comment then.

A task stored before Qivo counted comments is counted when someone first
posts on it. A thread too long to count in that request, more than about
1.5 MiB of comments, is a `503` with `Retry-After: 60` and `{"error": "Qivo is
still counting this task's comments. Try again in 60 seconds."}`, and the
comment is not saved. That refusal starts the count in the background, which
takes seconds for most threads, so the same request sent after the wait
passes. Each of these refusals saves nothing, so send the same request again
later. Every one of them still counts as an API call (see [Request
limits](#request-limits-and-billing)).

`PATCH /v1/comments/{id}` replaces a comment's body and answers the comment;
`DELETE /v1/comments/{id}` answers `{ "deleted": true, "id": "…", "task_id":
"…" }`. `{id}` is the comment's `id` from the thread. As in the app, the
comment's author may edit or delete it, and so may a lead of the task's
project, an organization admin only as its lead; anyone else gets `403`
(`only the author or a project lead can edit this comment`, or `delete`). A
comment on a task the caller cannot read answers `404` (`comment not found`),
like an unknown id. The body is trimmed and may not be blank (`400` `a comment
cannot be empty`). Sending the text it already has changes nothing. An edit
records `edited_at` and `edited_by_id`, and people it newly mentions follow
the task and get an inbox message, as on a new comment. Neither writes an
activity row or a webhook event.

Both take `expected` with the `body` you last read. `PATCH` takes it beside
the new `body`, and `DELETE` as an optional JSON body `{"expected": {"body": "…"}}`,
because a deleted comment cannot be restored. Either saves
nothing when someone edited the comment since you read it, and the `409`
names the person who last edited it (see [Refusing a change when a field
changed since you read
it](#refusing-a-change-when-a-field-changed-since-you-read-it)). A `DELETE`
without a body deletes without a check, as before.

**Mentions and inbox messages (0074/0075/0114).** Description and comment
markdown may carry the app's mention form — `@[Display Name](user:<profile
uuid>)` (the label may not contain square brackets; mention syntax inside code
spans or fenced blocks renders literally and does not notify). A mention (in a
comment, or newly added to a description) delivers an inbox message to that
user, and any API write that changes a task — or comments on it — messages
everyone **subscribed** to that task. Since 0114 that is the whole rule:
subscribers, not "the assignee", who is simply subscribed by having been
assigned. Being @mentioned or leaving a comment subscribes you too, so an
agent that comments on a task starts receiving its news, unless the task
already has 100 followers, the most a task can have. The comment and the
mention still go through, and the mention still notifies. A description or
comment can mention at most 100 distinct people. A `POST` or `PATCH` whose
text mentions more is a `400` (`a text can mention at most 100 people. Remove
some mentions and save again.`) and saves nothing. Whoever a task passes
to starts following it as well: the reviewer when the task enters `review`
with a reviewer set (or a reviewer is set while it is there), who reads
`Ready for your review`, and the assignee when it leaves `review` again or
loses its reviewer there. A reviewer set in any other status is not
subscribed, and a task with subtasks stays with its assignee, so clearing its
reviewer subscribes nobody. A new assignee or reviewer follows even a task
that already has 100 followers.

Following (subscribing to) a task yourself is [its own route](#following),
and the caller reads and clears what arrives through [the inbox
routes](#inbox).

All of it happens server-side, so it needs nothing from the caller. Most of
it happens inside the same transaction as the write. Follower messages on a
task with more than 128 followers, past the first 128, arrive moments later
instead, and so do mention and follower messages when many of the people a
write mentions or notifies have snoozed a long thread about the task,
because each message wakes theirs. Every follower message of a roadmap save,
an access removal or the subtasks a task delete detaches also arrives
moments later (see [Inbox](#inbox)). Unknown or out-of-org uuids in mention
position are silently ignored, as are users without visibility into the
project and agents that receive no inbox messages (see [Inbox](#inbox)), so a
subscription never outlives the project access that justified it.

Every write here is the caller's, and the server is what says so. Each
endpoint is one internal function — resolve the ref, check the rules, make
the write and record the trail, in one transaction — and that function takes
the authenticated caller explicitly, so there is no anonymous path for a
write to arrive on. (Before 0115 this surface wrote with elevated
credentials and no session identity, so a task INSERT or PATCH was
**actor-less** and everyone subscribed to the task was told "Someone" had
changed it.) The subscriber sees the caller's name, and the activity trail
records that agent or person as the actor even when task creation selects a
different `reporter_id`. Selecting a reporter never rewrites who performed
the operation. Task responses expose reporter, assignee and reviewer, with no
separate creator fields. The caller is not notified of its own changes.

### Following

Following a task is how its updates reach the caller's [inbox](#inbox):

```
PUT    /v1/tasks/{ref}/following   follow the task
DELETE /v1/tasks/{ref}/following   stop following it
```

Both answer `{ "id": "…uuid…", "key": "QN-3", "following": true | false,
"changed": true | false }`; `changed` is `false` when the caller already
was, or was not, following. Following needs only read access to the task,
as the app's eye button does, and a task the caller cannot read answers
`404` like an unknown one. A task has at most 100 followers, so `PUT` on a
task with 100 that the caller does not follow yet is a `400` with `this task
already has 100 followers, the most a task can have. Someone must unfollow it
first.` Tasks with more
followers from before this limit keep them. The caller's own follow is the only one these
routes change; managing other people's follows stays in the app. The
single-task read shows `following` and the first 50 `followers`, by name,
and `GET /v1/tasks/{ref}/followers` answers `{ "next_cursor": …,
"followers": [ … ] }`, a page at a time as the [single-task shape](#tasks)
describes. A new assignee or reviewer follows the task even when it has
100 followers, so a task's followers can pass the limit. Qivo also makes the
caller follow a task when it is assigned or handed the task, mentioned on it
or comments on it, as described under [Comments](#comments).

### Inbox

The caller's own inbox, with the same items the app's **Inbox** shows. Each
item is one active task the caller can read and holds the messages about
that task the caller has not removed. An item keeps at most 50 unread
messages. When more arrive, Qivo drops the oldest unread ones but keeps the
item's first unread message and the newest message of each `kind`. On a task
with many followers it does so moments after the arrival, so an item can
briefly hold one more. The item's `dropped_count` says how many it dropped,
until the item is read, and the app's Inbox shows it as **N earlier updates
on this task are not listed**. The task's comments and history still hold
what those messages announced. A comment or a change on a task with more than 128
followers, such as a task from before the follower limit, reaches the
first 128 at once and the rest moments later. The same holds when many of
the people a write mentions or notifies have snoozed a long thread about
the task, because each message wakes theirs. The followers of the tasks a
roadmap save or an access removal changes, and of the subtasks a task delete
detaches, get their messages moments after it saves.

```
GET  /v1/inbox                 items, latest activity first (read)
POST /v1/inbox/read            { "tasks": ["QN-3"] } or { "all": true }
POST /v1/inbox/unread          { "tasks": ["QN-3"] }
POST /v1/inbox/remove          { "tasks": ["QN-3"] } or { "all": true }
POST /v1/inbox/snooze          { "tasks": ["QN-3"], "until": "2026-11-02T08:00:00Z" }
```

`GET /v1/inbox` takes `unread_only=true` (items with an unread message),
`include_snoozed=true` (snoozed items are left out otherwise, as in the app),
`limit` (1 to 200, 50 by default) and `offset`. A `limit` outside that range
is a `400` with `limit must be a whole number of items from 1 to 200.`, and
an `offset` that is not a whole number from 0 up is a `400` with `offset must
be a whole number, 0 or more`. It answers:

```json
{
  "items": [
    {
      "task": { "id": "…uuid…", "key": "QN-3", "title": "Fix hinge tolerance", "status": "progress" },
      "unread_count": 1,
      "dropped_count": 0,
      "latest_at": "2026-10-14T09:12:03.000Z",
      "snoozed_until": null,
      "messages": [
        {
          "id": "…uuid…", "kind": "comment", "detail": "New comment",
          "actor_id": "…uuid…", "actor_name": "Priya Patel",
          "created_at": "2026-10-14T09:12:03.000Z", "read_at": null
        }
      ]
    }
  ],
  "truncated": false
}
```

`task` is the task as it is now, its current title included. As in the app,
items are listed only for active tasks the caller can read in active
projects. Messages about a task it has lost access to, an archived task or a
task in an archived project stay stored and come back when the access or the
task does, unless they were removed meanwhile. `messages` run oldest first;
`kind` is `mention`, `comment` or `change`, and `detail` is the line the app
shows. `latest_at` is the newest message's time, or the end of a snooze when
that is later, and orders the list.

Archiving a task marks every message about it and the subtasks archived
with it read, for every recipient, shortly after the archive. Archiving a
project does the same for the tasks of the project and its sub-projects. A
snoozed item loses its snooze, and a snooze that ends before the marking
does not bring the item back unread. Messages that arrive while the task or
its project is archived, including the `Archived` message (the nightly
automatic archive sends none), mentions and comments, are stored read. As
with any read message, the nightly cleanup removes them after the
recipient's retention period, and `POST /v1/inbox/remove` with
`"all": true` removes them too. A restore brings back the items still
stored, with their messages read. A restore that comes before the marking
leaves the messages as they were. Other followers of a restored task also
receive an unread `Restored` message, which replaces the item's read
messages as any new message does. Parents restored along with a subtask
send no `Restored` message. Deleting a task or a project deletes the
messages about its tasks, and restoring it from Deleted items does not
bring them back.

One request lists up to 500 of the caller's unread messages (newest first)
and up to 500 read ones (most recently read first). It looks at no more than
1,000 of each, counting the stored ones about tasks it does not list. When
some messages were not looked at, `truncated` is `true`, so a large backlog
about such tasks can set it too. Items whose messages were not looked at are
then missing, and an item listed may lack its older messages. Marking items
read keeps only each item's latest message, so `POST /v1/inbox/read` with
`{"all": true}`, repeated while `has_more` is `true`, shrinks the inbox until
it fits.

The `POST` routes change the caller's own items and answer `{ "action":
"read", "tasks": ["QN-3"], "has_more": false }`, where `tasks` lists the
items the call changed. `tasks` in the body are task refs, at most 100 per
call with repeats counted. A longer list is a `400` (`tasks must name at
most 100 tasks per call. Send the rest in another call.`), and so is a task
the caller cannot read (`tasks
must name tasks by key, number or uuid`); neither changes anything. Name the
items with `tasks`, or send `"all": true` instead:

- `read` marks the named items read. Like opening an item in the app, it
  keeps only each item's latest message. With `all`, it marks every item
  read except snoozed ones, up to 160 messages per call, and the answer
  adds `before`, a number. Send it back unchanged as `"before"` with each
  later call, so messages that arrive meanwhile stay unread. `before` with
  `tasks` or another action, or one that is not a number from 0 up, is a
  `400`.
- `unread` marks the named items unread again.
- `remove` removes the named items. With `all`, it removes every read
  message except snoozed ones, up to 160 per call, and leaves unread
  messages alone.
- `snooze` hides the named items until `until`, an ISO date-time in the
  future and at most 366 days ahead, and marks them unread so they return
  bold. `"until": null` brings snoozed items back now. A new update on the
  task also brings its item back.

`unread` and `snooze`, with a date or `null`, refuse a task that is archived
or in an archived project. No inbox lists such a task, and its messages stay
read until it is restored. The answer is a `400` that names the task:
`QN-3 is archived and must be restored first`,
`QN-3 is in an archived project, which must be restored first` or
`QN-3 and its project are archived and must be restored first`. One such
task refuses the whole call, even when the caller holds no messages about
it, and nothing changes. A task the caller cannot read is refused first, as
above. `read` and `remove` still work on archived tasks.

With `all`, repeat the call while `has_more` is `true`. Like the app's bulk
actions, `all` also reaches messages about tasks that are not listed,
archived ones and those the caller can no longer read, but `tasks` names
only readable ones. Other bodies are `400`: neither or both of `tasks` and
`all`, `all` with `unread` or `snooze`, `until` on another action, or
`snooze` without `until`.

The nightly cleanup removes an item's read messages after the caller's
retention period, which a person sets in the app. An agent has no settings
page, so its read messages are removed after 7 days. Unread messages are
never removed by it.

Only an active Standard user agent receives inbox messages. A Viewer agent
and an Inactive one cannot mark messages read or remove them, so Qivo sends
them no messages and does not make them followers, whether by a mention, a
comment, an assignment or a project lead. Messages they already hold stay. A
Viewer agent can still read them with `GET /v1/inbox`, and both receive new
ones again once the agent is an active Standard user.

### Attachments

A task's files, the same ones the task window shows, plus the images inside
its description:

```
GET    /v1/tasks/{ref}/attachments                a page of files, oldest first (read)
POST   /v1/tasks/{ref}/attachments                start an upload (write)
POST   /v1/tasks/{ref}/attachments/{ticket}       attach the uploaded file (write)
DELETE /v1/tasks/{ref}/attachments/{id}           delete a file (write)
```

```json
{
  "id": "…uuid…", "name": "wiring.pdf", "size_bytes": 48213,
  "content_type": "application/pdf", "inline": false,
  "uploaded_by_id": "…uuid…", "uploaded_by_name": "Atlas",
  "created_at": "…",
  "url": "https://api.qivo.io/files/…?e=…&m=…&t=…",
  "url_expires_at": "…"
}
```

`GET /v1/tasks/{ref}/attachments` answers `{ "next_cursor": …,
"attachments": [ … ] }`, a page of the task's files at a time, 50 by
default and up to 200 with `limit`, as the [single-task shape](#tasks)
describes. A task holds at most 100 files, so `limit=200` answers every
file at once. Until November 2026 it answered every file as an array, and
`limit`, `cursor` and `offset` were unknown parameters; code that read the
array now finds an object, so read its `attachments` and follow
`next_cursor` until it is `null`.

`size_bytes` is measured from the stored file. `inline` is `true` for an
image inside the task description, which the description names as
`![alt](att:<id>)`. `url` is a download link minted for the caller that
works for 10 minutes (`url_expires_at`), only for the files of the page
that answers it; read the task or the list again for a fresh one. Each download checks again that the caller's user is active and
can see the task's project, so a link stops working when that access ends.
It does not check the credential, so a link fetched before a key or token
was revoked keeps working until it expires. Images (PNG, JPEG, WebP, GIF,
AVIF) open in the browser; append `&download=1` to download one. Every other
type always downloads.

Uploading takes three requests:

1. `POST /v1/tasks/{ref}/attachments` with `{ "name": "wiring.pdf",
   "content_type": "application/pdf", "size": 48213 }`. `name` is 1 to 255
   characters after trimming, `content_type` is optional, and `size` is the
   exact number of bytes. It needs Edit access to the task's project. A
   task holds at most 100 attachments, images in its description included,
   so a full task is a `400` before any bytes are sent (`this task already
   has 100 attachments, images in its description included, the most a task
   can have. Remove one first.`), and the confirm in step 3 checks it again.
   A `size` over the organization's per-file limit (`max_attachment_mb` in
   `GET /v1/me`, at most 20 MiB) is a `400` (`a file must be at most 20 MiB,
   this organization's attachment limit. Attach a smaller file.`). The 20 MiB
   ceiling is Qivo's product rule: attachments are for images, PDF files and
   similar documents, and Qivo is not a file store. One user has at most 20
   uploads in progress in an organization, here, over MCP and in the app
   together, so a 21st start is a `400` (`you already have 20 uploads in
   progress, the most one person can have at once. Try again once one has
   finished. An upload that is never finished stops counting an hour after
   it started.`). An upload counts from its start until it is confirmed, or
   until its ticket expires, also when no file was sent. It answers `201`
   with `{ "ticket": "…uuid…", "upload_url": "…", "expires_at": "…" }`.
2. `POST` the file's bytes, exactly `size` of them, to `upload_url`, with
   the file's type as `Content-Type` and no Authorization header. It
   answers `{ "storageId": "…" }`.
3. `POST /v1/tasks/{ref}/attachments/{ticket}` with `{ "storage_id":
   "…" }`, which answers `201` with the attachment.

The ticket and its upload URL expire after an hour. The upload URL stores
one file:

- While a `POST` to it is storing the file, and once it has, another `POST`
  answers `409` (`this upload URL has already been used; start a new
  upload`) and stores nothing. If the answer of the `POST` that stored the
  file was lost, start a new upload.
- A body of another size than declared answers `400` (`the upload must be
  exactly the 48213 bytes declared`), a `Content-Type` over 255 characters
  answers `400` (`a file's media type must be at most 255 characters. Send a
  media type such as application/pdf.`),
  and a body that takes longer than its time to arrive, 5 minutes plus a
  second for every 32 KiB of `size` and at most 8 minutes, answers `400`
  (`the upload took too long; send it again`). These store nothing, and the URL
  can be tried again, as after any other failed `POST`. A `POST` that ends
  without an answer and without storing a file, for example when the
  connection drops, holds the URL for at most 15 minutes. So does, rarely,
  a refused `POST` whose cleanup kept conflicting with other `POST`s, and
  until then the URL answers `409`.
- `POST`s sent to one upload URL at the same moment change the same ticket,
  so one can conflict with the others. Qivo retries such a conflict itself,
  twice at most, and one that keeps conflicting answers `503` with
  `Retry-After: 1` and `{"error": "the request conflicted with other changes
  made at the same time and changed nothing; send it again"}`, like any
  other request that keeps conflicting, or `{"error": "the request took too
  long and changed nothing; send it again, or change less at once if it
  keeps happening"}` when a busy server kept it from finishing in time. An
  upload cannot change less, so send it again. Either stores nothing and
  leaves the
  URL free, so wait the `Retry-After` seconds and send the same `POST`
  again. If Qivo could not free the URL either, which is rare, the `POST`
  answers `409` (`this upload URL has already been used; start a new
  upload`) instead.
- An expired or altered upload URL, and one whose upload was confirmed,
  answers `404` (`upload not found or expired; start a new upload`).

Qivo reads the body of a `POST` to the upload URL in one of its own request
handlers, which stays busy until the whole file has arrived, for at most the
time above. A 20 MiB file gets 8 minutes and therefore needs about 44 KB/s
(350 kbit/s) or more, and a 1 MiB file gets 5 minutes and 32 seconds, about
3 KB/s. Many
large uploads at once from one organization share the deployment's handlers
with every other request, so send them a few at a time. A refusal decided
before the file is read, or while reading a body of another size, such as
the `409` or the `400` for a body of another size, also waits for the rest
of the body, but only 5 seconds more, 1 second without bytes and 32 MiB, as
for [every request](#request-limits-and-billing). A slower upload that is
refused can end with the connection closed, or with a `502` from the
hosting front end, instead of the answer. The `400` for an upload that took
too long stops the upload at once, so a client that slow usually
sees the connection close. Treat either like a network error and start the
upload again.

Only the user that started the upload can confirm it, only for the same
task, and the file attaches once. A confirm sent again by the same user for
the same task with the same ticket and `storage_id` after the first one
attached the file, for example because its answer was lost, answers `201`
with that attachment and changes nothing. Any other ticket answers `404`
(`upload not found or expired; start a new upload`), whatever file it
names: an expired one, one that never existed, one Qivo deleted and
another of the user's confirmed tickets. So does a confirm sent again by
another user, for another task or with another file, or after the file was
deleted. A confirm before
the upload URL has stored a file answers `400` (`no file has been sent to
this upload URL; send it there, or start a new upload`). `storage_id` must
be the `storageId` the upload URL answered, and any other value answers
`400` (`storage_id must be the storageId the upload answered`). Without a
`content_type`, the attachment takes the upload's `Content-Type`.
If the organization lowered its per-file limit after the upload
started and the file now exceeds it, Qivo deletes the file, answers `400` and
spends the ticket.
Bytes uploaded but never confirmed are usually deleted within an hour after
their ticket expires. After a restore of Qivo's database they are kept for up
to 7 days first, in case a later restore needs them, and the rare file that
a failed upload could not clean up waits for Qivo's weekly storage sweep.
Attaching writes an `attached a file to` activity row with the file name and
the provenance.

MCP offers the same upload through `start_attachment_upload` and
`confirm_attachment_upload`, which is how an OAuth connection attaches files
([MCP attachments](mcp.md#attachments)). A ticket belongs to the user, not
the credential, so the same user can confirm a ticket started over MCP here,
and the reverse.

`DELETE` needs Edit access to the task's project, as in the app, where
anyone with Edit may remove any file, not only their own. It deletes the
file, which no link serves from then on and whose contents Qivo erases
within 7 days
([Deleted items](guide/how-work-is-organized.md#deleted-items)), and
answers `{ "deleted": true, "id": "…", "name": "wiring.pdf", "key":
"QN-26" }`, writing a `removed an attachment from` activity row. An id that
is not a file of that task is a `404` (`attachment not found`). A
description image (`inline: true`) is a `400` (`this image belongs to the
task description; remove it by taking it out of the description`).

The API uploads no description images; the app does. When a `PATCH`
rewrites a description, keep every `![alt](att:<id>)`
reference whose image should stay. A description save, from the app or the
API, that takes out an image's last reference removes the image from the
task at once: it no longer counts toward the 100 attachments and no longer
appears in `attachments`. A save within a day that names it again brings it
back, unless the task has 100 attachments by then, which is a `400` with the
full-task sentence above. After a day the image is deleted, and Qivo
erases its contents within 7 days after that
([Deleted items](guide/how-work-is-organized.md#deleted-items)). A task
keeps at most the 100 most recently removed images, so the oldest goes at
once when a save removes more. An image that no
saved description has named a day after its upload, such as one a closed
browser tab left, is removed by the task's next description save.

A description can only show images attached to its own task. A `PATCH` or
`POST` whose description adds a reference to any other image, such as one
copied from another task, or one deleted since, is a `400` with `the
description shows an image that is not attached to this task, such as one
from another task; remove it, or upload the image to this task`.

### Task activity

```
GET /v1/tasks/{ref}/activity   the task's newest history, oldest first (read)
       ?before=<activity id>  the rows before that one
```

```json
[
  {
    "id": "…uuid…", "created_at": "…",
    "actor_id": "…uuid…", "actor_name": "Leo Martins",
    "verb": "changed", "detail": "(status To Do → In Progress), via MCP"
  }
]
```

These are the rows the task window's **All** filter shows beside the
comments, which `GET /v1/tasks/{ref}/comments` lists instead. `actor_id` and
`actor_name` are `null` once the user who made the change has been removed
from the organization. Every user, an organization admin as anyone, does
not receive a row that names a project they cannot access, such as the project the task was in before a move, or one that names
another task they cannot read, such as the other end of a link. An
archived task's history is answered too, by the same rule, as the app's
read-only window on an archived task shows it under **All**. A task keeps
all its activity rows, and an
answer holds at most 500 of them. To read further back, pass the `id` of the
first row in the array as `before`, and repeat until the array is empty. Only
an empty array means there is no earlier history. A `before` that is not the
`id` of a row in this task's history is a `400` (`before must be the id of a
row in this task's history`). The request reads on past rows you do not
receive. When it cannot find one row you receive before it has read as much
as one request may, it is a `400` (`too many of this task's changes are
hidden from you to read them at once`).
When Qivo cannot finish checking which projects you can see for the
projects a page's rows name, the request is a `400` (`Qivo could not finish
checking which projects you can see in one request. Contact support@qivo.io
so we can help.`) rather than an answer that leaves those rows out.
Deleting a task for good from Deleted items deletes its history.
See [Side effects and audit trail](#side-effects-and-audit-trail) for the
wording.

### Workload

```
GET /v1/workload?from_week=2026-10-12&weeks=8&project=ENC&limit=50     (read)
GET /v1/workload?from_week=2026-10-12&weeks=8&cursor=<next_cursor>     (read)
GET /v1/workload?from_week=2026-10-12&person=<user uuid>               (read)
```

Each person's planned hours per week, as the Roadmap's Team strip and the
planning panel count them, one page of people at a time. `from_week` is any
day of the first week, by default the current week; weeks begin on the
organization's `week_start` (`GET /v1/me`). `weeks` is 1 to 52, 8 by default.
A window with a week that starts before 0000-01-01 or after 9999-12-31 is a
`400` (`the workload window must fall within the years 0000 to 9999`),
because its `week_starts` could not be written as `YYYY-MM-DD`. `project`
(uuid, number or key) limits the hours to that project and its sub-projects;
one the caller cannot see is a `404`. `limit` is the most people a page
holds, 50 by default and 1 to 200.

```json
{
  "next_cursor": "…",
  "week_starts": ["2026-10-12", "2026-10-19"],
  "project": null,
  "hidden": "counted",
  "people": [
    {
      "id": "…uuid…", "name": "Leo Martins", "org_role": "user", "kind": "person",
      "active": true, "plannable_hours": 32, "status": "ok",
      "hours": [30, 22], "hidden_hours": [4, 0]
    },
    {
      "id": "…uuid…", "name": "Mia Chen", "org_role": "user", "kind": "person",
      "active": true, "plannable_hours": 40, "status": "unavailable",
      "hours": null, "hidden_hours": null
    }
  ]
}
```

`hours[i]` is the person's planned hours in the week starting
`week_starts[i]`, rounded to a tenth. A task counts toward its owner (the
reviewer while it is In Review with one, else the assignee) when it is
scheduled, not Done, not paused, has remaining hours and is not archived or
in an archived project. Its remaining hours spread evenly from the week of
its `remaining_set_at`, or its start week if later, through its end week; an
estimate saved after the end week counts in the week it was saved. Compare
`hours` with `plannable_hours`, which is `null` for an agent, because agents
have no weekly limit.

Hours from projects the caller cannot see are counted the way the app counts
them. Organization admins and Standard users receive them, in both `hours`
and `hidden_hours`, without the task or project, and the answer's `hidden`
is `counted`. `hidden_hours` is the part of `hours` from those projects, so
do not add the two. Viewers and guests receive only work in projects they
can see and their own work, so `hidden` is `own_only`, and another
person's hours are a permission-limited figure, not their whole workload. With
`project`, only that project's tasks count, so `hidden_hours` is all zeros.
Weeks are computed in UTC, so an estimate saved close to midnight can land
one week away from what the app shows in another time zone.

A person's `status` is `ok` with their hours, or `unavailable` with `hours`
and `hidden_hours` set to `null` when their open work is too large to read
in one request. That is more than 2,000 open tasks, scheduled tasks in more
than 200 live projects or more than 500 scheduled tasks to check for
subtasks, the bounds the planning panel and task delays read a person's
work within.
It is also `unavailable` where checking which of those projects you can see
would take more than one request, and for the first person of a page whose
work alone does not fit in one. `unavailable` never means free time. With `project` a person can be
unavailable because of open work outside that project, since their open
work is read before the project's part of it is kept.

`people` lists every active user and agent of the organization, any
inactive one with hours in the window, and any inactive one whose hours
are `unavailable`, since those cannot be judged. People come in name order,
ignoring case and accents, then by id, and that order compares names by
their UTF-8 bytes, so it differs from a browser's sort for some scripts.

Pass `next_cursor` unchanged, URL-encoded, as `cursor` for the next page,
and stop when it is `null`. A page can hold fewer than `limit` people, or
none, while `next_cursor` is set, because each page reads a bounded amount
of people's open work however large the organization is. A page ends
before a person whose work does not fit beside the people before them, and
that person opens the next page. A short or empty page is never the end of
the list. Only a `null` `next_cursor` is. `limit` may change from one page
to the next. A guest's or Viewer's page holds at most one person, so that
where a page ends never depends on work they cannot see. Paging their
whole organization takes one request a person, and an inactive person
without hours costs them a request that lists nobody, so their pages can
be empty while `next_cursor` is set. To read one person, pass `person`
instead.

A cursor works only for the organization, caller, project and window it
came from, whether you name the project by uuid, number or key, and on
either REST or MCP. Another `weeks`, or a `from_week` in another week,
starts a new list. Without `from_week` the window is the request's week in
UTC, so pass `from_week` while you page, or a page asked for after the week
turns refuses the cursor. Pages are not a snapshot. A person added or
renamed while you page lands where their name puts them, so a page may
miss them or show them again.

`person` (a user uuid from `GET /v1/users`) answers that person alone, with
`next_cursor` `null`, also when they are inactive and have no hours. It
takes `project` with the same rule, ignores `limit` and `offset`, and
refuses `cursor`. An id that is not a user of the organization is a `404`
(`person not found`).

These requests are a `400`:

- `limit` that is not a whole number from 1 to 200: `limit must be a whole
  number of people from 1 to 200.`
- `offset` other than `0`: `offset does not apply to workload; pass
  next_cursor as cursor`
- a `cursor` that is not the `next_cursor` of an earlier page of the same
  list: `cursor must be the next_cursor of an earlier page`
- `cursor` with `person`: `cursor does not apply with person`
- a page before Qivo has prepared the organization's names for name order:
  `this list cannot be read until this organization's names are ready; try
  again in a few minutes`

Until November 2026 the workload answered every person at once, without
`next_cursor`, `hidden` or a person's `status`, and `limit`, `cursor`,
`offset` and `person` were unknown parameters. The answer kept `people`, so
code written for it reads the first page, at most 50 people, as if it were
the whole organization without any error. Follow `next_cursor` until it is
`null`.

### Stays in the app

These actions have no REST route or MCP tool. A person does them in the app
at https://qivo.io/app.

- Deleting a project, a team or a label.
- Restoring what is in Deleted items, or deleting it for good.
- Inviting a guest to a project by email.
- Adding or removing other people as followers of a task. A credential
  changes only its own follow.
- Creating or deleting an organization, changing its settings, such as the
  name, address, calendar, attachment limit, default planning hours and who
  can create projects, and exporting its data.
- Billing, subscriptions and payment details.
- Inviting people, adding agents, changing a user's name, email, role or
  **Can create projects**, making a user Inactive and removing a user.
  Plannable weekly hours are the exception (`PATCH /v1/users/{id}`,
  `update_user`).
- Creating, revoking or deleting agent keys, and revoking credentials on
  **API access**.
- A person's own name, picture, appearance, inbox retention and other
  preferences, and their personal access tokens and connected apps.
- Images inside task descriptions. Attach other files through REST or MCP.
- The **Last sync** time on the Team sync page. Changes over REST and MCP do
  not update it.

## Refusing a change when a field changed since you read it

Two callers can read the same task and both change it, and the second change
then overwrites the first without either of them knowing. To prevent that, a
change can carry `expected`, an object with the value you last read of each
field the request changes. Qivo saves the change only when nobody else
changed those fields since. `expected` arrived in October 2026. It is
optional, and a request without it saves as before.

The rule, for each key of `expected`:

- The key names a field the same request changes, and its value is the field
  as you last read it, `null` for unset.
- Qivo refuses the request when the stored value differs from the value you
  read and also from the value the request would store. Two callers who
  choose the same value both pass, and so does a field someone changed and
  changed back.
- A field without a key is not checked, so someone else's change to another
  field never refuses yours.
- If any field conflicts, the request saves nothing, its other fields, moves,
  labels and archive toggle included.

Qivo checks after the permission checks and before the first write, in the
same transaction as the change, so nothing can change in between.

These routes and tools take `expected`, with these keys:

| Route | MCP tool | Keys |
|---|---|---|
| `PATCH /v1/tasks/{ref}` | `update_task` | `title`, `description`, `status`, `priority`, `assignee_id`, `reviewer_id`, `start_week`, `end_week`, `due_date`, `remaining_hours`, `paused`, `parent_id` with `has_hidden_parent`, `project_id` |
| `PATCH /v1/comments/{id}` | `update_comment` | `body` |
| `DELETE /v1/comments/{id}` | `delete_comment` | `body` |
| `PATCH /v1/projects/{ref}` | `update_project` | `name`, `description`, `track_delay`, `review_hours`, `lead_id` |
| `PUT /v1/projects/{ref}/access/users/{user}`, `PUT /v1/projects/{ref}/access/teams/{team}` | `set_project_access` with a `level` other than `null` | `level` |
| `PATCH /v1/projects/{ref}/milestones/{id}` | `set_milestone` with `milestone` | `name`, `date` |
| `DELETE /v1/projects/{ref}/milestones/{id}` | `delete_milestone` | `name`, `date` |
| `PATCH /v1/labels/{id}` | `set_label` with `label` | `name`, `color` |
| `PATCH /v1/teams/{id}` | `set_team` with `team_id` | `name` |
| `PATCH /v1/users/{id}` | `update_user` | `plannable_hours` |

Each key belongs to the request field of the same name, with three
exceptions on a task. `parent_id` and `has_hidden_parent` belong to
`parent`, and `project_id` to `project` or `sub_project`. A delete changes
the whole record, so it takes any of its keys. `archived`, `archive_reason`,
`add_labels` and `remove_labels` take no key and are never checked. Routes
and tools that create a record take no `expected`. A request that creates a
task, comment, project, milestone, label or team and sends it is a `400`
with `expected applies only when changing an existing <record>`, such as
`expected applies only when changing an existing task`.

A value has the type a read answers, which is a string for text and dates,
a number for `remaining_hours`, `review_hours` and `plannable_hours`, a
boolean for `paused`, `track_delay` and `has_hidden_parent`, a uuid for an
id, and `null` where the field can be unset. `level` is `user`, `viewer` or `null`.
A value also follows the rule of its field, the one a write of that field
follows. `start_week`, `end_week` and `due_date` are real calendar dates
written `YYYY-MM-DD`. `remaining_hours` is a number from 0 to 99999.9,
`review_hours` a number from 0 to 999, `plannable_hours` a whole number
from 1 to 168, and a label's `color` `#` followed by six hex digits. A
task's `title`, a name and a comment's `body` are not blank once trimmed,
and a text has its field's limit from [Limits](#limits), counted the same
way: a `title` at most 255 characters, a team's, project's or milestone's
`name` at most 80, a label's `name` at most 40, and a comment's `body` and
a task's or project's `description` their fields' limits. Every read
answers values that follow these rules.

A milestone's `date` is checked for the `YYYY-MM-DD` shape only, because a
milestone saved until 2026-10-16 can hold a day that does not exist, such
as `2026-02-31`, and a stale read of it must compare.

An id key is checked for its shape only. A well-formed uuid that names no
person, task or project is compared like any other value and can answer
`409`. Qivo does not check that it exists, because a refusal that did would
tell you which ids exist.
Send each field as the read showed it:

- **A task's parent.** Send `parent_id` and `has_hidden_parent` together, as
  `GET /v1/tasks/{ref}` answered them. That is the parent's uuid with
  `false`, `null` with `true` for a parent you cannot read, or `null` with
  `false` for no parent. A parent you read by uuid matches while it stays
  the parent, even after you lose sight of it. A parent you read as hidden matches any
  parent you cannot read, so a move from one hidden parent to another is not
  detected, because telling you would reveal tasks you cannot see.
- **A group's remaining time.** An active task with subtasks reads
  `remaining_hours: null`, also while it stores hours from before its
  subtasks, so send `null`.
- **A project's lead.** `lead_id` is the lead the single-project read shows,
  so a sub-project without a lead of its own compares its parent's lead.
- **A label's color.** `color` is the color reads show, so a label stored
  before the `#rrggbb` rule compares as `#8A8F98`.
- **A milestone's day.** `date` is the `date` the project read lists for the
  milestone.
- **A grant.** `level` is the level the project's `grants` list for that user
  or team, or `null` when it lists no grant of their own.

Values compare in a normalized form, so formatting alone never refuses a
change. Titles and names are trimmed. A task's or project's description
treats `""` as `null`. A comment body is trimmed. `remaining_hours` and
`review_hours` are rounded to 0.1. Ids compare in any case, and so do label
colors.

A malformed `expected` is a `400`, and nothing is saved. Qivo answers it
before it compares anything, so a date, an hour count, a label color or text
that breaks its field's rule is a `400`, never a `409`:

- `expected must be an object of the fields as you last read them`, for
  `null`, an array or any other value that is not an object.
- `expected must name at least one field`, for `{}`.
- `unknown field "expected.<key>"; expected takes <keys>`, such as
  `unknown field "expected.colour"; expected takes name, color`.
- `expected.<key> must be <type>`, such as `expected.remaining_hours must be
  a number from 0 to 99,999.9, or null`, `expected.due_date must be a
  calendar date as YYYY-MM-DD or null` (also for a day that does not exist,
  such as `2026-02-31`), `expected.date must be a date as YYYY-MM-DD` (a
  milestone's), `expected.title must be a string that is not blank, of at
  most 255 characters`, `expected.name must be a string that is not blank,
  of at most 40 characters` (a label's), `expected.status must be one of
  backlog, todo, progress, review, done` or `expected.assignee_id must be a
  profile uuid or null`.
- `expected applies only when changing an existing <record>`, for
  `expected` on a request that creates a task, comment, project, milestone,
  label or team.
- `expected.<key> applies only when the request sends <field>`, such as
  `expected.parent_id applies only when the request sends parent`.
- `expected.parent_id and expected.has_hidden_parent go together`, when one
  of the two is missing.
- `expected.has_hidden_parent must be false when expected.parent_id names a
  task`.

Until later in October 2026, a value that broke its field's rule, such as a
`due_date` of `2026-02-31` or a `title` of `""`, was compared and could
answer `409`, and a create that sent `expected` answered `unknown field
"expected"; this request takes …`. For a few hours on 2026-10-20 and
2026-10-21, a milestone's `expected.date` naming a day that does not exist
was a `400` on `PATCH` and `DELETE`, with `expected.date must be a calendar
date as YYYY-MM-DD`.

A conflict is a `409` with one sentence in `error`. It names the fields by
their request field, never their values, and names a person only where Qivo
can prove who wrote the stored value:

```
<Name> changed <fields> of <record> since you read it, so nothing was saved; read <record> again and resend your change
<fields> of <record> changed since you read it, so nothing was saved; read <record> again and resend your change
```

The first form appears when one person wrote every conflicting field. For a
task Qivo finds that person in the task's history you may read, and for a
comment it is the person who last edited it. Other records never name
anyone. `it` becomes `them` for several fields, listed as `status and
remaining_hours` or `title, status and parent`. `<record>` is the task's key,
such as `QN-12`, `comment <id> on QN-12`, `project ENC`, `milestone
"Prototype validated"`, `label "Hardware"`, `team "Hardware"`, `the access of
Emil Strand to project PCB` or `user "Priya Patel"`. For example:

```json
{ "error": "Aisha Rahman changed status of QN-12 since you read it, so nothing was saved; read QN-12 again and resend your change" }
```

A refused delete ends `so nothing was deleted; read <record> again before
you delete it` instead of `so nothing was saved; read <record> again and
resend your change`. Do not send the
same request again, because Qivo refuses it again. Read the record, look
at the other change, decide whether yours still applies, and send it with
the new values in `expected`.

## Examples

`$QIVO_KEY` is an agent key or a personal access token.

```sh
# who this credential acts as, the calendar settings and whether it can write
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/me"

# readable projects, a page at a time in tree order; repeat with the
# answer's next_cursor as cursor until it is null
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/projects?limit=200"
curl -G -H "Authorization: Bearer $QIVO_KEY" --data-urlencode "cursor=<next_cursor>" \
  "$BASE/projects?limit=200"

# projects whose name holds "sensor"
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/projects?search=sensor"

# the project whose key is ENC, and any whose name holds "enc"
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/projects?search=enc"

# the organization's users and how many hours a week each of them has, a
# page at a time; repeat with the answer's next_cursor as cursor until it is
# null. Who may be assigned work in a project is /projects/{ref}/users.
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/users?limit=200"

# valid reporters and assignees for Enclosure
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/projects/ENC/users"

# open high-priority tasks in Enclosure, a page at a time. Repeat with the
# answer's next_cursor as cursor until it is null.
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/tasks?project=ENC&priority=high"

# archived tasks of Enclosure, a page at a time. Repeat with the answer's
# next_cursor until it is null.
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/tasks?project=ENC&archived=true&limit=200"
curl -G -H "Authorization: Bearer $QIVO_KEY" --data-urlencode "cursor=<next_cursor>" \
  "$BASE/tasks?project=ENC&archived=true&limit=200"

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

# start QN-26 only if its status is still the To Do you read; a 409 says
# someone changed it since, and nothing was saved
curl -X PATCH -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"status":"progress","expected":{"status":"todo"}}' "$BASE/tasks/QN-26"

# create a subtask of QN-26
curl -X POST -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"project":"ENC","title":"Measure hinge play","parent":"QN-26"}' "$BASE/tasks"

# move QN-26 to the PCB sub-project and label it
curl -X PATCH -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"project":"PCB","add_labels":["Hardware"]}' "$BASE/tasks/QN-26"

# QN-26 with the first 50 of each of its lists, then the next page of its
# followers, with the answer's followers_next_cursor as cursor; repeat with
# each page's next_cursor until it is null
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/tasks/QN-26"
curl -G -H "Authorization: Bearer $QIVO_KEY" --data-urlencode "cursor=<followers_next_cursor>" \
  "$BASE/tasks/QN-26/followers?limit=200"

# QN-26 waits for QN-25
curl -X POST -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"task":"QN-25","kind":"blocked_by"}' "$BASE/tasks/QN-26/links"

# archive it with the reason the app would ask for
curl -X PATCH -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"archived":true,"archive_reason":"Replaced by QN-40"}' "$BASE/tasks/QN-26"

# attach a file to QN-26: start, send the bytes, confirm
curl -X POST -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"name":"wiring.pdf","content_type":"application/pdf","size":48213}' \
  "$BASE/tasks/QN-26/attachments"
curl -X POST -H "Content-Type: application/pdf" --data-binary @wiring.pdf "<upload_url>"
curl -X POST -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"storage_id":"<storageId>"}' "$BASE/tasks/QN-26/attachments/<ticket>"

# what changed on QN-26, and who has room in the next four weeks, from
# the first page of people and then each next one with the page's
# next_cursor until it is null
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/tasks/QN-26/activity"
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/workload?weeks=4&from_week=2026-10-12"
curl -H "Authorization: Bearer $QIVO_KEY" \
  "$BASE/workload?weeks=4&from_week=2026-10-12&cursor=<next_cursor, URL-encoded>"

# give someone 30 plannable hours a week (needs an organization admin's token)
curl -X PATCH -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"plannable_hours":30}' "$BASE/users/<profile uuid>"

# follow QN-26, then read what is new and mark it read
curl -X PUT -H "Authorization: Bearer $QIVO_KEY" "$BASE/tasks/QN-26/following"
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/inbox?unread_only=true"
curl -X POST -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"tasks":["QN-26"]}' "$BASE/inbox/read"

# the newest 50 comments on QN-26, then the 20 before the first of them
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/tasks/QN-26/comments"
curl -H "Authorization: Bearer $QIVO_KEY" \
  "$BASE/tasks/QN-26/comments?limit=20&before=<first comment's id>"

# fix a typo in a comment you wrote (the id comes from the thread)
curl -X PATCH -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"body":"Measured 0.4 mm of play"}' "$BASE/comments/<comment uuid>"

# delete that comment only if nobody edited it since you read it
curl -X DELETE -H "Authorization: Bearer $QIVO_KEY" -H "Content-Type: application/json" \
  -d '{"expected":{"body":"Measured 0.4 mm of play"}}' "$BASE/comments/<comment uuid>"
```

## Side effects and audit trail

Organization API writes leave the same trail the app leaves, and they are **signed**: an
`activity_events` feed row whose actor is **the caller's user**. For an agent
key the detail is `via the REST API (<key name>)`. The name is written as
plain text: it is trimmed, each run of whitespace, line breaks included,
becomes one space, `→` becomes `-`, and curly double quotes (`“` `”`) become
`'`, so a name cannot read as a change in the row. The org-level `qv_` keys
this replaced left a null actor and that footnote, which read as "someone,
somehow" in a feed whose whole job is saying who did what; an agent is a user,
so it signs its own work. The key is still named beside it, because an agent
may hold several and "which key did this" is the question you ask when one has
to be rotated. A personal token's writes read `via the REST API` with no
token name, as MCP's read `via MCP`. The person is the actor, and the feed
reaches members who cannot see that person's tokens, so the row leaves the
name out. Only the person and organization admins can see a person's tokens.
An admin's revocation of a token or connected app is a history row that only
organization admins can read, in the organization export. A task `DELETE` also records its credential in
Deleted items, with its name cut the same way. Everyone who sees the item
there sees an agent key's name, while a personal token's name shows only to
organization admins and to the person who deleted. An update's feed
row names both sides of every changed field before the provenance, which
follows a comma, e.g. `(status To Do → In Progress, remaining 80 h → 40 h),
via the REST API (<key name>)`; description edits quote both sides as ~80-char excerpts
(`description “old…” → “new…”`). A reviewer change names both people
(`reviewer unset → Aisha Rahman`), and a move into `review` lists the review
time it set (`status In Progress → In Review, remaining 6 h → 2 h`).
A move reads `moved` `to the <sub-project> sub-project (from <sub-project>)`,
a parent change `moved` `under QN-<n>` or `detached` `from QN-<n>`, a label
`labeled` or `removed a label from` `“<label>”`, a link `linked`
`(blocks QN-<n>)` or `(relates to QN-<n>)`, and a file `attached a file to`
or `removed an attachment from` with the file name, each followed by a
comma and the provenance. Rows written before October 2026 joined the
provenance with ` — ` and read a label as `— <label>` and a link as
`— blocks QN-<n>`; they keep that text.
Comments are the deliberate exception — no activity row is written,
matching the app, where the comment itself is the feed entry on the
discussion spine. Removing a link writes no row either, as in the app. Task numbers come from the same
per-organization counter the app uses (0050), so API- and app-created
tasks share one sequence. `last_used_at` on the key or token updates on every
authenticated request.

## Storage

- `agent_keys` — one row per key, hanging off the **agent's own profile**
  (`profile_id`): name, `key_prefix` (the display fingerprint; the legacy
  column name is retained), `key_hash` (SHA-256),
  `created_by`, created/last-used/revoked timestamps (migration 0100). The
  table is indexed by hash (`by_hash`), which is how a bearer secret finds
  its row. An agent may hold several, and deleting the agent takes its keys
  with it.
- `mcp_tokens` holds one row per personal access token, hanging off the
  person's profile: name, `token_prefix` (display only), `token_hash` (SHA-256),
  `access` (`read` or `write`; absent reads as `read`), an optional
  `expires_at`, created/last-used/revoked timestamps and `revoked_by_admin`
  when an organization admin revoked it on API access. The same row serves
  MCP and REST.
- `attachment_uploads` holds one row per upload in progress: the ticket,
  the user that started it, the task, the declared name, type and size, its
  expiry, the `POST` to its upload URL that holds the URL and when it began,
  and the one file that URL stored, which the confirm must name. Confirming
  deletes it, and usually within an hour of an upload's expiry Qivo deletes
  it with the file it holds unless something else uses that file. After a
  restore of the database the file is kept for up to 7 days first.
- What a key or token may reach is **not** stored beside it. Direct grants live in
  `project_access`; team grants in `project_team_access` apply through current
  `team_members`. These are the same grants used for every person, read through
  `canSeeProject` and `hasProjectLevel`
  (`convex/lib/access.ts`), the predicates every surface calls, which apply
  the whole access model (project and sub-project leads, direct or
  explicit team grant) under the organization-role ceiling. They are asked *as the
  caller's user*, inside the request's own transaction, so the answer this API gives, the
  answer MCP gives and the answer the app gives are one computation rather
  than three kept in step.

Authentication is the one step that cannot run as the caller — you need the
row to learn who you are — so credential lookup is its own internal query
(`convex/machine/auth.ts`), run before dispatch; the endpoint function then
re-asserts the profile it was handed, so a user deleted or deactivated
between lookup and dispatch still answers `401`, in that credential's own
sentence, or `403` with `this organization is being deleted` when the
organization's deletion removed or stopped it. The old `api_keys` and
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
previously removed by a human produces a `declined` proposal. The private
operational notes describe the full image-library workflow.

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
buckets, the latest storage sample and aggregate browser/OS counts
for seven days, 30 days and 12 calendar months. Each period also carries an
empty `countries` list, kept so earlier releases can still read the report.
Workspace records, identities, IP addresses, locations, raw User-Agent strings
and credentials are excluded. The receiver
projects only these fields, validates values and timeline ordering, and caches
only a report newer than its current copy. Repeated or delayed valid reports
leave a newer copy intact.

Responses are `204` for an accepted or already superseded valid report, `401`
for missing/wrong authorization, `404` when disabled or sent to the demo
backend, `415` for a non-JSON content type, `413` for an oversized body, `408`
for a stalled upload and `400` for invalid report data. `adminDemo:metrics`
exposes the cached aggregate only through the normal app's platform-operator
gate; it adds no public REST reporting read endpoint. Setup and measurement
limitations are documented in the private operational notes.

## Conformance

The surface is pinned twice. `convex/tests/rest.test.ts` (part of
`npx vitest run`) byte-asserts every refusal sentence, the response shapes
and the activity grammar against the in-repo endpoint functions, and
`convex/tests/restTokens.test.ts` drives every route over HTTP with personal
tokens that can write, only read or belong to a Viewer;
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
the owning connection. OAuth requires `qivo:read`. Read-only credentials, such
as a Viewer agent's key or a personal token without change access,
can create, list and remove their own subscriptions without gaining rights to
change tasks. An expired personal token gets `401`.

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
`ttlMs` requests a lifetime, a whole number of milliseconds from 60,000 (one
minute) to 604,800,000 (seven days). Any other value is a `400` with `ttlMs
must be a whole number of milliseconds from 60,000 (1 minute) to 604,800,000
(7 days), or null for no expiry.` Until October 2026 Qivo moved a value
outside that range to its nearer end. Omit `ttlMs` or send null for no
expiry. MCP uses a seven-day default when this field is omitted, because MCP
clients expect a subscription to need renewal; explicit null requests no
expiry on both interfaces. Example:

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
failures return `403`, and server configuration errors return `500`. An
organization holds at most 100 unexpired subscriptions and one agent key,
personal token or OAuth connection at most 20, disabled subscriptions
included. A subscription past either quota is a `409` with `an organization
can have at most 100 unexpired webhook subscriptions, and one agent key, token
or OAuth connection at most 20. Delete an unused subscription first.`
Waiting does not help, so delete an unused subscription and send the POST
again. Until October 2026 a full quota answered `429` with `Webhook
subscription limit reached`. A subscription that keeps conflicting with
changes made at the same time also returns `500`. Sending the same POST again
is safe, because it refreshes the same subscription. GET returns an array of
`id`, `name`, `arguments`, `delivery` (mode and URL only), `refreshBefore`, `status`,
`disabled_at`, `disabled_reason`, `failed_since`, `last_failure_at`,
`last_success_at` and `last_status`. It includes disabled subscriptions and never
returns secrets. Omitted or null `ttlMs` gives no expiry and `refreshBefore: null`.
Delivery failure streaks lasting seven days disable subscriptions when a further
attempt fails. A `2xx` clears the streak. `410` stops only that event, leaving the subscription and its failure
streak unchanged. `408`, `425` and `429` retry. Repeating POST verifies the
callback and preserves pending retries before expiry. Renewing an active
subscription preserves its failure streak and health history. Verified recovery
of a disabled subscription clears the streak and re-enables delivery, while
retaining previous success, failure and HTTP-status history. Quiet callbacks
are not probed. Finite subscriptions must be renewed before expiry to remain
active through the health window. Registration removes expired registrations
and reclaims quota held by revoked, expired or deleted credentials, removed
accounts and connected apps that no longer exist in Qivo. A personal token's
subscriptions stop delivering when the token expires.
Deleting then registering again cannot revive the deleted registration's
queued events. Registering after expiry also starts fresh.
DELETE is idempotent for absent subscriptions. Another credential's existing
subscription answers `404`, even when both credentials belong to the same person
or agent. OAuth access tokens from the same grant share ownership. Access-token
expiry, rotation or individual access-token revocation does not cancel the
grant's subscriptions; disconnect the connected app or unsubscribe. A new OAuth
connection is a new owner.

The `/v1/webhooks/organization` routes require a personal token or OAuth
connection belonging to an active person with the organization administrator
role. Agent keys cannot use these routes. Deleting another owner's
subscription changes shared state, so it also needs a credential that can
make changes: a personal token with change access, or an OAuth connection
with `qivo:write`. A read-only
personal token gets `403` with `{"error": "this credential can only read"}`
and a read-only OAuth connection gets
`OAuth connection does not have the required scope`. Listing works with a
read-only credential. These
routes let administrators inspect and remove subscriptions that consume shared
quota, including callbacks owned by inactive users. They do not expose signing
keys or transfer subscription ownership. Each listed subscription also has
`owner` with `profile_id`, `credential_type` and `credential_id`. The list
shows `status: "unauthorized"` for a subscription whose owner can no longer
authorize it, because its credential was revoked, expired or deleted, its
account was removed, or its connected app no longer exists in Qivo. Such a
subscription receives no events and holds no quota, and the next registration
in the organization removes it. The list shows `status: "suspended"` for an
active subscription whose owner Qivo refuses for now, for example because the
owner's account is inactive. Such a subscription receives no events but keeps
its quota, and it resumes delivery once its owner is allowed again.

Event names are `task.created`, `task.updated`, `task.deleted`,
`task.restored` and `comment.created`. `task.deleted` means the task moved to
Deleted items, and `task.restored` that a person restored it there. Filters take task and exact sub-project UUIDs. Parent
meta-project filters are refused because they cannot contain tasks. The shared
[MCP Events delivery contract](mcp.md#task-events-and-webhook-delivery) describes
payloads, access checks, retry limits, expiration, exclusions and lack of replay.
There are no application-specific bridges or UI settings for webhook management.
