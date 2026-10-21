Every limit in Qivo is the same in the app, the REST API and the MCP server. A refused change keeps nothing and says which limit it passed and what to do. The app keeps what you typed or pasted, shows how many characters a field holds as it nears its limit and turns Save off until the text fits.

A character is one UTF-16 code unit, the count a browser's text field uses. Most letters count as one and most emoji as two. Qivo trims spaces and line breaks from both ends of a text before counting and stores the trimmed text.

## Text

| Limit | Value | Past the limit |
| --- | --- | --- |
| Task title | 255 characters | A task title must be at most 255 characters. Shorten it. |
| Task description | 20,000 characters | A task description must be at most 20,000 characters. Formatting counts too. Shorten it. |
| Comment | 20,000 characters | A comment must be at most 20,000 characters. Formatting counts too. Shorten it. |
| Project or sub-project name | 80 characters | A project name must be at most 80 characters. Shorten it. |
| Project description | 500 characters | A project description must be at most 500 characters. Shorten it. |
| Team name | 80 characters | A team name must be at most 80 characters. Shorten it. |
| Milestone name | 80 characters | A milestone name must be at most 80 characters. Shorten it. |
| Organization name | 80 characters | An organization name must be at most 80 characters. Shorten it. |
| Person name | 80 characters | A name must be at most 80 characters. Shorten it. |
| Agent key name | 80 characters | An agent key name must be at most 80 characters. Shorten it. |
| Personal token name | 80 characters | A personal token name must be at most 80 characters. Shorten it. |
| Label name | 40 characters | A label name must be at most 40 characters. Shorten it. |
| Delete reason | 500 characters | A delete reason must be at most 500 characters. Shorten it. |
| Archive reason | 500 characters | An archive reason must be at most 500 characters. Shorten it. |
| Search text | 200 characters | A search must be at most 200 characters. Search for fewer words. |
| Email address | 254 characters | An email address must be at most 254 characters. Use a shorter address. |
| Organization address | 40 characters | An organization address must be at most 40 characters of lowercase letters, digits and single hyphens between them. Choose another address. |

## Files and images

| Limit | Value | Past the limit |
| --- | --- | --- |
| Attachment file name | 255 characters | A file name must be at most 255 characters. Rename the file and attach it again. |
| Attachment media type | 255 characters | a file's media type must be at most 255 characters. Send a media type such as application/pdf. |
| Background image file name | 255 characters | An image file name must be at most 255 characters. Rename the file and upload it again. |
| Attachment size | 20 MiB per file | A file must be at most 20 MiB, this organization's attachment limit. Attach a smaller file. |
| Profile picture size | 2 MiB | A profile picture must be at most 2 MiB. Choose a smaller image. |
| Background image size | 8 MiB | A background image must be at most 8 MiB. Choose a smaller image. |
| Text file from attach_text_file | 256 KiB as UTF-8 | text must be at most 256 KiB (262,144 bytes) as UTF-8. Split it into several files. |

## Tasks and organizations

| Limit | Value | Past the limit |
| --- | --- | --- |
| Active subtasks per task | 100 active subtasks | The parent task already has 100 active subtasks, the most a task can have. Archive or remove one of them first. |
| Subtasks a move to another project carries | 200 subtasks, archived ones included | This task has more than 200 subtasks, archived ones included, and a move to another project carries them all. Restore some archived subtasks and remove them from this task first, or move it within its project. |
| Attachments per task | 100 attachments, description images included | This task already has 100 attachments, images in its description included, the most a task can have. Remove one first. |
| Links per task | 100 links | This task already has 100 links, the most a task can have. Remove one of its links first. |
| Labels per task | 20 labels | This task already has 20 labels, the most a task can have. Remove one first. |
| Followers per task | 100 followers | This task already has 100 followers, the most a task can have. Someone must unfollow it first. |
| People mentioned in one text | 100 people | A text can mention at most 100 people. Remove some mentions and save again. |
| Invitation emails per organization | 50 emails per hour | This organization sent 50 invitation emails in the last hour, the most it can send. Send this one again once the hour has passed. |
| Tasks one access removal reassigns | 120 tasks | A removal can reassign at most 120 tasks at once, fewer when the change is too large for one request. Keep the people as Viewers or reassign some of the tasks first. |
| People with open tasks one access removal settles | 700 people | A removal that keeps people as Viewers or reassigns their tasks can take access from at most 700 people with open tasks at once. Leave the tasks with them, or remove some of the team's members first. |
| Memberships and project shares one team deletion removes | 3,000 memberships and project shares | Deleting a team can remove at most 3,000 of its memberships and project shares at once. Remove some of its members or project shares first. |
| Inbox messages the app shows | 500 messages | The app shows your newest 500 inbox messages. Mark older ones read or remove them to see the rest. |
| Active billable users with online billing | 1,000 users | Online billing supports up to 1,000 active billable users. Email support@qivo.io to arrange billing for a larger organization. |

## Numbers and settings

| Limit | Value | Past the limit |
| --- | --- | --- |
| Weeks the Roadmap shows | 260 weeks (5 years) | The Roadmap shows at most 260 weeks (5 years). Move the start or the end closer. |
| Plannable hours per week | 1 to 168 hours | Plannable hours per week must be a whole number of hours from 1 to 168. |
| Remaining hours of a task | 0 to 99,999.9 hours | Remaining hours must be a number from 0 to 99,999.9. Enter a number in that range. |
| Review hours of a project | 0 to 999 hours | Review hours must be a number from 0 to 999. Enter a number in that range. |
| Organization attachment size setting | 1 to 20 MiB | The attachment size limit must be a whole number of MiB from 1 to 20. |
| Read message retention | 1 to 3,650 days | Message retention must be a whole number of days from 1 to 3,650. |
| Snooze | 366 days ahead | A snooze can be at most 366 days ahead. Pick an earlier time. |

## REST and MCP requests

| Limit | Value | Past the limit |
| --- | --- | --- |
| Tasks per list page | 1 to 200 tasks | limit must be a whole number of tasks from 1 to 200. |
| Inbox items per list page | 1 to 200 items | limit must be a whole number of items from 1 to 200. |
| Comments per list page | 1 to 50 comments | limit must be a whole number of comments from 1 to 50. |
| Workload weeks | 1 to 52 weeks | weeks must be a whole number from 1 to 52. |
| Tasks per inbox change | 100 tasks | tasks must name at most 100 tasks per call. Send the rest in another call. |
| Webhook subscription lifetime | 60,000 to 604,800,000 milliseconds | ttlMs must be a whole number of milliseconds from 60,000 (1 minute) to 604,800,000 (7 days), or null for no expiry. |
| Webhook subscriptions per organization | 100 subscriptions | an organization can have at most 100 unexpired webhook subscriptions, and one agent key, token or OAuth connection at most 20. Delete an unused subscription first. |
| Webhook subscriptions per agent key, token or OAuth connection | 20 subscriptions | an organization can have at most 100 unexpired webhook subscriptions, and one agent key, token or OAuth connection at most 20. Delete an unused subscription first. |
| Webhook callback URL | 2,048 characters | a callback URL must be at most 2,048 characters. Use a shorter URL. |
| Event subscription request | 16,384 characters | an event subscription request must be at most 16,384 characters. Send fewer or shorter parameters. |
| Request body | 1 MiB | a request body must be at most 1 MiB. Send less in one request. |
| Requests per person or agent | 300 requests per minute | too many requests, at most 300 a minute for one person or agent. Try again in 60 seconds. |
