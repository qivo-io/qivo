Projects can be shared with teams and individual people. Access also applies
to their tasks and sub-projects.

- **Organization admin** can access all organization projects and settings,
  including users, billing, teams and labels.
- **Team leader** manages the team and its members. Only people can lead a
  team, never agents. Leadership alone grants no project access.
- **Project Viewer** reads the project and tasks without editing.
- **Project User** creates and edits tasks, comments, attaches files and plans work.
- **Project Lead** manages that project, its settings, sharing and sub-projects.

In project settings, **Project access** groups grants under **Teams** and
**Users**. Use **Add team or user** to add individual people or teams. Team
grants can be **User** or **Viewer**. New team members receive the grant;
removing a member removes that source of access.

The strongest applicable role wins. A Viewer team grant does not reduce an
individual User grant. Removing one grant leaves access through other teams,
individual grants or organization administration intact.

Removing a person's or a team's grant asks first when someone would lose
sight of open tasks they are assigned to or reviewing in that project or its
sub-projects. Removing a member from a team, or deleting a team, asks the same
way for every project the team shares. The window lists those tasks and
offers two choices. **Keep as Viewer** gives each of those people a Viewer
grant, so they keep the tasks and can read the project but cannot change it.
For a team, the grant is on each project the team shared that holds the
listed tasks. **Reassign** hands every listed task, reviewer roles included,
to one person who keeps User or Lead access to those tasks, or to
**Unassigned**, and removes the access once every task is saved. If a task or
Viewer grant cannot be saved, the access stays, tasks already saved keep their
new assignee, and the window lists what remains. Removing a person's grant
that is already Viewer offers only the reassignment. Done tasks keep their
assignee and are not listed.

A team leader who cannot share those projects and edit their tasks removes
the member at once. A message then says who can no longer see how many of
their tasks, so a project lead can reassign them.

Only organization admins and the named project lead can manage sharing and
invitations. Renaming, archiving, deleting or changing project settings also
requires Lead access, which organization admins have.

Each project and sub-project has one named lead. Choosing a new lead changes
the outgoing lead to **User**. An active guest with access to the project can
become its lead.

Parent **User** and **Viewer** grants apply to sub-projects at the same level.
The parent lead has **User** access to a sub-project with a different lead.
A stronger grant on the sub-project takes precedence. Access granted only to
a sub-project makes its parent visible for read-only navigation, without
opening sibling projects or the parent's change history.

An organization-level **Viewer** role ([User roles](./administration-guard-rails-and-the-demo.md#four-ways-to-be-a-user)) limits all project access to
reading, even if the person has a stronger project role. It does not make
unshared projects visible. Viewers can open tasks and roadmap
bars, but cannot drag them or use editing and creation controls.

Unshared projects are absent from navigation, search, pickers, feeds and your
inbox. Direct links do not open them. For organization admins and users,
capacity views count hidden work anonymously under **Other projects**. Guests
and organization Viewers receive workload only for tasks they can access or
own; they cannot see other people's hidden workload.

Change history follows the same rules. You see a change only if you can access
the task or project it concerns and every project it involves, such as both
ends of a task move. A change that names another task, such as a new parent or
a linked task, also requires access to that task where it is now. When a task
moves to a project you cannot access, its history leaves your view. People who
can access only the new project see the changes made after the move. Only
organization admins see the history of deleted tasks, projects and teams, with
two exceptions. People with access to a parent project see that one of its
sub-projects was deleted, and a task that moved out of a project before it was
deleted keeps that earlier history for everyone who can open the task. Changes
that name a deleted task reach organization admins only, and so do agent key
creation and revocation.

Organization admins add people through **Organization → Users**. There is no
purchased-seat limit on adding or reactivating users. Billing counts active
users at renewal, including pending invitations ([Billing and free access](./administration-guard-rails-and-the-demo.md#billing-and-free-access)). Signing up does not
let someone join your organization without an invitation.

## Creating projects and sub-projects

**New project** asks for a name, lead, optional description and optional team
or individual shares. Organization admins can always use it. For everyone
else, [Who can create projects](./organization-and-team-settings.md#who-can-create-projects)
decides. The lead starts as you.

If you are not an organization admin and pick someone else as lead, Qivo adds
you to **Project access** as **User**. The field then names you, such as
**Aisha Rahman (you)**, or **You, 1 team** when there are other shares. You
can change that level or remove the entry. If you make yourself lead again,
Qivo removes the entry unless you changed it. A changed entry stays alongside
the lead role, and the higher access wins. Once the project exists, its
settings show you only as **Lead**. If someone else later becomes lead, you
keep **User** access.

If you are not an organization admin, the dialog footer warns you before you
create the project:

- When someone else leads, it names them, such as **Only Leo Martins and org
  admins can manage it.** Only the lead and organization admins can change
  the project's settings and access, archive it or delete it.
- When you would have no access, it says **You won't see this project.**
  instead. That happens when you are not the lead, have no individual entry
  in **Project access** and are in no team it is shared with.

Qivo normally opens the new project. If you cannot see it, you stay where you
are, and a message confirms the project was created, such as **Project “Luma
Mount” created. You don't have access to it.**

**New sub-project** asks for a name, parent project and lead; add optional
shares in its settings. It requires Lead access to the parent project, and
**Who can create new projects?** does not affect it. When someone else leads
and you are not an organization admin, the footer names them with the same
note. As the parent's lead, you keep **User** access to the sub-project.

## People outside your organization

Invite a guest by email in project settings, choosing **Viewer** or **User**.
Qivo emails them an invitation to join your organization as a guest.
An organization admin or the named project lead can later make them **Lead**.
Guests receive access to that project and its sub-projects, subject to their
role.

Guests can see the organization's name, people's names and email addresses,
and shared labels needed for collaboration. A guest with User access can
work on tasks, comments, attachments and plans, and apply labels. Qivo adds
milestones to the top-level project, so changing them needs User access
there, not only on a sub-project.
Guests cannot manage the label list, join teams, create top-level projects,
or open Organization settings or billing. They appear in the separate
**Guests** list.

An invitation waits until the person signs in with its email address.
Existing users see the project on their next visit, without a second account
or acceptance step. Shared projects appear in their sidebar under the
inviting organization's name, alongside their own work. Revoking access
removes the project unless another grant still gives access.

An active guest is billable to the inviting organization only if they have no
active membership in a home organization. Qivo matches by email, including
before signup. If they have no active home membership, each inviting
organization counts them. Billing lists billable and non-billable people
without showing their other organization's identity or membership details.

If you sign up without an invitation, Qivo offers to create your own
organization. You become its first admin, with an initial team. Invitations
to other organizations then add guest access alongside your home organization.
Team memberships from such an invitation end, because guests cannot join
teams.
