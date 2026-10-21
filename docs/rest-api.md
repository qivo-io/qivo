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
a deactivated user. The sentence depends on the credential:

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

A request that keeps conflicting with changes other requests make to the
same data at that moment, such as many comments posted to one task at once,
is a `503` with `Retry-After: 1` and `{"error": "the request conflicted with
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

An exceeded limit returns HTTP `429` with `Retry-After: 60`; wait 60 seconds
before retrying. Every authenticated request that passes rate limiting counts
as one API call, including requests that later fail validation, routing or
permission checks. During a paid billing period, these calls count toward the
organization's pooled API allowance. Without a paid billing period, calls are
counted per calendar month (UTC) and are never charged. Requests rejected for
missing/invalid credentials or rate limiting are not counted. The separate
curation API keeps its own limits below.

A request body may hold at most **1 MiB** (1,048,576 bytes of UTF-8). Qivo
checks the size after authentication, before routing, and answers a longer
body with `413` `{"error": "request body is too large"}`. Such a request
still counts as a call. A declared `Content-Length` over the limit is refused
without reading the body. Files never travel in these bodies; see
[Attachments](#attachments).

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
A `GET` request's body is never read. Every route also refuses a query
parameter it does not take, such as `unknown query parameter "stauts"; this
request takes project, status, …`, or `…; this request takes no query
parameters`, so a misspelled filter never answers an unfiltered list. Fields a
route refuses with their own sentence, such as `project_id` on a task, keep
that sentence. Before October 2026 most routes ignored unknown fields and
query parameters, and a body that was not UTF-8 was stored with U+FFFD in
place of each bad byte sequence.

When organization billing is enabled, unpaid or expired access pauses writes
with a readable HTTP `403` billing refusal. Reading remains subject to the
existing access rules. An organization admin can subscribe or update payment
details under **Settings → Organization → Billing**; machine credentials
cannot manage subscriptions. Billing also shows usage by account and key, and
**API access** shows each credential's calls in the current or an earlier
period. While writes are paused, an organization admin can still revoke any
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
  is refused with `403`.
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
GET   /v1/projects                → readable ACTIVE projects, with access flags
GET   /v1/projects?archived=true  → the archived ones instead (0106)
GET   /v1/projects/{id|num|KEY}   → one project (uuid, per-org number, or
                                    key) with its lead, settings,
                                    completion, milestones and grants; an
                                    explicit ref resolves an archived
                                    project too
GET   /v1/projects/{ref}/users    → users with access to that project, for
                                    reporter, assignee and reviewer
                                    selection
POST  /v1/projects                → create a project or sub-project (write)
PATCH /v1/projects/{ref}          → change its settings or lead, archive or
                                    restore it (write)
```

A row of the list:

```json
{
  "id": "…uuid…", "key": "ENC", "num": 2, "name": "Enclosure", "type": "project",
  "parent_id": "…uuid…", "team_id": null, "description": "",
  "archived": false, "archived_at": null,
  "access": { "read": true, "write": false }
}
```

`GET /v1/projects/{ref}` answers the same row with these fields added:

