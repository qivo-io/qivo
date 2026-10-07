Qivo estimates an unfinished task's finish week from its plan, remaining
hours and owner's workload. Delay tracking highlights two warnings:

- **Currently delayed**, in yellow. The projected finish is after the planned
  end, without a missed or projected-to-miss due date.
- **Delayed**, in red. The projected finish is after the due week, or the
  exact due date has already passed.

**On track** has no warning color. Finishing in the due week is not classed
as late, though its roadmap due-date marker warns that the schedule is tight.
Done tasks have no delay verdict. Tasks without a plan or due date also have
no verdict. A task with only a due date needs an owner and remaining hours
for a projection; without them, it gets a warning only once overdue.

## How the projection works

Each Remaining save records when you measured it. Qivo projects from that
week or the planned start, whichever is later, using the owner's plannable
hours ([Planning hours](./organization-and-team-settings.md#planning-hours-and-teams)) minus their other scheduled work. Paused work takes no capacity.
Organization admins and users receive organization-wide commitments, with
hidden-project hours kept anonymous. Viewers and guests receive only work
from visible projects and tasks they own ([Project access](./who-sees-what-the-access-model.md)).

The projection assumes progress since the measurement, so an estimate's age
alone does not add more work. Saving another estimate starts the calculation
from the new measurement. An unfinished task's projected finish cannot be
earlier than the current week.

The owner is the assignee, or the reviewer while the task is In Review with
one. Without an owner, remaining hours or positive weekly capacity, the
projection uses the planned end, or the current week if that end has passed.
Agents have no weekly capacity limit, so competing workload does not extend
their projected finish.

**0 Remaining** means no work left, while an empty field means no estimate.
With an owner and capacity, zero projects completion in the current week or
the planned start week if later. A passed due date still makes the task
Delayed, and a passed planned end can still make it Currently delayed.

Groups use their planned end and due date, not their saved status or a
separate estimate. A saved Done status cannot hide a missed deadline while
descendant work is unfinished. Once all descendant work is Done, the group
has no delay verdict.

## Where you see it

- **Roadmap** colors bars, unplanned markers, edge badges and due-date lines.
  Hover a due-date line for its explanation.
- **Board** shows **Slipping** or **Delayed** above the card. The due-date
  tooltip also explains projected misses.
- **Task window** shows **Currently delayed** or **Delayed** beside Due.
  Hover for the projected finish week. A missed or projected-to-miss deadline
  outlines Due in red.
- **Overview** includes projected misses in **Overdue & at risk** and counts
  **Delayed** and **Slipping** tasks in the health table.

## Turning it on and off

Change **Delay tracking** in Project settings. It defaults to on. Turning it
off removes delay colors; roadmap due-date markers still compare the planned
end with the due date. Done bars remain green.

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
