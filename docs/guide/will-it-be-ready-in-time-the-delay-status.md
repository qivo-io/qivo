Qivo estimates an unfinished task's finish week from its plan, remaining
hours and owner's workload. Delay tracking highlights two warnings:

- **Behind plan**, in yellow. The projected finish is after the planned
  end, without a missed or projected-to-miss due date.
- **Late**, in red. The projected finish is after the due week, or the
  exact due date has already passed.

**On track** has no warning color. While the due date has not passed,
finishing in the due week is not classed as Late, though the hover text of
its roadmap due-date marker says that the schedule is tight.
Done tasks have no delay verdict. Tasks without a plan or due date also have
no verdict. A task with only a due date needs an owner and remaining hours
for a projection; without them, it gets a warning only once overdue.

## How the projection works

Qivo projects all of one owner's unfinished tasks together, week by week,
against the owner's plannable hours ([Planning hours](./organization-and-team-settings.md#planning-hours-and-teams)).
Each Remaining save records when you measured it, and a task's remaining
hours count from that week. A task takes part from that week or its planned
start, whichever is later.

In each week, every task that has started asks for its remaining hours
divided by the weeks left in its plan, that week included. A task whose plan
has ended asks for all its remaining hours.

- When the asks fit in the owner's weekly hours, every task gets what it
  asks for. A task that gets its ask every week finishes in its planned end
  week.
- When they do not fit, the week is overbooked, and every task gets the same
  share of its ask. The hours a task did not get stay as its remaining hours
  and move to the next week, where it asks again.

A task's projected finish is the week its remaining hours reach zero. For
example, a person with 32 hours a week has three tasks of 32 hours each, all
planned for this week only. Each gets a third of the week, and all three are
projected to finish in the third week, Behind plan. A task squeezed in one
week asks for more in the weeks left in its plan, so it can still finish on
time when those weeks have room.

A task with remaining hours but no plan, and a paused task, ask for nothing.
They get the hours the planned tasks leave free in each week, and paused
work takes no hours from other tasks.

The projection counts the owner's other open work as you may see it.
Organization admins and users receive organization-wide commitments, with
hidden-project hours kept anonymous. Viewers and guests receive only work
from visible projects and tasks they own ([Project access](./who-sees-what-the-access-model.md)).

The projection assumes progress since the measurement, so an estimate's age
alone does not add more work. Saving another estimate starts the calculation
from the new measurement. An unfinished task's projected finish cannot be
earlier than the current week. The projection follows an owner through at
most 520 overbooked weeks, ten years. A task it has not finished by then is
projected to finish in the week after them, or at its planned end if that is
later.

The owner is the assignee, or the reviewer while the task is In Review with
one. Without an owner, remaining hours or positive weekly capacity, the
projection uses the planned end, or the current week if that end has passed.
Agents have no weekly capacity limit, so every ask fits. An agent's task is
projected to finish at its planned end, and competing workload does not
extend it.

**0 Remaining** means no work left, while an empty field means no estimate.
With an owner and capacity, zero projects completion in the current week or
the planned start week if later. A passed due date still makes the task
Late, and a passed planned end can still make it Behind plan.

A group's planned end is the latest end of its scheduled subtasks. Groups
use that end and their due date, not their saved status or a
separate estimate. A saved Done status cannot hide a missed deadline while
descendant work is unfinished. Once all descendant work is Done, the group
has no delay verdict.

When Qivo cannot read all of a group's subtasks, such as for a very large
group, the group can show only **Late**, and only when its due date has
passed or the subtasks it read already end after the due week. Otherwise it has no verdict, because the
plan it read cannot show whether the group is on track. For the same
reason, when that plan ends before the due date, the hover text of its
Roadmap due line says that Qivo could not read all of its subtasks.

## Where you see it

- **Roadmap** colors a bar yellow or red from the today line on, and its
  unplanned marker and edge badges with it. A bar whose plan ended before
  the current week runs on to the end of the current week. **Projected
  delay**, on by default, adds diagonal stripes to the end of the projected
  finish week ([Scheduling by hand](./the-roadmap.md#scheduling-by-hand)).
  A due-date line is one neutral mark; hover it for its explanation. The
  Roadmap reads the owner's other work from the server too, and where that
  work cannot be read, a bar turns gray with a dashed outline and its hover
  text, like its due-date line's, says **Delay unknown**.
- **Board** shows **Behind plan** or **Late** above the card. The due-date
  tooltip also explains projected misses. Qivo reads the owner's other work
  from the server for the Board's cards, so their delay shows without
  loading every task; where that work cannot be read, the card says
  **Delay unknown**. A task you create shows on the Board at once, and its
  card takes its delay from the server like any other.
- **Task window** shows **Behind plan** or **Late** beside Due.
  Hover for the projected finish week. A missed or projected-to-miss deadline
  outlines Due in red. Qivo reads the owner's other work from the server,
  as for the task's Board card, and the window shows the same verdict as
  its card, also for a task you just created. The window shows nothing
  while that work is on its
  way, and says **Delay unknown** only where it cannot be read. A passed
  due date shows **Late**. A task with subtasks takes its delay from its
  subtasks' dates, not from anyone's other work, so it says **Delay
  unknown** only while some of those dates have not loaded. In the task
  window, those are the dates of its subtasks, which the window reads with
  the task. Where it cannot read them all, it takes the dates from the
  task's card or row in an open view that shows it, and follows as they
  change. Without one, as when that view is hidden behind another page, it
  says **Delay unknown**, or **Overdue** once the due date has passed.
- **Team sync** shows the same banner as a Board card on its rows, **Delay
  unknown** included, judged on the server with each owner's other work.
  Where Qivo could not read someone's other work, the team summary's
  **Projected to miss** and **Behind plan** counts read **unknown**, never 0
  ([Team sync](./planning-against-real-capacity.md#team-sync)).
- **Overview** includes projected misses in **Overdue & at risk**, which
  Qivo works out on the server with each owner's other work. A row says
  **risk unknown** where Qivo could not read that work, so the task may not
  be late, and the projected count says it is not available where it could
  not work out every projection. The health table's **Late** and
  **Behind plan** counts come from the server too, and read **unknown** where
  Qivo could not read an owner's other work.
- **REST and MCP** task results carry the same verdict as `delay`, judged on
  today's date in UTC. A task's verdict says it is unavailable when Qivo
  cannot read the owner's other open work in one request. A row of a task
  list can also say unavailable when Qivo did not read the owner's other
  work for that page. A page reads that work within a fixed share of what it
  may read, so the rows of a person with very much open work can say
  unavailable on every page. For a guest or Viewer, Qivo reads it for only
  the first person on a page who needs it. Reading the task itself gives its
  verdict. See
  [Automation & AI](./automation-ai-the-rest-api-and-the-mcp-server.md).

## Turning it on and off

Change **Delay tracking** in Project settings. It defaults to on. Turning it
off removes delay colors and projected stripes; the hover text of roadmap
due-date markers still compares the planned end with the due date.

## Review time

Moving a task into **In Review** sets Remaining to its review time, 2 hours
by default, and records a new measurement even if the number is unchanged.
With a reviewer assigned, these hours count toward the reviewer's workload.
Leaving In Review keeps the remaining value. Update it if the next work
needs a different estimate.

People with **Lead** access can set **Review time** in Project settings,
from 0 to 999 hours. Sub-projects follow the project's value unless they set
an override. Clear the override to follow the project again. Changes apply
to future moves into In Review; tasks already there keep their estimates.