```json
{
  "lead_id": "…uuid…", "lead_name": "Leo Martins",
  "review_hours": null, "effective_review_hours": 2, "track_delay": true,
  "completion": { "done": 12, "total": 30, "percent": 40 },
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
  and `done` counts those that are Done. A task whose only subtasks are
  hidden from you still counts as a group and is left out, as in the app.
  `percent` is rounded, and `0` when `total` is `0`. It is `null` for an
  archived project. A new project answers zeros, because it holds no tasks.
- `milestones` are the milestones of the top-level project, ordered by date.
  A sub-project shows its parent's, because milestones live on the top-level
  project's roadmap.
- `grants` are the project's own individual and team grants, as its
  **Project access** list shows them, ordered by name. A sub-project also
  inherits its parent's grants, which the parent's own read lists. Anyone who
  can read the project sees its grants, as in the app.

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
itself: organization admins, its lead and its individual or team grants. These
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
- A sub-project needs Lead access on its parent, whatever the setting, and the
  parent must be an active top-level project. A parent the caller cannot read
  answers `400` with `parent project not found`, exactly like an unknown one.
- `lead_id` defaults to the caller. A lead must be an active admin, standard
  user or guest of the organization; a Viewer is refused with `a viewer cannot
  lead a project, so make them a standard user first`. Only a person may name
  someone else, so an agent leads every project it creates and is refused
  with `only people can change who has access, not agents` otherwise. An
  agent that leads projects cannot be made a Viewer until an organization
  admin hands them over, so setting it to Inactive is the way to stop it at
  once.
- A creator who is not an organization admin and names someone else as the
  lead of a top-level project gets User access to it, as in the app, so the
  project stays in their sight.
- `name` is trimmed, may not be blank and holds at most 80 characters (`a
  project name must be at most 80 characters`). Names count Unicode code
  points, so most single emoji count as one character, while flags, skin
  tones and joined emoji count as several. `description` is at most 500
  characters, and `null` means none.
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
project needs Lead access (`requires lead access to this project`), which
organization admins have. A lead handover alone on a top-level project
follows the rule for managing its users instead, so someone who is neither an
organization admin nor its lead gets `no permission to manage users on this
project`.

- `name` follows the rule for creating. A project named before the
  80-character limit keeps its longer name until it is renamed, and sending
  that same name back is accepted.
- `review_hours` is a number of hours from 0 to 999, kept to 0.1 h, or `null`
  to use the parent's or the default again.
- `archived: true` archives the project, and a top-level project's active
  sub-projects with it; `archived: false` restores it, with the sub-projects
  archived along with it, and a sub-project's archived parent too (which
  needs Lead on the parent). Qivo archives or restores before it changes the
  other fields, so one request may restore and rename, or archive and hand
  over the lead. A project takes no archive reason, as in the app, where only
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
  lists those tasks as `stranded`. They keep their assignee and reviewer.
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
fewer when the change is too large for one request, so keep the people as
Viewers or reassign some of the tasks first` (without the Viewer choice when
you cannot give it) and nothing changes. Keeping people as Viewers is refused
the same way when their grants do not fit in one request, with `a removal can
keep only as many people as Viewers as fit in one request, so remove some of
these people first or reassign the tasks`. A team's removal that keeps people
as Viewers or reassigns their tasks is a `400` when more than 700 of its
members hold open tasks in those projects, with
`a removal that keeps people as Viewers or reassigns their tasks can take
access from at most 700 people with open tasks at once, so leave the tasks
with them, or remove some of the team's members first`. Leaving the tasks has no such number. Any removal whose
people and tasks are too many to check in one request is a `400` with
`a removal can check only as many people and tasks as fit in one request, so
remove fewer people at once, such as some of a team's members, or reassign
some of the tasks first`. Nothing changes after either refusal. The answer is
`{"project_id", "user" | "team", "removed", "stranded", "kept_as_viewer",
"reassigned"}`, where `stranded` and `reassigned` list `{"id", "key",
"title", "user_id", "role"}`, and `kept_as_viewer` the user uuids given a
Viewer grant. Removing access that is not there answers `removed: false`.
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
week. `name` is trimmed, may not be blank and holds at most 80 characters (`a
milestone name must be at most 80 characters`); a milestone named before
that limit keeps its longer name through a `PATCH` that sends it back
unchanged. `POST` answers `201` and `PATCH` `200` with `{"id", "name",
"date", "project_id"}`, where `project_id` is the top-level project;
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
GET    /v1/teams                      → every team, with its members
GET    /v1/teams/{id}                 → one team
POST   /v1/teams                      {"name": "…"}
PATCH  /v1/teams/{id}                 {"name": "…", "expected"?: {"name": "…"}}
PUT    /v1/teams/{id}/members/{user}  [{"leader": true | false}]
DELETE /v1/teams/{id}/members/{user}  [{"on_held_tasks": …}]
```

A team is `{"id", "name", "members"}`, and `members` lists `{"id", "name",
"leader"}` by name. Everyone in the organization reads every team and its
members, as in the app. `leader` is `true` for a person who leads the team.
Only people with the organization admin or Standard user role lead teams, so
an agent or a Viewer never reads `true`. A guest is never a member, so an old
membership a guest still holds is not listed. Teams are named by uuid
only, because two teams may share a name. An unknown uuid, or one from
another organization, answers `404` `team not found`, and a `{user}` outside
the organization answers `404` `user not found`.

Only organization admins create teams; anyone else gets `only organization
admins can create teams`. An organization admin or a leader of the team
renames it with `PATCH`, and anyone else gets `requires an organization admin
or a leader of this team`. `name` is trimmed and may not be blank (`a team
name cannot be blank`) or longer than 80 characters (`a team name must be at
most 80 characters`), unless it is a longer name the team had before that
limit, sent back unchanged. `PATCH` changes only `name`, and its optional
`expected` holds the `name` you last read, so the rename saves nothing when
someone renamed the team since (see [Refusing a change when a field changed
since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it)).
Any other field is a `400` (`unknown field "nmae"; this request takes name,
expected`), and a body without `name`, such as `{}`, is a `400` (`no
recognized fields to update`). Deleting a team stays in
the app ([Stays in the app](#stays-in-the-app)). `POST` answers `201` and
`PATCH` `200` with the team. Neither writes an activity row, as in the app.

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

- `"leave"` (the default, also for an empty body) lists them as `stranded`.
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
"reassigned"}`, shaped as for project access; removing someone who is not a
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
GET   /v1/users       → the organization's users, people and agents alike
GET   /v1/users/{id}  → one of them
PATCH /v1/users/{id}  → set that person's plannable_hours (write)
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
`400` with `plannable hours must be a whole number of hours from 1 to 168`.
Like the app and MCP's `update_user`, it takes an organization admin or a
leader of a team the person belongs to (migration 0094), and nobody else,
yourself included. Anyone else gets `403` with `only an organization admin
or a leader of one of this person's teams can set their plannable hours`,
whoever the target is. An unknown or foreign id is `404` `user not found`.
An agent has no plannable week (0103), so naming one is a `400` with `an
agent has no plannable week, because its capacity is unbounded`. The change writes
no activity row, as in the app.

