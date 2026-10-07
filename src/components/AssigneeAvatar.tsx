import { Avatar, Icon, Popover } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { type IssueVM, P } from '@/store/planner'

export type OwnerField = 'assignee' | 'reviewer'

/** The roster behind every owner control, as a filterable list: the task
 * window's eligibility rule (active, Edit or Lead on the task's project,
 * never a Viewer), with "Unassigned" or "No reviewer" first. Picking writes
 * `field` when the pick changes it, then calls `onPick`. Without `field` it
 * writes the live task's owner field, re-read at the pick: a status move
 * while the list was open can hand the task between assignee and reviewer.
 * `onClose` runs on every accepted pick, changed or not, and is handed the
 * write as `then`, to run once the list has closed (after a phone Back
 * layer's own step, see useMenuBackLayer). */
export function OwnerPickList({
  issue,
  field,
  onClose,
  onPick,
}: {
  issue: IssueVM
  field?: OwnerField
  onClose: (then: () => void) => void
  onPick?: (profileId: string | null) => void
}) {
  const shown = field ?? issue.ownerField
  const current = issue[shown] || null
  const choices = P.issueAssigneesFor(issue.project)
  const none = shown === 'reviewer' ? 'No reviewer' : 'Unassigned'
  const find = shown === 'reviewer' ? 'Find a reviewer' : 'Find an assignee'
  return (
    <Command aria-label={`Choose ${shown}`} onClick={(event) => event.stopPropagation()}>
      <CommandInput placeholder={`${find}…`} aria-label={find} />
      <CommandList className="max-h-60">
        <CommandEmpty>
          {shown === 'reviewer' ? 'No matching reviewers.' : 'No matching assignees.'}
        </CommandEmpty>
        {[{ id: null, name: none }, ...choices].map((user) => (
          <CommandItem
            key={user.id || 'unassigned'}
            value={user.id || 'unassigned'}
            keywords={[user.name]}
            onSelect={() => {
              const live = P.issueById[issue.id]
              if (!live) return
              // Recheck the live roster in case access changed while the menu was open.
              if (
                !P.canWrite(live.project) ||
                (user.id && !P.issueAssigneesFor(live.project).some((u) => u.id === user.id))
              )
                return
              onClose(() => {
                const task = P.issueById[issue.id]
                if (!task) return
                const f = field ?? task.ownerField
                if ((task[f] || null) === user.id) return
                P.updateIssue(
                  issue.id,
                  f === 'reviewer' ? { reviewer: user.id } : { assignee: user.id },
                )
                onPick?.(user.id)
              })
            }}
            className="gap-2 py-2"
          >
            <Avatar id={user.id} size={28} />
            <span className="min-w-0 flex-1 truncate">{user.name}</span>
            {current === user.id && <Icon name="check" size={16} />}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}

/** The task owner's portrait, with the same roster as task details behind a
 * portrait-sized trigger. It shows and edits `issue.ownerField`: the reviewer
 * while the task waits In Review with one set, else the assignee, so picking
 * a face never reassigns work the portrait did not show.
 * `field` pins the edited field instead (the sync's "Needs an owner" assigns
 * a task whose reviewer owns it; "Needs a reviewer" names a reviewer on a
 * task its assignee owns). `onPick` runs after a write. `variant` picks the
 * trigger: the board's bare portrait, a 20px portrait with a chevron (a sync
 * row), or a select-look "Assign" / "Reviewer" button (the sync's opening).
 * Without write access the portrait variant is the plain portrait and the
 * others are disabled, with the task window's read-only hover text.
 * `backLayer` gives the open list a phone Back step (the Team sync page). */
export function AssigneeAvatar({
  issue,
  compact = false,
  field,
  onPick,
  variant = 'portrait',
  backLayer = false,
}: {
  issue: IssueVM
  compact?: boolean
  field?: OwnerField
  onPick?: (profileId: string | null) => void
  variant?: 'portrait' | 'chevron' | 'label'
  backLayer?: boolean
}) {
  const shown = field ?? issue.ownerField
  const who = issue[shown]
  const none = shown === 'reviewer' ? 'No reviewer' : 'Unassigned'
  const name = P.user(who)?.name || none
  const canWrite = P.canWrite(issue.project)
  const portrait = (
    <span
      className={
        compact
          ? 'inline-flex size-[18px] shrink-0 [&>*]:!size-[18px] [&>*]:!rounded-[4px] [&>*]:!text-[9px]'
          : 'inline-flex size-7 shrink-0'
      }
    >
      <Avatar id={who} size={28} />
    </span>
  )
  if (variant === 'portrait' && !canWrite) return portrait

  const face =
    variant === 'portrait' ? (
      portrait
    ) : variant === 'chevron' ? (
      <>
        <Avatar id={who} size={20} />
        <Icon name="chevronDown" size={12} color="var(--text-3)" />
      </>
    ) : (
      <>
        {who ? (
          <Avatar id={who} size={20} />
        ) : (
          <span className="grid size-5 place-items-center rounded-[4px] border border-dashed border-border-strong bg-surface-3">
            <Icon name="user" size={11} color="var(--text-3)" />
          </span>
        )}
        <span className="text-sm text-text-2">{shown === 'reviewer' ? 'Reviewer' : 'Assign'}</span>
        <Icon name="chevronDown" size={13} color="var(--text-3)" />
      </>
    )
  const faceClass =
    variant === 'portrait'
      ? 'flex cursor-pointer rounded-md outline-none hover:ring-2 hover:ring-border-strong focus-visible:ring-2 focus-visible:ring-primary'
      : variant === 'chevron'
        ? 'inline-flex h-control-sm shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-1 hover:border-border hover:bg-hover disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-transparent disabled:hover:bg-transparent'
        : 'gap-1.5 px-2 font-normal'
  return (
    <span
      role="presentation"
      className="pointer-events-auto relative inline-flex shrink-0"
      onClick={(event) => event.stopPropagation()}
    >
      <Popover
        width={260}
        align="right"
        backLayer={backLayer}
        button={(toggle) => (
          <Button
            type="button"
            variant={variant === 'label' ? 'default' : 'unstyled'}
            size={variant === 'label' ? 'sm' : undefined}
            data-field-trigger={variant === 'portrait' ? undefined : ''}
            data-assignee-edit={issue.id}
            data-owner-field={shown}
            aria-label={`Change ${shown} for ${issue.title}: ${name}`}
            title={canWrite ? `Change ${shown} · ${name}` : 'Read-only project access'}
            disabled={!canWrite}
            draggable={false}
            onDragStart={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            className={faceClass}
          >
            {face}
          </Button>
        )}
      >
        {(close) => <OwnerPickList issue={issue} field={field} onClose={close} onPick={onPick} />}
      </Popover>
    </span>
  )
}
