/* What Team sync says in place of its meeting when it cannot show one
   (views/teamSync/useSyncMeeting.ts): the picker for a scope it does not
   have or the server cannot honour, the loading frame, the meeting's
   limits and a failed read; and above a meeting it shows, the note of one
   that stopped fitting or failed to read, and the note of one some of
   whose tasks have not reached the page. Each full note is an
   empty state (data-empty-state), where focus goes once a task window
   closes over it (lib/taskFocus.ts). Its choices come from the person's
   own lists and widen nothing, as the server answers every scope; none
   shows a 0, a count or a person the answer did not give. */

import { Icon } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { ViewNote } from '@/components/ViewNote'
import { LIMITS } from '../../../convex/lib/limits'
import { fmtTime } from '../../lib/dates'
import { limitSentence } from '../../lib/fieldLimits'
import { parseSyncScope } from '../../lib/teamSync'
import { P } from '../../store/planner'
import type { SyncMeeting } from './useSyncMeeting'

/** One scope a note offers: its key (lib/teamSync.ts parseSyncScope) and
    its name. */
export type SyncChoice = { key: string; label: string; icon: string }

/** The person's own teams of the home organization, by name, then All
    projects, a deliberate choice: what the picker offers. */
function pickerChoices(): SyncChoice[] {
  const mine = new Set(P.user(P.CURRENT_USER)?.teams ?? [])
  const teams = P.teams
    .filter((t) => t.org === P.homeOrg && mine.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [
    ...teams.map((t) => ({ key: `team:${t.id}`, label: t.name, icon: 'people' })),
    { key: 'all', label: 'All projects', icon: 'layers' },
  ]
}

/** The smaller scopes a meeting past its limits can narrow to, from the
    browser's own lists: for All projects the person's teams and the
    top-level projects they see, for a team the projects shared with it
    that they see, for a top-level project its sub-projects they see. A
    sub-project has nothing smaller (null). */
function narrowerChoices(scopeKey: string): SyncChoice[] | null {
  const scope = parseSyncScope(scopeKey)
  const home = P.visibleProjects().filter((p) => p.org === P.homeOrg)
  const project = (p: (typeof home)[number]) => ({
    key: `project:${p.id}`,
    label: P.projectLabel(p),
    icon: 'board',
  })
  if (scope.kind === 'all')
    return [
      ...pickerChoices().filter((c) => c.key !== 'all'),
      ...home.filter((p) => p.type === 'meta').map(project),
    ]
  if (scope.kind === 'team')
    return P.projects
      .filter((p) => p.org === P.homeOrg && p.teamAccess[scope.id] !== undefined && P.canSee(p.id))
      .map(project)
  if (scope.kind !== 'project') return []
  const it = P.heldProject(scope.id)
  if (it?.type !== 'meta') return null
  return (it.children ?? [])
    .filter((id) => P.canSee(id))
    .flatMap((id) => {
      const sub = P.heldProject(id)
      return sub ? [project(sub)] : []
    })
}

/** The choices of a note, as buttons. */
function Choices({
  choices,
  onPick,
}: {
  choices: readonly SyncChoice[]
  onPick: (key: string) => void
}) {
  if (!choices.length) return null
  return (
    <div data-sync-choices className="flex max-w-[460px] flex-wrap justify-center gap-2">
      {choices.map((c) => (
        <Button key={c.key} type="button" data-sync-choice={c.key} onClick={() => onPick(c.key)}>
          <Icon name={c.icon} size={14} />
          <span className="truncate">{c.label}</span>
        </Button>
      ))}
    </div>
  )
}

/** A note with choices, in ViewNote's look. */
function ChoiceNote({
  state,
  icon,
  title,
  hint,
  choices,
  onPick,
  action,
}: {
  state: string
  icon: string
  title: string
  hint: string
  choices: readonly SyncChoice[]
  onPick: (key: string) => void
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div
      data-empty-state
      data-sync-note={state}
      className="qivo-empty-state animate-in fade-in slide-in-from-bottom-1 flex min-h-[260px] flex-1 flex-col overflow-y-auto p-10"
    >
      <div className="m-auto flex flex-col items-center gap-1.5">
        <div className="mb-2 grid size-[52px] place-items-center rounded-xl border border-border bg-surface-2 shadow-card">
          <Icon name={icon} size={22} color="var(--text-3)" />
        </div>
        <div data-empty-state-title className="max-w-[460px] text-center text-md font-semibold">
          {title}
        </div>
        <div className="max-w-[420px] text-center text-base leading-normal text-text-3">{hint}</div>
        {(choices.length > 0 || action) && (
          <div className="mt-3 flex flex-col items-center gap-3">
            <Choices choices={choices} onPick={onPick} />
            {action && (
              <Button type="button" onClick={action.onClick}>
                {action.label}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** The title and hint of a meeting past its limits, `state`, for the scope
    `scopeKey`. */
function overText(state: 'over_ceiling' | 'over_budget', scopeKey: string) {
  const title =
    state === 'over_ceiling'
      ? limitSentence(LIMITS.teamSyncTasks)
      : "This selection could not be loaded within Team sync's limits."
  const smaller = narrowerChoices(scopeKey)
  return {
    title,
    choices: smaller ?? [],
    // a sub-project offers nothing smaller: its Board shows its tasks
    hint:
      smaller === null
        ? 'Team sync cannot show this sub-project. Its Board shows its tasks.'
        : 'Choose a smaller team or project.',
    board: smaller === null,
  }
}

/** What Team sync says in place of its meeting for `meeting`'s state, or
    null while a meeting shows. */
export function SyncNote({
  meeting,
  scopeKey,
  onPick,
  onShowBoard,
}: {
  meeting: SyncMeeting
  scopeKey: string
  onPick: (key: string) => void
  onShowBoard: (projectId: string) => void
}) {
  const sub = parseSyncScope(scopeKey)
  const board = () => {
    if (sub.kind === 'project') onShowBoard(sub.id)
  }
  switch (meeting.state) {
    case 'choose':
      if (meeting.why === 'none')
        return (
          <ChoiceNote
            state="choose"
            icon="people"
            title="Choose what this meeting covers"
            hint="Team sync covers one team or project at a time. Pick one, or All projects from the menu above."
            choices={pickerChoices()}
            onPick={onPick}
          />
        )
      return (
        <ChoiceNote
          state="unresolved"
          icon="eyeOff"
          title="This team or project is not available"
          hint="Qivo cannot show it here. Choose another team or project."
          choices={pickerChoices()}
          onPick={onPick}
        />
      )
    case 'unavailable':
      return (
        <ChoiceNote
          state="unavailable"
          icon="eyeOff"
          title="This team or project is not available"
          hint={meeting.message ?? 'Qivo cannot show it here. Choose another team or project.'}
          choices={pickerChoices()}
          onPick={onPick}
        />
      )
    case 'over_ceiling':
    case 'over_budget': {
      const text = overText(meeting.state, scopeKey)
      return (
        <ChoiceNote
          state={meeting.state}
          icon="filter"
          title={text.title}
          hint={text.hint}
          choices={text.choices}
          onPick={onPick}
          action={text.board ? { label: 'Show it on the Board', onClick: board } : undefined}
        />
      )
    }
    case 'error':
      return (
        <ViewNote
          hooks="sync"
          phone={false}
          icon="alert"
          title="Team sync could not be loaded"
          hint="Try again asks the server for this meeting once more."
          action={{ label: 'Try again', onClick: meeting.retry }}
        />
      )
    case 'loading':
    case 'refreshing':
      if (meeting.shows) return null
      return (
        <ViewNote
          hooks="sync"
          phone={false}
          icon="people"
          title="Loading the meeting…"
          hint="Qivo is gathering this meeting's tasks and people."
        />
      )
    default:
      return null
  }
}

/** The note above a meeting some of whose tasks had no model to show
    STALL.ms after its answer named them (state incomplete): the meeting
    below leaves them out, and its counts with them. Try again asks only for
    the agenda, so the note says so rather than promise the tasks, as the
    Board's does (views/board/BoardNote.tsx IncompleteNote). */
export function IncompleteNote({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      data-sync-incomplete
      role="status"
      className="mb-5 flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-4"
    >
      <div className="text-base font-semibold text-text-1">
        Some of this meeting's tasks have not reached the page
      </div>
      <div className="text-sm text-text-2">
        The meeting below leaves them out, and its counts with them. Try again asks the server for
        this meeting once more. If the tasks still do not show, reload the page.
      </div>
      <div>
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

/** The note above a meeting that stopped fitting, or whose read failed, as
    it last fitted (state stale): what stopped it, when, and the ways on. */
export function StaleNote({
  meeting,
  scopeKey,
  onPick,
  onShowBoard,
}: {
  meeting: SyncMeeting
  scopeKey: string
  onPick: (key: string) => void
  onShowBoard: (projectId: string) => void
}) {
  if (meeting.state !== 'stale' || !meeting.note || meeting.stoppedAt === null) return null
  const at = fmtTime(new Date(meeting.stoppedAt))
  const stopped = `The meeting below stopped updating at ${at}.`
  const failed = meeting.note === 'error'
  const text = failed ? null : overText(meeting.note as 'over_ceiling' | 'over_budget', scopeKey)
  const sub = parseSyncScope(scopeKey)
  return (
    <div
      data-sync-stale-note={meeting.note}
      role="status"
      className="mb-5 flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-4"
    >
      <div className="text-base font-semibold text-text-1">
        {failed ? 'Team sync could not be loaded' : text?.title}
      </div>
      <div className="text-sm text-text-2">
        {failed
          ? `Try again asks the server for this meeting once more. ${stopped}`
          : `${text?.hint} ${stopped}`}
      </div>
      {text && text.choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {text.choices.map((c) => (
            <Button
              key={c.key}
              type="button"
              data-sync-choice={c.key}
              onClick={() => onPick(c.key)}
            >
              <Icon name={c.icon} size={14} />
              <span className="truncate">{c.label}</span>
            </Button>
          ))}
        </div>
      )}
      {(failed || text?.board) && (
        <div>
          <Button
            type="button"
            onClick={() =>
              failed ? meeting.retry() : sub.kind === 'project' && onShowBoard(sub.id)
            }
          >
            {failed ? 'Try again' : 'Show it on the Board'}
          </Button>
        </div>
      )}
    </div>
  )
}