In practice this route needs a person's token. An agent is **never an
organization admin**, because an admin reaches every project without a
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
                                           substring; * acts as a wildcard)
       &archived=true                      the ARCHIVED tasks instead (0070),
                                           one project at a time. It needs
                                           `project=` and answers a page
                                           (see Archived tasks below). The
                                           default lists active ones only.
                                           A task's archive and its PROJECT's
                                           are different axes. This flag is
                                           the first, `project=` the second
       &limit=100 &offset=0                limit ≤ 200; offset pages active
                                           lists only
       &cursor=<next_cursor>               the next page of archived tasks
GET    /v1/tasks/{ref}                     ref: QN-482 | 482 | uuid — resolves
                                           archived tasks too; adds labels,
                                           subtasks, links and attachments
                                           (below)
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
literal. A search of active tasks whose label names it would have to read for
too many tasks at once is a `400` with `this search reads too many label
assignments to answer in one request; name a project or add a filter`.

Active lists come in creation order, oldest first, with tasks created at the
same moment ordered by number, so `offset` pages through them. MCP's
`list_tasks` uses the same order. Page with `offset` until a page holds fewer
tasks than `limit`. Each row's `last_comment_at` reads the task's newest
comment, and a row whose parent is in an archived project reads that
parent. When those reads do not fit in one request beside the rest of
the page, the request is a `400` (`this page of tasks is too large to read
at once; ask for a smaller limit`); ask again with a smaller `limit`. A list
also reads every active task in the organization's active projects, or every
active task of the organization when it names an archived project or the
organization has more than 1,000 active projects. When
those alone leave no room for a single comment, the request is a `400` with
`this organization's active tasks are too large to list in one request`, and
a smaller `limit` does not help. When the request instead runs out of index
reads, which follow the active projects, your team memberships and the labels
a search matches, the `400` says `this organization has too many projects,
teams or labels to list its tasks in one request`.

#### Archived tasks

`archived=true` lists archived tasks one project at a time and needs
`project`. Naming a project lists its archived tasks and those of all its
sub-projects you can read, archived sub-projects included. The app's Archived
tasks page leaves out a sub-project archived on its own. Tasks come most
recently archived first, and tasks archived at the same moment keep one fixed
order across pages. The answer is an object instead of an array, with the
same rows as an active list:

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
tasks under it than one request can read, such as thousands of subtasks or
hundreds with very long descriptions, its row has `start_week` and `end_week`
set to `null` and a `progress` of `0` of `0` with `partial: true`, so paging
still moves past it.

To find every archived task you can read, take two steps. First list
projects with `GET /v1/projects` and `GET /v1/projects?archived=true`.
Archived tasks can sit in active projects as well as archived ones, and both
lists include sub-projects. Then page `archived=true` for each top-level
project, the rows whose `parent_id` is `null`. Each covers all its
sub-projects you can read, even when you can read only some of them. To read
one sub-project's archive alone, name that sub-project.

