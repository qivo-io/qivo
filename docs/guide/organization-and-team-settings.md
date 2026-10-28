Open **Settings → Organization → General** to change the organization's name,
address, attachment limit, calendar, who can create projects and default
planning hours. Organization, team, project and milestone names allow up to
80 characters ([Limits](./limits.md)).

- **Date format** offers six formats with a preview.
- **Workdays start on** sets the first day of each roadmap week.
- **Week 1 of the year** offers **First 4-day week (ISO 8601)**,
  **Week containing Jan 1** or **First full week**.

A project has at most one milestone in each week, so Qivo refuses a new
first day that would put two milestones of one project in the same week. It
checks every project, archived projects and projects in Deleted items
included, keeps the old day and lists the projects, dates and weeks under
the setting. Move or delete one milestone of each pair, then choose the day
again. In an organization too large to check at once, the day cannot be
changed here and the setting says so. **Week 1 of the year** only numbers the
weeks, so changing it is never refused.

**Max attachment size** limits each new task attachment or description image
to **1–20 MiB**, with a default of **20 MiB**. The task's organization sets the
limit, including for guest uploads. Lowering it leaves existing files intact.
It does not set a combined storage quota. Only organization admins can change it,
and a value outside 1 to 20 is refused instead of changed. A file name can have
up to 255 characters.

Attachments are for images, PDF files and similar documents that belong
with a task. Qivo is not a file store, so 20 MiB is the most any
organization can choose, and a task holds at most 100 attachments,
description images included.

## Who can create projects

**Who can create new projects?** in **Settings → Organization → General →
People** decides who can create top-level projects. Only organization admins
can change it.

- **Org admins**. Only organization admins.
- **Standard users**. Organization admins and every standard user. This is
  the default.
