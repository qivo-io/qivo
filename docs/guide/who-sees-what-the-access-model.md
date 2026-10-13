Projects can be shared with teams and individual people. Access also applies
to their tasks and sub-projects.

- **Organization admin** can access all organization projects and settings,
  including users, billing, teams and labels.
- **Team leader** manages the team and its members. Leadership alone grants
  no project access.
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
sub-projects. The window lists those tasks and offers two choices.
**Keep as Viewer** gives each of those people a Viewer grant, so they keep
the tasks and can read the project but cannot change it. **Reassign** hands
every listed task, reviewer roles included, to one person who keeps User or
Lead access to those tasks, or to **Unassigned**, and removes the grant once
every task is saved. If a task cannot be reassigned, the grant stays, tasks
already saved keep their new assignee, and the window lists what remains.
Removing someone who is already a Viewer offers only the reassignment. Done
tasks keep their assignee and are not listed.

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

**New project** asks for a name, lead and optional team or individual shares.
**New sub-project** asks for a lead; add optional shares in its settings.

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

## People outside your organization

Invite a guest by email in project settings, choosing **Viewer** or **User**.
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