These requests are a `400`:

- `archived=true` without `project`: `archived=true needs project, because
  archived tasks are listed one project at a time`
- `cursor` without `archived=true`: `cursor works only with archived=true`
- `offset` other than `0` with `archived=true`: `offset does not apply to
  archived tasks; pass next_cursor as cursor`
- a `cursor` that is not a `next_cursor`: `cursor must be the next_cursor of
  an earlier page`

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
parent task already has 100 active subtasks, the most a task can have;
archive or remove one of them first`.

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
an organization admin can move it`). A subtask in a project that is being
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
project carries them all; restore some archived subtasks and remove them
from this task first, or move it within its project`). A move whose task and subtasks are
too large for one request, such as about 120 or more subtasks with
descriptions near 20,000 characters, is a `400` with `this task and its
subtasks are too large to move to another project in one request; remove
some subtasks from this task first, restoring archived ones to do so, or
move it within its project`. Each moved subtask
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
already has 20 labels, the most a task can have; remove one first`) that
changes nothing.

**Order.** One PATCH may combine all of this. It applies the move first,
then the parent, then the other fields with the archive toggle, then the
labels, and finally posts `archive_reason`. All of it lands or none of it
does. Each step that changes something writes its own activity row, and a
PATCH that changes nothing writes none. `title` is trimmed and capped at 80
characters (a longer one is a `400`; the same shared rule holds in the app
and over MCP). `description` is markdown of at most 20,000 characters, on
POST and PATCH (a longer one is a `400`, `description must be at most 20,000
characters`). Characters are counted as UTF-16 code units, the length
JavaScript reports, so a character outside the Basic Multilingual Plane,
such as most emoji, counts as two. A task saved earlier with a longer
description keeps it. Sending that same text back is accepted, and any other
text over the limit is refused. `status` ∈ backlog · todo · progress ·
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
overflow such as `1e309` included, is a `400` with `remaining_hours must be
a number of hours from 0 to 99999.9, or null`. MCP gives the same sentence
for any such number. A task given more than 99999.9 hours before the cap was
added in October 2026 reads them back as stored. A PATCH may send them back
unchanged or set any value from 0 to 99999.9, and any other value above the
cap is refused, a lower one included. Sent unchanged with a stale
`expected`, they answer `409` like any changed field. Until then REST took
any finite nonnegative number and refused other values with
`remaining_hours must be a non-negative number or null`. `remaining_hours` was named
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
with `archiving this task would change a subtask in a project you cannot edit; an
organization admin can archive it` or `restoring this task would change a
parent task in a project you cannot edit; an organization admin can restore
it`, and nothing changes. A subtask or parent in a project that is being
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
characters`) and the PATCH changes nothing, also for a task that is already
archived. Until October 2026 the limit was 20,000 characters.

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
the single-task shape, which adds eight fields:

```json
{
  "group_remaining_hours": null,
  "labels": [{ "id": "…uuid…", "name": "Hardware", "color": "#4C9AFF" }],
  "subtasks": [{ "id": "…uuid…", "key": "QN-4", "title": "…", "status": "todo" }],
  "has_more_subtasks": false,
  "links": [{ "kind": "blocked_by", "id": "…uuid…", "key": "QN-9", "title": "…", "status": "progress" }],
  "following": true,
  "followers": [{ "id": "…uuid…", "name": "Priya Patel" }],
  "attachments": [{ "id": "…uuid…", "name": "wiring.pdf", "size_bytes": 48213, "…": "…" }]
}
```

`following` says whether the caller follows the task, and `followers` lists
everyone who does, by name, as the app's follower list shows them. See
[Following](#following). `attachments` lists the task's files with download
links, in the shape [Attachments](#attachments) describes.

`owner_id` is whose work the task is. It is the reviewer while the task is in
`review` with a reviewer set, else the assignee, and always the assignee on a
group. `url` is the address the app's **Copy link** gives. `parent_id` is
the parent task's uuid when the caller can read the parent. Otherwise it is
`null` and `has_hidden_parent` is `true`, so a subtask under a task the
caller cannot read is not mistaken for a top-level task.

The single-task fields name only tasks the caller can read. `subtasks` lists
the direct subtasks it can read, by number. An active task lists its active
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
such as thousands of subtasks or hundreds with very long descriptions. Its
single-task shape then still lists its direct `subtasks`, but `start_week`
and `end_week` are `null`, `progress` is `0` of `0` with `partial: true`
and `group_remaining_hours` is `null`. When even its direct subtasks do not
all fit, `subtasks` lists the first ones that do, at least one, and
`has_more_subtasks` is `true`. Find the rest in the project's archived list
(`?archived=true&project=<ref>`), where each one's `parent_id` names the
group. `has_more_subtasks` is `false` on every other task. The answer of a
`PATCH`, such as one that archives such a group, takes the same shape.

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
POST   /v1/tasks/{ref}/links                 { "task": "QN-9", "kind": "blocked_by" }
DELETE /v1/tasks/{ref}/links/{kind}/{other}  remove that link
```

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
100 links, the most a task can have; remove one of its links first`). `DELETE` answers `{ "removed": true |
false, "kind": "…", "id": "…", "key": "QN-9", "title": "…", "status": "…" }`
naming the other task; `removed` is `false` when no link of that kind
existed. Adding a link writes a `linked` activity row against the blocking
task (for `relates`, against the one whose uuid sorts first), with the
provenance; removing one writes none, as in the app.

### Labels

The organization's labels, which any member may read:

```
GET   /v1/labels         every label, ordered by name
POST  /v1/labels         { "name": "Hardware", "color": "#4C9AFF" }
PATCH /v1/labels/{id}    { "name": "…", "color": "…", "expected"?: {…} };
                         {id} is an id or name
