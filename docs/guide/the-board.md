Board has five status columns with pinned headers and live counts. Each
column's **+** creates a task in that status, except in All projects and
My view ([Creating a task](./how-work-is-organized.md#creating-a-task)). Tasks sort by priority within their card groups.

Drag a task to change its status. Read-only tasks cannot be dragged. Valid
destinations highlight and dim their existing cards while you hover;
invalid destinations and the task's current cell do neither. Dropping
changes status, assignee or reviewer according to the layout. It does not
create a parent/subtask relationship.

Lane headings stay visible as you scroll. In Swimlanes, after reaching a
lane's final row, the next downward wheel or trackpad scroll advances to the
next heading. Scrolling upward from a heading returns to the previous lane's
last tasks, or its heading if it fits in the window. Tall lanes scroll
normally between those points. Reverse direction to reverse a snap.
Keyboard and scrollbar navigation scroll freely.

Select a project or sub-project heading to open that scope. This works in
Swimlanes, Side-by-side boards and Roadmap. On Roadmap, the adjacent chevron
collapses or expands its rows.

## Board layouts

The layout switcher uses short labels, **Project**, **Assignee**, **Pooled**
and **Separated**. Its menu offers:

- **Swimlanes by project**. One lane per sub-project, or per project in All
  projects and My view.
- **Swimlanes by assignee**. One lane per task owner, sorted alphabetically,
  with **Unassigned** last. The owner is the reviewer while a task waits
  In Review with one. This layout also works within a single sub-project.
- **Pooled, one board**. All tasks share status columns. Cards show their
  project and sub-project as needed.
- **Side-by-side boards**. One small Board per sub-project, or per project
  in All projects and My view.

In project-based layouts, dragging changes status only. Swimlanes by project
and Side-by-side boards accept drops only within the task's existing project
or sub-project. Use **Move** to change its project. Pooled allows status
changes across its shared columns.

In Swimlanes by assignee, dropping within the same person's lane changes
only status, so entering In Review can move the task to its reviewer's lane.
If changing status alone transfers ownership to the target
person, Qivo also keeps the assignee and reviewer unchanged. For example,
moving a Review task to In Progress in its assignee's lane returns the work
to that assignee.

Other drops into a person's lane change the assignee, except in **In
Review**, where they change the reviewer. Dropping into the assignee's own
In Review cell clears the reviewer. That column's **Unassigned** lane
rejects a task that has an assignee. Any new assignee or reviewer must be
eligible for the task's project ([Task ownership](./how-work-is-organized.md#the-task)).

## Cards

Siblings share a card within each status column and lane, under their
parent's title. Siblings in different cells repeat the parent heading.
Nested subtasks retain their ancestor names for context. Tasks without
active subtasks outside these groups have individual cards.

Task rows show title, priority, remaining hours, due date and owner. Click
the row or parent title to open the task. Drag individual task rows to change
status; parent headings cannot be dragged and do not add to column counts.
A matching child keeps its parent heading visible even if the parent does
not match the filters. A group with no matching descendants has no card.

Hover a portrait to read the person's name. With editing access, click the
portrait or unassigned indicator to choose an eligible person or agent, or
**Unassigned**. This also works for parent tasks. While a task is In Review
with a reviewer, its portrait picker changes the reviewer and offers
**No reviewer** to clear it.

Paused tasks show an amber mark. Delay banners identify slipping or delayed
tasks. When the last active subtask leaves a parent, it returns to a normal
card in its saved status column.

## Stale tasks fade

Unfinished tasks untouched for more than 120 days fade until you hover over
them. In grouped cards, only the stale task's row fades. Use **Stale** to
find these tasks. Done tasks do not count as stale. Only Done tasks archive
automatically ([Archiving](./the-task-window.md#archiving)).