- **Selected users**. Organization admins and the standard users with **Can
  create projects** turned on in **Organization → Users**
  ([Four ways to be a user](./administration-guard-rails-and-the-demo.md#four-ways-to-be-a-user)).

An agent whose role is **Standard user** counts as a standard user, so it
can create projects through the REST API or MCP under **Standard users**, and
under **Selected users** when its box is ticked. Viewers and guests never
create projects, whatever the choice, and neither do **Viewer** agents.
Changing it leaves existing projects as they are, and project leads still
create sub-projects under every choice
([Creating projects and sub-projects](./who-sees-what-the-access-model.md#creating-projects-and-sub-projects)).

An agent leads every project it creates, and only a person can hand those
projects over. Until an organization admin does, the agent cannot be made a
**Viewer**, so set it to **Inactive** to stop it at once
([Agent users](./administration-guard-rails-and-the-demo.md#agent-users)).

The line under the setting names who can create projects now. It lists up
to three names, organization admins first. With more, it shows two names and
a count, and says how many of the others are agents, such as **Nora Berg,
Leo Martins and 3 more, including 1 agent, can create projects.** Pending
invitations and **Standard user** agents count, and an agent's name says so,
such as **Atlas (agent)**. Inactive users, viewers and guests do not. With
**Org admins**, it adds **Project leads still create sub-projects.** With
**Selected users**, it adds **Choose who in Users.** The **Users** link
opens **Organization → Users**.

## Export data

Organization admins can download a ZIP from
**Settings → Organization → General → Export data**. It contains:

- Projects and tasks, including archived work, comments and activity.
- People and roles, including inactive people, agents and unclaimed seats.
- Teams, access grants, labels, task relationships, milestones, organization
  settings, legacy billing metadata and agent-key metadata.
- Uploaded attachments, description images and member pictures.
- The organization's change history, including changes to the organization
  itself and to its projects, milestones, teams, people, labels and agent keys.

The manifest lists record counts and file locations. Format version 2 stores
tasks in `data/tasks.json`, with `task_links.json`, `task_labels.json` and
`task_attachments.json` in the same folder. Related records use `task_id`.
A move to another sub-project clears a task's `status_at` and sets its
`done_at` and `review_at`, where it has them, to the move time, for the task
and each subtask that moves with it, while `remaining_set_at` stays. Later
changes stamp them again. The move changes no activity, so the task's history
still shows when it was completed.

The export excludes [Deleted items](./how-work-is-organized.md#deleted-items),
personal inboxes, subscriptions, preferences, private backgrounds, login
data, OAuth connections and credentials.
Agent-key metadata contains neither the key nor its hash. Billing plans,
subscriptions, usage and delivery records are also excluded. Review current
usage in **Billing** and invoices through **Manage billing**.

Keep the General page open until the download finishes. **Cancel export** or
leaving the page stops preparation. A missing file or failed request stops
the export and shows an error.

Your browser assembles the ZIP. It must fit in available memory, remain under
**4 GiB** and contain at most **65,534 entries**, including JSON files. Changes
made during preparation may appear in only part of the archive. Qivo has no
import or restore workflow for these exports.

When the browser finishes a ZIP, the panel shows that date as the last export.
Qivo cannot see whether the file was saved. Exports keep working while an
organization is read-only before its deletion.

## Deleting an organization

An organization's service ends in one of these ways:

- **Cancelling.** An admin chooses **Cancel subscription** in **Billing**, or
  cancels in **Manage billing**. The subscription stops renewing and ends with
  the period already paid for. The organization keeps full access until then,
  and nothing is refunded. Before that date, **Uncancel** in **Manage
  billing** keeps the subscription. While a payment is overdue, **Billing**
  asks for the payment first, and cancelling in **Manage billing** pauses
  editing at once.
- **Deleting.** An admin chooses **Delete organization** under **Settings →
  Organization → General** and types the organization address. Any paid
  subscription ends at once, and nothing is refunded.
- **Access ending.** Polar ends a subscription, for example after failed
  payments, or complimentary access ends without a subscription. Overdue
  payments alone only pause editing.

Once the service has ended, the organization stays read-only for 30 days.
Members can still read their work, and admins can export it. Admins can also
still take access away, as while billing pauses editing
([Billing and free access](./administration-guard-rails-and-the-demo.md#billing-and-free-access)).
Qivo emails the admins unless one of them finished an export in the 7 days
before the service ended. On the deletion date, Qivo deletes everything the
organization owns, including uploaded files. Nobody can open the files from
then on, and Qivo erases their contents within 7 days
([Deleted items](./how-work-is-organized.md#deleted-items)). Each person's
sign-in and their other organizations remain. While Qivo deletes it, the
app, the REST API and MCP refuse every call into the organization and say
that it is being deleted, also to people, keys and connections it has
already removed. Someone with no other organization sees that in the app,
also after a reload. A guest can create a new organization at once. A
member can once the deletion has removed them from this one, which is its
first step, and **Check again** on that screen then shows the form.

Until that date, subscribing again keeps an organization whose subscription
ended. An admin can stop a deletion an admin asked for with **Keep
organization** while the organization has a subscription or complimentary
access. If the deletion ended the subscription, subscribe again first. Qivo
does not start a deletion while the organization has a live subscription or
a checkout that is still open.

A new organization that has not completed checkout within 3 days, and has no
complimentary access, is deleted.

## Organization address

The address is the organization name used in URLs, such as `acme` in
`qivo.io/app/acme/…` ([Links you can share](./finding-your-way-around.md#links-you-can-share)). Qivo creates a unique address
from the organization's name, adding a number if needed, such as `acme-2`.
Renaming the organization does not change its address.

Only an organization admin can change the address. Before saving, note:

- The change takes effect immediately. Old links stop working, with no redirect.
- The old address becomes available for another organization to claim.
- Taken or reserved addresses cannot be saved. Qivo explains the refusal.
- The organization's change history records the old address, new address and
  person who changed it. Organization admins find it in the
  [export](#export-data).

If a previously visited address belongs to a different organization, Qivo
asks you to confirm before opening it.

## Planning hours and teams

**Plannable hours per week** means time available for planned project work,
excluding meetings and other overhead. It sets the person's full capacity in
the Team strip, auto-fit and delay projections. Enter a whole number from
**1–168 hours**. Qivo refuses any other value and keeps the saved one.

**Default plannable hours per week** in **Organization → General** starts at
**32** and applies to new users. Changing it leaves existing users' hours intact.

Set individual hours in the **h/wk** field in **Organization → Users** or a
team's member list. Organization admins can change anyone's hours. Team
leaders can change their members' hours. Other users cannot edit their own
capacity. A person's hours apply across teams and projects in that organization.
Guests have a separate capacity value in each organization that invites them.

Open **Settings → Organization → Teams → the team** to edit its name,
membership, **Leader** checkboxes and planning hours. Organization admins and
team leaders can manage the team. Only people can lead a team. An agent can be
a member, but Qivo refuses to make it a leader. A team can have no leader, and
organization admins still manage it. Members receive access to projects shared
with their team ([Project access](./who-sees-what-the-access-model.md)). Team leadership alone does not grant project authority.
When you can share the team's projects and edit their tasks, removing a member
or deleting a team first asks whether to keep people as Viewers or reassign
open tasks they would no longer see. Deleting a team removes at most 3,000 of
its memberships and project shares at once, so remove some of its members or
project shares before you delete a larger one. Otherwise the member is removed at once
and a message says who can no longer see how many tasks.

## Labels

**Organization → Labels** holds the shared label list. Renaming a label updates
it everywhere. Click its color dot and choose a swatch to save a new color.
Escape or clicking outside cancels without changes. Before deletion, Qivo
shows how many tasks use the label. New organizations start with
**Electronics** and **Mechanical**.

People with task-editing access can apply labels. Organization admins manage
the list in Settings. Organization users with User or Lead access to a
top-level project can also create labels from a task's label picker. Guests
can apply existing labels but cannot manage the list.