```

A label is `{ "id": "…uuid…", "name": "Hardware", "color": "#4C9AFF" }`.
Names are trimmed, at most 40 characters and unique in the organization in
any case. A color is `#` followed by six hex digits; a label stored before
that rule reads as `#8A8F98`. Creating a label needs an organization admin,
or a person or agent with the User role and Edit access to a top-level
project (a sub-project alone is not enough), and answers `201`; it
writes a `created label` activity row with the provenance. Renaming and
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
to 50 is a `400` (`limit must be a whole number from 1 to 50`), and so is a
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
characters`). Comments go to Deleted items with their task and come back
with it. A task has no limit on the number of comments.

`PATCH /v1/comments/{id}` replaces a comment's body and answers the comment;
`DELETE /v1/comments/{id}` answers `{ "deleted": true, "id": "…", "task_id":
"…" }`. `{id}` is the comment's `id` from the thread. As in the app, the
comment's author may edit or delete it, and so may a lead of the task's
project (an organization admin leads every project); anyone else gets `403`
(`only the author or a project lead can edit this comment`, or `delete`). A
comment on a task the caller cannot read answers `404` (`comment not found`),
like an unknown id. The body is trimmed and may not be blank (`400` `a comment
cannot be empty`). Sending the text it already has changes nothing, even for
a comment saved earlier with more than 20,000 characters. An edit
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
text mentions more is a `400` (`a text can mention at most 100 people; remove
some mentions and save again`) and saves nothing. Sending a stored text back
unchanged is accepted, as for the length limit. Whoever a task passes
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

All of it happens server-side, inside the same transaction as the write, so
it needs nothing from the caller. The exceptions are follower messages on a
task with more than 128 followers, past the first 128, and every follower
message of a roadmap save, an access removal or the subtasks a task delete
detaches, which arrive moments later
(see [Inbox](#inbox)). Unknown or out-of-org uuids in mention
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
already has 100 followers, the most a task can have`. Tasks with more
followers from before this limit keep them. The caller's own follow is the only one these
routes change; managing other people's follows stays in the app. The
single-task read shows `following` and `followers`. Qivo also makes the
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
first 128 at once and the rest moments later. The followers of the tasks a
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
`limit` (1 to 200, 50 by default) and `offset`. It answers:

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
then missing, and an item listed may lack its older messages. The app's
Inbox loads up to 500 of the same messages, unread ones first. Marking items
read keeps only each item's latest message, so `POST /v1/inbox/read` with
`{"all": true}`, repeated while `has_more` is `true`, shrinks the inbox until
it fits.

