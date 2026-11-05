/* A reference names a task the workspace does not hold, by its
   organization and its number, its uuid, or both, so a window opens it from
   the server (store/planner.ts P.watchTaskRef) rather than by a handle.

   A handle is a home key ("QN-482") or a uuid, and only names a task the
   workspace holds (store/taskIndex.ts). A reference is a string kept apart
   from both. It starts with REF, so no lookup of a handle (P.issueById,
   P.anyTask, P.handleOf) ever finds it and none reads as a home key. App
   holds it as its open task, the address names the task by it
   (lib/router.ts), and the store moves it to the task's handle in the
   repaint in which the workspace first holds the task (P.watchHandles).

   Every opener that knows the task's organization names it: Search, a
   Board card, a phone row, an Overview row, Parent, Subtasks, Linked tasks
   and an Inbox row. An address names a number in the organization its
   slug names, or in the home organization for `~`, and a uuid with the
   organization to read it in first (`from`), since an address can name
   another organization's task by its uuid under the home slug
   (lib/router.ts syncPath). Such a uuid has no organization until a read
   answers, and the store reads it in the login's organizations one after
   another (P.taskRefState). */

/** What a reference names. `org` is the task's organization when it is
    certain, with its number, its uuid, or both. `from` is the organization
    an address names a uuid under, which the store reads it in first. */
export type RefParts = {
  org: string | null
  num?: number
  uuid?: string
  from?: string
}

const REF = 'ref:'

/** The reference for task `parts`, which only refParts reads. */
export function taskRef(parts: {
  org: string | null
  num?: number | null
  uuid?: string | null
  from?: string | null
}): string {
  const fields = [parts.org, parts.num, parts.uuid?.toLowerCase(), parts.from]
  return `${REF}${fields.map((field) => field ?? '').join('/')}`
}

/** What reference `open` names, or undefined for a handle, null or none. */
export function refParts(open: string | null | undefined): RefParts | undefined {
  if (!open?.startsWith(REF)) return undefined
  const [org = '', num = '', uuid = '', from = ''] = open.slice(REF.length).split('/')
  return {
    org: org || null,
    ...(num ? { num: Number(num) } : {}),
    ...(uuid ? { uuid } : {}),
    ...(from ? { from } : {}),
  }
}

/** Whether `open` is a reference rather than a handle. */
export const isTaskRef = (open: string | null | undefined): open is string =>
  !!open?.startsWith(REF)
