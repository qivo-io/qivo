Board has five status columns with pinned headers and live counts. Each
column's **+** creates a task in that status, except in My view
([Creating a task](./how-work-is-organized.md#creating-a-task)). Tasks sort by priority within their card groups.
A Board shows one project, one sub-project or My view. In All projects it
asks you to choose a project, and opens that project's Board.

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

- **Swimlanes by project**. One lane per sub-project, or per project in My
  view.
- **Swimlanes by assignee**. One lane per task owner, sorted alphabetically,
  with **Unassigned** last. The owner is the reviewer while a task waits
  In Review with one. This layout also works within a single sub-project.
- **Pooled, one board**. All tasks share status columns. Cards show their
  project and sub-project as needed.
- **Side-by-side boards**. One small Board per sub-project, or per project
  in My view.

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

On very large boards, cards below the first screen appear in the first
moments after the Board opens, in shaded space that keeps the Board's shape.
Searching the page with Ctrl+F or ⌘F, or printing, loads them all first.
Like every page, the Board stays loaded while you use the others, as long as
the sidebar choice stays the same, and checks its tasks again when you come
back ([Pages stay as you left them](./finding-your-way-around.md#pages-stay-as-you-left-them)).

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

## Which tasks a Board shows

Qivo's server works out which tasks a Board shows, with its filters
applied. Until it answers, as when the Board opens, after you change a
filter or when you come back to the Board, the Board shows the tasks your
browser already holds, before it has checked them: its counts show **…**
until the answer arrives. Your own changes show at once. Other people's
changes take a task off the Board at once, and add one once the server
answers. While the browser tab or the desktop window is hidden, the Board
stops updating, and it checks its tasks again when you return.

A Board shows at most 1,000 tasks, subtasks included, across its project
or sub-project with its filters, or across My view
([Limits](./limits.md#tasks-and-organizations)). A selection with more
shows a message in place of the columns: **This selection exceeds the
Board's 1,000-task limit.** For a project, the message offers its
sub-projects to choose from; otherwise, narrow your filters, such as
**Focus**, **Priority**, **Stale** or the text filter. If Qivo could not
read a selection within the Board's limits, as for a long text filter over
a very large project, it says so without a count. For a sub-project it also
offers **Search this sub-project**, which opens Search on it
([Search palette](./finding-your-way-around.md#search-palette)). The filter
row and the layout switcher stay usable beside every message. The phone's
task list also shows parent tasks as rows, so it can list more than 1,000
rows.

If some tasks the server named have not reached your browser a minute after
the rest, the Board says so and keeps the counts at **…**. **Try again** asks
the server for the Board once more; if the tasks still do not show, reload
the page. When a Board is not available, for
example after your access to its project ended, it says so instead of
showing an empty Board.

## Showing a task on the Board

Some links open a task's window over the Board and show its card behind
it: **Board** on a Team sync row, **Open task in board** in the Inbox, the
breadcrumb in a task window and an active task picked in Search while the
Board is open. The first two open the Board of the task's sub-project, the
breadcrumb opens the Board of the project or sub-project you click, and a
task picked in Search stays on the Board you are on. The Board
scrolls the card to the middle of the screen once it has its tasks, and
rings it until a moment after you close the window, following the task to
its new card if a change in the window moved it. A subtask under a parent heading
rings its own row, and a parent task rings the first card under its heading.
On phones the task list does the same with the task's row, and the
breadcrumb closes the window first, as it fills the screen. Nothing is
shown when a filter or the scope hides the task.

## Stale tasks fade

Unfinished tasks untouched for more than 120 days fade until you hover over
them. In grouped cards, only the stale task's row fades. Use **Stale** to
find these tasks. Done tasks do not count as stale. Only Done tasks archive
automatically ([Archiving](./the-task-window.md#archiving)).