The `POST` routes change the caller's own items and answer `{ "action":
"read", "tasks": ["QN-3"], "has_more": false }`, where `tasks` lists the
items the call changed. `tasks` in the body are task refs, at most 100 per
call with repeats counted. A longer list is a `400` (`tasks must name at
most 100 tasks per call`), and so is a task the caller cannot read (`tasks
must name tasks by key, number or uuid`); neither changes anything. Name the
items with `tasks`, or send `"all": true` instead:

- `read` marks the named items read. Like opening an item in the app, it
  keeps only each item's latest message. With `all`, it marks every item
  read except snoozed ones, up to 256 messages per call, and the answer
  adds `before`, a number. Send it back unchanged as `"before"` with each
  later call, so messages that arrive meanwhile stay unread. `before` with
  `tasks` or another action, or one that is not a number from 0 up, is a
  `400`.
- `unread` marks the named items unread again.
- `remove` removes the named items. With `all`, it removes every read
  message except snoozed ones, up to 256 per call, and leaves unread
  messages alone.
- `snooze` hides the named items until `until`, an ISO date-time in the
  future and at most a year ahead, and marks them unread so they return
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
GET    /v1/tasks/{ref}/attachments                every file, oldest first (read)
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

`size_bytes` is measured from the stored file. `inline` is `true` for an
image inside the task description, which the description names as
`![alt](att:<id>)`. `url` is a download link minted for the caller that
works for 10 minutes (`url_expires_at`); read the task or the list again for
a fresh one. Each download checks again that the caller's user is active and
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
   can have; remove one first`), and the confirm in step 3 checks it again.
   A `size` over the organization's per-file limit (`max_attachment_mb` in
   `GET /v1/me`, at most 20 MiB) is a `400` (`attachment exceeds the
   organization limit of 20 MiB`). The 20 MiB ceiling is Qivo's product
   rule: attachments are for images, PDF files and similar documents, and
   Qivo is not a file store. It answers `201` with `{ "ticket": "…uuid…", "upload_url":
   "…", "expires_at": "…" }`.
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
  answers `400` (`the file's media type must be at most 255 characters`),
  and a body that takes more than 5 minutes to arrive answers `400` (`the
  upload took too long; send it again`). These store nothing, and the URL
  can be tried again, as after any other failed `POST`. A `POST` that ends
  without an answer and without storing a file, for example when the
  connection drops, holds the URL for at most 15 minutes.
- An expired or altered upload URL, and one whose upload was confirmed,
  answers `404` (`upload not found or expired; start a new upload`).

Qivo reads the body of a `POST` to the upload URL in one of its own request
handlers, which stays busy until the whole file has arrived, for at most the
5 minutes above. A 20 MiB file therefore needs about 70 KB/s or more. Many
large uploads at once from one organization share the deployment's handlers
with every other request, so send them a few at a time.

Only the user that started the upload can confirm it, only for the same
task, and only once. Any other ticket, including an expired one, answers
`404` (`upload not found or expired; start a new upload`). A confirm before
the upload URL has stored a file answers `400` (`no file has been sent to
this upload URL; send it there, or start a new upload`). `storage_id` must
be the `storageId` the upload URL answered, and any other value answers
`400` (`storage_id must be the storageId the upload answered`). Without a
`content_type`, the attachment takes the upload's `Content-Type`.
If the organization lowered its per-file limit after the upload
started and the file now exceeds it, Qivo deletes the file, answers `400` and
spends the ticket.
Bytes uploaded but never confirmed are deleted by the weekly storage sweep.
Attaching writes an `attached a file to` activity row with the file name and
the provenance.

