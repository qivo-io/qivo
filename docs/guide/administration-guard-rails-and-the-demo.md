Organization admins manage users, project access and billing in Settings.
Qivo Admin is a separate area for platform operators.

## Four ways to be a user

Open **Settings → Organization → Users** to manage account status:

- **Org admin** can access and manage every project.
- **Standard user** can access projects shared with them, directly or through
  a team.
- **Viewer** can read shared projects and follow tasks, but cannot change
  project work, comment, lead a project or team, or receive new assignments.
  Hand over leadership before changing someone to Viewer. Existing assignments
  and access grants remain, and active viewers count toward billing.
- **Inactive** has no access and does not count toward the next renewal.
  Existing assignments, reviewer roles, comments and history remain. New work
  cannot be assigned until the account is reactivated. Removing an account
  instead clears its assignee and reviewer roles.

You cannot remove or deactivate yourself, demote or deactivate the last admin,
or delete the last team. Adding or reactivating a user requires no prepaid
seat. The page lists **Guests** separately with their projects and roles. An
active guest counts toward billing only without an active home membership ([Guest billing](./who-sees-what-the-access-model.md#people-outside-your-organization)).

## Agent users

An agent signs in with an **API key**, without an email address or password.
In **Organization → Users**, choose **Agent**, enter a name and copy the key.
Qivo shows it once and stores only its hash and a display fingerprint, such as
`qva_d9e...58b76`. To rotate a key, create another from the agent's row, update
your client, then revoke the old key.

Agents use the same project roles as people and cannot be organization
admins. Set the organization role to **Viewer** for read-only automation.
Changes and comments name the agent. Active agents count toward billing;
setting one to **Inactive** disables all its keys.

Agents have **no weekly limit**. The Team strip shows their planned hours
without utilization percentages or overload warnings. Qivo does not model
agent rate limits, budgets or queues. One agent key works with both REST and
MCP ([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)).

The Northstar Labs demo includes **Atlas** alongside seven fictional people.
Its Luma Sensor, Luma Cloud and Pilot & Launch projects contain planned work,
reviews, comments and archived tasks. Nora is the organization admin. The
private demo signs you in as Nora and does not support external agent keys ([Private demo](./qivo-in-one-minute.md#private-demo)).

## Managing projects and accounts

**Settings → Projects → All projects** lists accessible projects by
organization. Expand a project to see its sub-projects, or use its **…** menu
to open settings. Eligible staff can choose **New project** and set its name,
lead and optional team/user shares.

Project settings includes the name, description, lead, access, delay tracking
and review time. Descriptions allow up to 500 characters and save when you
click outside; clearing the field removes the description. Lead access is
required to change **Review time**. An empty sub-project value follows its
parent project ([Review time](./will-it-be-ready-in-time-the-delay-status.md#review-time)).

Choose **Create an account** on the pricing or sign-in page to sign up. Email
confirmation links expire after one hour; **Confirm your email address** can
send another. Google sign-in supplies a verified email address; Microsoft
sign-in still requires confirmation. A confirmed address claims its pending
invitations. Without an invitation, Qivo offers to create an organization with
you as its first admin. When billing is enabled, a new unpaid organization
opens Billing.

Destructive controls ask for a second click. Compact trash buttons first
expand to **Delete?**; larger controls state what will be removed. Timed
confirmations expire if unused. Deleting a parent project also deletes its
sub-projects and tasks. Deleting a team removes memberships and sharing grants
but preserves project work.

Users without management access see read-only team and project settings.
Organization General, Users, Labels and Billing require an organization admin.
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
available.

Each organization keeps its assigned plan version. New plans do not change
existing prices or allowances. The published plan costs $1 per active billable
user per month, with a five-user minimum. People, viewers and agents count,
including pending invitations. Guests with an active home membership are
exempt. The count at renewal sets the next month's charge, with no mid-month
proration or credit.

Billing lists active and inactive accounts and guests with their own billing.
It also shows shared storage and API allowances, API usage by account and
credential, and storage by project. **Refresh** reads current usage.

API calls accumulate during the subscription period. Qivo samples storage at
the start of the period and collects its extra charge, plus API overages, on
the following renewal invoice. Current storage can differ from that sample.
Polar handles checkout taxes and recurring payments.

An operator can grant **six calendar months free**, including user charges and
storage/API overages, without a card. Admins receive expiry reminders and can
subscribe when free access ends. Without payment, editing pauses. Qivo does
not charge free-period usage retroactively.

Polar retries failed payments. Qivo allows seven days from the recorded
past-due state before pausing editing, and a 24-hour grace period for delayed
renewal confirmation on an otherwise active subscription. Cancellation at
period end preserves access through the paid period. Restoring payment
restores editing.

## Separate app and admin sign-in

**Qivo Admin** at `/admin` requires platform-operator access and has a separate
session. Signing in or out there does not change your planner session.

**Billing plans** creates fixed monthly plan versions. Connect a draft once to
its matching Polar product and usage meters. **Use for new customers** changes
the default without changing existing organizations. Open an organization to
assign its plan before checkout or grant six months free. Repeating a grant
extends its end date. The operator audit log records plan changes and grants.

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
