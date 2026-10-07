Open **Settings → Organization → General** to change the organization's name,
address, attachment limit, calendar and default planning hours.

- **Date format** offers six formats with a preview.
- **Workdays start on** sets the first day of each roadmap week.
- **Week 1 of the year** offers **First 4-day week (ISO 8601)**,
  **Week containing Jan 1** or **First full week**.

**Max attachment size** limits each new task attachment or description image
to **1–20 MiB**, with a default of **20 MiB**. The task's organization sets the
limit, including for guest uploads. Lowering it leaves existing files intact.
It does not set a combined storage quota. Only organization admins can change it.

## Export data

Organization admins can download a ZIP from
**Settings → Organization → General → Export data**. It contains:

- Projects and tasks, including archived work, comments and activity.
- People and roles, including inactive people, agents and unclaimed seats.
- Teams, access grants, labels, task relationships, milestones, organization
  settings, legacy billing metadata and agent-key metadata.
- Uploaded attachments, description images and member pictures.

The manifest lists record counts and file locations. Format version 2 stores
tasks in `data/tasks.json`, with `task_links.json`, `task_labels.json` and
`task_attachments.json` in the same folder. Related records use `task_id`.

The export excludes personal inboxes, subscriptions, preferences, private
backgrounds, login data, OAuth connections, credentials and Gravatar images.
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

## Organization address

The address is the organization name used in URLs, such as `acme` in
`qivo.io/app/acme/…` ([Links you can share](./finding-your-way-around.md#links-you-can-share)). Qivo creates a unique address
from the organization's name, adding a number if needed, such as `acme-2`.
Renaming the organization does not change its address.

Only an organization admin can change the address. Before saving, note:

- The change takes effect immediately. Old links stop working, with no redirect.
- The old address becomes available for another organization to claim.
- Taken or reserved addresses cannot be saved. Qivo explains the refusal.
- The activity history records the old address, new address and person who
  changed it.

If a previously visited address belongs to a different organization, Qivo
asks you to confirm before opening it.

## Planning hours and teams

**Plannable hours per week** means time available for planned project work,
excluding meetings and other overhead. It sets the person's full capacity in
the Team strip, auto-fit and delay projections. Enter a whole number from
**1–168 hours**.

**Default plannable hours per week** in **Organization → General** starts at
**32** and applies to new users. Changing it leaves existing users' hours intact.

Set individual hours in the **h/wk** field in **Organization → Users** or a
team's member list. Organization admins can change anyone's hours. Team
leaders can change their members' hours. Other users cannot edit their own
capacity. A person's hours apply across teams and projects in that organization.
Guests have a separate capacity value in each organization that invites them.

Open **Settings → Organization → Teams → the team** to edit its name,
membership, **Leader** checkboxes and planning hours. Organization admins and
team leaders can manage the team. Members receive access to projects shared
with their team ([Project access](./who-sees-what-the-access-model.md)). Team leadership alone does not grant project authority.

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