MCP offers the same upload through `start_attachment_upload` and
`confirm_attachment_upload`, which is how an OAuth connection attaches files
([MCP attachments](mcp.md#attachments)). A ticket belongs to the user, not
the credential, so the same user can confirm a ticket started over MCP here,
and the reverse.

`DELETE` needs Edit access to the task's project, as in the app, where
anyone with Edit may remove any file, not only their own. It deletes the
file and answers `{ "deleted": true, "id": "…", "name": "wiring.pdf", "key":
"QN-26" }`, writing a `removed an attachment from` activity row. An id that
is not a file of that task is a `404` (`attachment not found`). A
description image (`inline: true`) is a `400` (`this image belongs to the
task description; remove it by editing the description in the app`).

Description images stay with the app. The API neither uploads nor deletes
them. When a `PATCH` rewrites a description, keep every `![alt](att:<id>)`
reference whose image should stay. A description save, from the app or the
API, that takes out an image's last reference removes the image from the
task at once: it no longer counts toward the 100 attachments and no longer
appears in `attachments`. A save within a day that names it again brings it
back, unless the task has 100 attachments by then, which is a `400` with the
full-task sentence above. After a day the image is deleted. An image that no
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
from the organization. Organization admins receive
every row. Other users do not receive a row that names a project they cannot
access, such as the project the task was in before a move, or one that names
another task they cannot read, such as the other end of a link. An
archived task's history is answered too, by the same rule; the app shows it
again once the task is restored. A task keeps all its activity rows, and an
answer holds at most 500 of them. To read further back, pass the `id` of the
first row in the array as `before`, and repeat until the array is empty. Only
an empty array means there is no earlier history. A `before` that is not the
`id` of a row in this task's history is a `400` (`before must be the id of a
row in this task's history`). The request reads on past rows you do not
receive. When it cannot find one row you receive before it has read as much
as one request may, it is a `400` (`too many of this task's changes are
hidden from you to read them at once; an organization admin can read them`).
Deleting a task for good from Deleted items deletes its history.
See [Side effects and audit trail](#side-effects-and-audit-trail) for the
wording.

### Workload

```
GET /v1/workload?from_week=2026-10-12&weeks=8&project=ENC     (read)
```

Each person's planned hours per week, as the Roadmap's Team strip and the
planning panel count them. `from_week` is any day of the first week, by
default the current week; weeks begin on the organization's
`week_start` (`GET /v1/me`). `weeks` is 1 to 52, 8 by default. A window
with a week that starts before 0000-01-01 or after 9999-12-31 is a `400`
(`the workload window must fall within the years 0000 to 9999`), because its
`week_starts` could not be written as `YYYY-MM-DD`. `project` (uuid, number
or key) limits the hours to that project and its sub-projects; one the
caller cannot see is a `404`.

```json
{
  "week_starts": ["2026-10-12", "2026-10-19"],
  "project": null,
  "people": [
    {
      "id": "…uuid…", "name": "Leo Martins", "org_role": "user", "kind": "person",
      "active": true, "plannable_hours": 32,
      "hours": [30, 22], "hidden_hours": [4, 0]
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
and `hidden_hours`, without the task or project. `hidden_hours` is the part
of `hours` from those projects, so do not add the two. Viewers and guests
receive only work in projects they can see and their own work. With
`project`, only that project's tasks count, so `hidden_hours` is all zeros.
`people` lists every active user and agent of the organization, and any
inactive one with hours in the window, ordered by name. Weeks are computed
in UTC, so an estimate saved close to midnight can land one week away from
what the app shows in another time zone.

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
boolean for `paused`, `track_delay` and `has_hidden_parent`, a string for
an id, and `null` where the field can be unset. `level` is `user`, `viewer` or `null`.
A value also follows the rule of its field, the one a write of that field
follows. `start_week`, `end_week` and `due_date` are real calendar dates
written `YYYY-MM-DD`, and a milestone's `date` is written `YYYY-MM-DD`.
`remaining_hours` is a number of at least 0, `review_hours` a number from 0
to 999, `plannable_hours` a whole number from 1 to 168, and a label's
`color` `#` followed by six hex digits. A task's `title`, a label's `name`
and a comment's `body` are not blank once trimmed. A `title` has at most 80
characters and a label's `name` at most 40, counted as code points once
trimmed.

Some rules are looser here than for a write, because a record saved before
its field's rule reads back as stored and a stale read of it must compare.
A team's, project's or milestone's `name` takes any string, blank or long,
because these names could be blank until 2026-10-16 and longer than 80
characters until 2026-10-19. A milestone's `date` may name a day that does
not exist, such as `2026-02-31`, because one saved until 2026-10-16 can. `remaining_hours` has no upper limit, because a task
given more than 99999.9 hours before the cap reads them back. A comment's
`body` and a task's or project's `description` have no length limit,
because a record saved before their caps reads back longer. An id takes
any string, because a person, project or task made until 2026-10-19 may
have an id that is not a uuid, and so may every field that names it. Every
read answers values that follow these rules.

An id key is checked for its type only. An id that names no person, task or
project is compared like any other value and can answer `409`. Qivo does
not check that it exists, because a refusal that did would tell you which
ids exist.
Send each field as the read showed it:

- **A task's parent.** Send `parent_id` and `has_hidden_parent` together, as
  `GET /v1/tasks/{ref}` answered them. That is the parent's id with
  `false`, `null` with `true` for a parent you cannot read, or `null` with
  `false` for no parent. A parent you read by id matches while it stays
  the parent, even after you lose sight of it. Send a parent's id as you
  read it: an id that is not a uuid, which a task made until 2026-10-19 can
  have, is only recognized as a parent you can read in the case you read
  it, and in another case it counts as a parent you cannot read. A parent you read as hidden matches any
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
  a non-negative number or null`, `expected.due_date must be a calendar date
  as YYYY-MM-DD or null` (also for a day that does not exist, such as
  `2026-02-31`), `expected.date must be a date as YYYY-MM-DD` (a
  milestone's), `expected.title must be a string that is not blank, of at
  most 80 characters`, `expected.name must be a string that is not blank, of
  at most 40 characters` (a label's), `expected.status must be one of backlog, todo, progress, review, done` or
  `expected.assignee_id must be a profile id or null` (for a value that is
  not a string or `null`).
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
2026-10-21, a blank `expected.name` of a team, project or milestone was a
`400` with `expected.name must be a string that is not blank`, and so was a
milestone's `expected.date` naming a day that does not exist, on `PATCH`
and `DELETE`, with `expected.date must be a calendar date as YYYY-MM-DD`.
Both compare again, because records saved before their rules can read back
that way. From 2026-10-20 an id key, such as `expected.assignee_id`,
`expected.parent_id`, `expected.project_id` or `expected.lead_id`, had to
be a uuid, and other text was a `400` with `expected.assignee_id must be a
profile uuid or null` and the like. It now takes any string for the same
reason.

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
Emil Strand to project PCB` or `user "Priya Patel"`. A team or milestone
whose name is blank, as one saved until 2026-10-16 can be, reads as `team
<id>` or `milestone <id>`, and its access as `the access of team <id> to
project PCB`. For example:

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

# readable projects
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/projects"

# who can be assigned work, and how many hours a week each of them has
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/users"

# valid reporters and assignees for Enclosure
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/projects/ENC/users"

# open high-priority tasks in Enclosure
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

# what changed on QN-26, and who has room in the next four weeks
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/tasks/QN-26/activity"
curl -H "Authorization: Bearer $QIVO_KEY" "$BASE/workload?weeks=4"

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
key the detail is `via the REST API (<key name>)`, with a key name longer than
80 characters cut to its first 80 followed by `…`. The name is written as
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
  deletes it; the weekly storage sweep deletes expired ones.
- What a key or token may reach is **not** stored beside it. Direct grants live in
  `project_access`; team grants in `project_team_access` apply through current
  `team_members`. These are the same grants used for every person, read through
  `canSeeProject` and `hasProjectLevel`
  (`convex/lib/access.ts`), the predicates every surface calls, which apply
  the whole access model (org admin, project and sub-project leads, direct or
  explicit team grant) under the organization-role ceiling. They are asked *as the
  caller's user*, inside the request's own transaction, so the answer this API gives, the
  answer MCP gives and the answer the app gives are one computation rather
  than three kept in step.

Authentication is the one step that cannot run as the caller — you need the
row to learn who you are — so credential lookup is its own internal query
(`convex/machine/auth.ts`), run before dispatch; the endpoint function then
re-asserts the profile it was handed, so a user deleted or deactivated
between lookup and dispatch still answers `401`, in that credential's own
sentence. The old `api_keys` and
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
configuration errors return `500`. A subscription that keeps conflicting with
changes made at the same time also returns `500`. Sending the same POST again
is safe, because it refreshes the same subscription. GET returns an array of
`id`, `name`, `arguments`, `delivery` (mode and URL only), `refreshBefore`, `status`,
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
and reclaims quota held by revoked, expired or deleted credentials and removed
accounts. A personal token's subscriptions stop delivering when the token
expires.
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
keys or transfer subscription ownership.

Event names are `task.created`, `task.updated`, `task.deleted`,
`task.restored` and `comment.created`. `task.deleted` means the task moved to
Deleted items, and `task.restored` that a person restored it there. Filters take task and exact sub-project UUIDs. Parent
meta-project filters are refused because they cannot contain tasks. The shared
[MCP Events delivery contract](mcp.md#task-events-and-webhook-delivery) describes
payloads, access checks, retry limits, expiration, exclusions and lack of replay.
There are no application-specific bridges or UI settings for webhook management.
