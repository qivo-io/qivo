Organization admins manage users, project access and billing in Settings.
Qivo Admin is a separate area for platform operators.

## Four ways to be a user

Open **Settings → Organization → Users** to manage account status:

- **Org admin** can access and manage every project and can always create
  projects.
- **Standard user** can access projects shared with them, directly or through
  a team. They can create projects when the organization allows it
  ([Who can create projects](./organization-and-team-settings.md#who-can-create-projects)).
- **Viewer** can read shared projects, and a Viewer person can follow tasks.
  Viewers cannot change project work, comment, lead a project or team, or
  receive new assignments.
  Hand over leadership before changing someone to Viewer. Existing assignments
  and access grants remain, and active viewers count toward billing.
- **Inactive** has no access and does not count toward the next renewal.
  Existing assignments, reviewer roles, comments and history remain. New work
  cannot be assigned until the account is reactivated. Removing an account
  instead clears its assignee and reviewer roles.

Removing a user takes effect at once. The account loses all access and
leaves the Users list, its teams, project sharing, project leads and open
tasks. If it holds hundreds of open tasks, some are cleared shortly after.
Qivo then clears it from archived tasks, comments and notifications in
the background, usually within a few minutes. Until then, an archived task,
or one restored from the archive in that time, can still show the removed
user as an unknown person.

While **Who can create new projects?** is set to **Selected users**, the list
has a **Can create projects** column. It holds a checkbox for each active
standard user, including pending invitations and **Standard user** agents.
The value stays when the organization picks another choice, but it counts
only under **Selected users**. Changing someone's role to **Org admin** or
**Viewer** clears it; making them **Inactive** keeps it. Active org admins
show a ticked checkbox that cannot be changed, because they can always create
projects. Viewers, including **Viewer** agents, have none.

You cannot remove or deactivate yourself, demote or deactivate the last admin,
or delete the last team. Adding or reactivating a user requires no prepaid
seat. The page lists **Guests** separately with their projects and roles. An
active guest counts toward billing only without an active home membership ([Guest billing](./who-sees-what-the-access-model.md#people-outside-your-organization)).

## Agent users

An agent signs in with an **API key**, without an email address or password.
In **Organization → Users**, choose **Agent**, enter a name and copy the key.
Qivo shows it once and stores only its hash and a display fingerprint, such as
`qva_d9e...58b76`. To rotate a key, create another from the agent's row, update
your client, then revoke the old key. Agent and key names, like personal token
names, allow up to 80 characters.

Agents use the same project roles as people. They cannot be organization
admins or lead a team. Set the organization role to **Viewer** for read-only
automation. A Viewer agent's keys can only read. REST and MCP refuse every
change with `this agent is a Viewer and can only read`, whatever project roles
the agent holds. It can still create, list and remove its own task event
subscriptions. Viewer and Inactive agents receive no inbox messages and
cannot follow tasks, because they could never clear their inbox. Changes and
comments name the agent. Active agents count toward billing; setting one to
**Inactive** disables all its keys.

A **Standard user** agent can create top-level projects whenever
[Who can create projects](./organization-and-team-settings.md#who-can-create-projects)
lets standard users create them. It leads every project it creates and
cannot hand one over or change who has access. An agent that leads projects
cannot be made a **Viewer** until an organization admin hands those projects
to someone else, so **Inactive** is the way to stop it at once.

Agents have **no weekly limit**. The Team strip shows their planned hours
without utilization percentages or overload warnings. Qivo does not model
agent rate limits, budgets or queues. One agent key works with both REST and
MCP ([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)).

The Northstar Labs demo includes **Atlas** alongside seven fictional people.
Its Luma Sensor, Luma Cloud and Pilot & Launch projects contain planned work,
reviews, comments and archived tasks. Nora is the organization admin. The
private demo signs you in as Nora and does not support external agent keys ([Private demo](./qivo-in-one-minute.md#private-demo)).

## API access

**Settings → Organization → API access** lists every credential in the
organization in one table: each member's personal tokens and connected apps
and every agent key. Each row shows the person, kind, whether it can make
changes or only read, the expiry of a token that has one, its last use and
its calls in the selected period. The summary above it shows the period's
calls against the plan's included calls. Choose an earlier period to see its
calls. An earlier paid period shows the allowance of the seats it was billed
for, and other earlier periods show only their calls. Credentials and calls
of people who left the organization stay listed as **Removed user**, and
deleted credentials as **deleted**.

Filter by kind, by **Active** or **All**, by person, or by name, prefix or
person. Revoked and expired credentials stay listed because their calls in
the period still count. **Refresh** reads current figures.

**Revoke** asks for confirmation and stops the credential at once, including
its task event subscriptions. The person sees a token or connected app
revoked this way as revoked by an admin and can create a new token or connect
the app again. Create a new agent key in **Users**. A revocation appears in
the change history for organization admins only. The demo does not offer API
access.

## Managing projects and accounts

**Settings → Projects → All projects** lists accessible projects by
organization. Expand a project to see its sub-projects, or use its **…** menu
to open settings. Org admins, and standard users the organization allows
([Who can create projects](./organization-and-team-settings.md#who-can-create-projects)),
can choose **New project** and set its name, lead and optional team/user
shares ([Creating projects and sub-projects](./who-sees-what-the-access-model.md#creating-projects-and-sub-projects)).

Project settings includes the name, description, lead, access, delay tracking
and review time. Names allow up to 80 characters. Descriptions allow up to
500 characters and save when you click outside; clearing the field removes
the description. Lead access is required to change **Review time**. An empty
sub-project value follows its parent project ([Review time](./will-it-be-ready-in-time-the-delay-status.md#review-time)).
Its last section, **Archive or delete**, archives the project or moves it to
Deleted items ([Deleting a project](./how-work-is-organized.md#deleting-a-project)).
Every role has **Settings → Projects → Deleted items**. It lists what you
deleted, a lead also sees what was deleted in projects they lead, and
organization admins see everything deleted in the organization
([Deleted items](./how-work-is-organized.md#deleted-items)).

Choose **Create an account** on the pricing or sign-in page to sign up. Email
confirmation links expire after one hour; **Confirm your email address** can
send another. Google sign-in supplies a verified email address; Microsoft
sign-in still requires confirmation. A confirmed address claims its pending
invitations. Without an invitation, Qivo offers to create an organization with
you as its first admin. When billing is enabled, a new unpaid organization
opens Billing.

If Microsoft blocks sign-in until an administrator approves Qivo, follow
[Microsoft sign-in and administrator approval](./microsoft-sign-in-and-administrator-approval.md).
Approval requires a Microsoft Entra administrator with consent permissions;
a Qivo organization admin role alone is not enough.

Destructive controls ask for a second click. Compact delete buttons first
expand to **Delete?**; larger controls state what will be removed. The second
click must come after a short pause, so a double click does not confirm. Every
confirmation expires after a few seconds if unused. Tasks and projects work
differently. **Archive or delete…** opens a window that lists what goes with
them, and deleting moves them to Deleted items, where they can be restored.
Deleting a parent project also deletes its sub-projects and tasks. Only an
organization admin can delete an item for good before it expires, with
**Delete now…**, which asks first and cannot be undone. Deleting a team
removes memberships and sharing grants but preserves project work. If members
would lose sight of open tasks they work on, Qivo first asks whether to keep
them as Viewers or reassign the tasks.

Users without management access see read-only team and project settings.
Organization General, Billing, Users, API access and Labels require an
organization admin.
Team leaders can open **Teams** and manage their own teams; only admins create
or delete teams.

## Billing and free access

Admins can view the plan, billable accounts, renewal date and usage in
**Settings → Organization → Billing**. **Subscribe** opens Polar checkout;
**Manage billing** opens payment details, invoices and cancellation. Confirmed
payment activates access automatically.

When billing is disabled, the page says so and the organization remains
usable. When enabled, editing requires a paid subscription or complimentary
access. Paused editing leaves existing readable work and personal settings
available. Admins can still take access away while editing is paused. They
can revoke any credential on [API access](#api-access), revoke or delete agent
keys, make users **Inactive**, remove users, remove users from teams and
remove a person's or team's access to a project. The last two also work
through the REST API and MCP with an admin's own token or connection. Such a
removal leaves open tasks with the people who hold them, because keeping
people as Viewers or reassigning their tasks saves more than the removal. In
the app it therefore does not ask about the tasks. A message says who can no
longer see how many tasks, so a project lead can reassign them once editing
resumes. Project leads and team leaders who are not admins cannot remove
access then. Reactivating users, deleting teams and every other change wait
until billing is active again. If you try a removal you cannot make then, or
try to delete a team, the app says the organization is read-only and does not
ask about the tasks.

Each organization keeps its assigned plan version. New plans do not change
existing prices or allowances. The published plan costs $1 per active billable
user per month, with a five-user minimum. People, viewers and agents count,
including pending invitations. Guests with an active home membership are
exempt. The count at renewal sets the next month's charge, with no mid-month
proration or credit.

Billing lists active and inactive accounts and guests with their own billing.
It also shows shared storage and API allowances, API usage by account and
credential, and storage by project. **Refresh** reads current usage. Files in
Deleted items are not billed as storage
([Deleted items](./how-work-is-organized.md#deleted-items)). In the private
demo, they still count toward its 50 MiB upload allowance until they are
deleted for good with **Delete now…**
([Private demo](./qivo-in-one-minute.md#private-demo)).

API calls accumulate during each paid subscription period. Qivo samples storage
at the start of the period and collects its extra charge, plus API overages, on
the invoice at the end of the period. That is the renewal invoice, or the final
one when a cancelled subscription ends. Current storage can differ from that
sample. Polar handles checkout taxes and recurring payments.

Without a paid billing period, for example during free access, before you
subscribe or after a subscription ends, Billing counts API calls per calendar
month (UTC). These calls are never charged.

An operator can grant **six calendar months free**, including user charges and
storage/API overages, without a card. Admins receive expiry reminders and can
subscribe when free access ends. Without payment, editing pauses. Qivo does
not charge free-period usage retroactively.

Polar retries failed payments. Qivo allows seven days from the recorded
past-due state before pausing editing, and a 24-hour grace period for delayed
renewal confirmation on an otherwise active subscription. API calls made
while a renewal awaits confirmation are counted but not charged. A cancelled
subscription keeps access through the paid period, without a refund
([Deleting an organization](./organization-and-team-settings.md#deleting-an-organization)).
Restoring payment restores editing.

## Separate app and admin sign-in

**Qivo Admin** at `/admin` requires platform-operator access and has a separate
session. Signing in or out there does not change your planner session.

**Billing plans** creates fixed monthly plan versions. Connect a draft once to
its matching Polar product and usage meters. **Use for new customers** changes
the default without changing existing organizations. Open an organization to
assign its plan before checkout or grant six months free. Repeating a grant
extends its end date. The operator audit log records plan changes and grants.

## Organizations and invitations. Platform operators

In **Qivo Admin → Organizations**, **New organization** creates an
organization and invites its first people in one step. Qivo suggests an
address from the name, and you can change it before creating. The
organization starts with a team of the same name, led by the first org admin
you add while creating it. Choose its billing plan, and select **Grant six
months free** to start with complimentary access.

Add each person with a name, email address and role, either **Org admin**,
**Standard user** or **Viewer**. The first person must be an org admin, and no
other role can be invited until the organization has one. Each person
receives an invitation email from no-reply@qivo.io and joins by signing in or
creating an account with that address. People keep the role on their
invitation, even if they sign in before the org admin.

Open an organization to invite more people, change roles, edit, resend or
cancel a pending invitation, or copy the sign-up link when an email could not
be sent. Editing the address sends a new invitation. The last org admin
cannot be demoted. The only invited org admin can be cancelled only while
nobody else is in the organization. An account belongs to one home
organization, so an address that already belongs to another organization can
only join as a guest. Qivo Admin does not invite guests. Org admins and
project leads invite them from project settings. The operator audit log
records the invitations, email attempts and role changes made in Qivo Admin.

## Demo usage. Platform operators

Open **Qivo Admin → Demos** on the regular site. The deployment manager must
connect reporting first; the private demo site has no operator console.

The page shows recorded, recent and active demo counts, plus workspaces being
cleaned up. Deleted demos remain in historical totals. Opening the welcome
page does not count as creation; creating the same workspace again counts once.
The Dashboard also shows the demo-creation graph.

Choose seven days, 30 days or 12 months to compare creation counts with the
preceding period. Dates use UTC; current days and months are incomplete. Daily
history lasts 800 days and the lifetime total remains. The page identifies
when recording began. Earlier deleted demos cannot be recovered.

**Demo visitors** groups created workspaces by browser, operating system and
country. One person creating two workspaces counts twice. Browser details may
be inaccurate and VPNs can affect country estimates. Missing details appear
as **Unknown**. Reporting retains broad categories, without IP addresses or
precise locations.

**Demo storage** shows approximate database and uploaded-file sizes and daily
averages. Storage samples arrive hourly and usage reports every 15 minutes.
**Refresh** reads the latest received report. Old samples are labelled and
missing samples appear as gaps. Use hover, keyboard focus, arrow keys or
**View data table** to inspect graph values. On phones, scroll navigation and
graphs horizontally.

**Estimated monthly cost** uses Convex Professional Europe storage rates,
checked September 15, 2026 against
[Convex's published rates](https://docs.convex.dev/production/state/limits):

- Database storage costs USD 0.26 per GB/month.
- File storage costs USD 0.039 per GB/month.
- One GB is 1,073,741,824 bytes.

Edit prices, currency and other costs as needed. Settings stay in that browser;
**Use Convex Professional EU rates** restores the preset. The estimate projects
a month from the current month's sampled average and shows the sampled days.
It excludes authentication and index overhead, included allowances, tiered
pricing, the developer subscription and any other costs you have not entered.
Convex's shared 50 GB database and 100 GB file allowances are not subtracted.

## Background images. Platform operators

In **Qivo Admin → Background images**, choose **Upload images**. For one image,
review its **Title**, optional **Location** and **Creator**, then choose
**Save image**. Embedded metadata prefills these fields. Saving confirms the
permission statement and names the file from the title and creator, preserving
its bytes and full details.

You can select several files. Suitable images with an embedded title and
author enter Pending review automatically. The result lists skipped files,
failed uploads and duplicates. Choose a single image to enter missing details.

Review images before assigning them in **Calendar**. **Approve and next** in
**Board preview** approves the current image and opens the oldest pending
image matching the agent-precheck filter. It reports when the queue is empty.
If loading stalls, retry or close after ten seconds; the approval remains.
Approval makes an image available for selection but does not assign a week.

The calendar offers Week 1 through Week 53. Each Monday–Sunday assignment
repeats yearly until replaced; Week 53 applies in years that contain it.
Images show their original and preview dimensions and file sizes, credits and
available license links. Use **Preview in board** to inspect a selection.
There is no automatic provider import or scheduled refill.

## Contact support

For help with Qivo, email [support@qivo.io](mailto:support@qivo.io).
Account verification, password resets and billing reminders are sent from
no-reply@qivo.io. Replies go to the support inbox. Qivo does not currently
accept task updates by email.
