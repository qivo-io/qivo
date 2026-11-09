/* What Team sync says in place of its meeting when it cannot show one
   (views/teamSync/useSyncMeeting.ts): the picker for a scope it does not
   have or the server cannot honour, the loading frame, the meeting's
   limits and a failed read; and above a meeting it shows, the note of one
   that stopped fitting or failed to read, and the note of one some of
   whose tasks have not reached the page. Each full note is an
   empty state (data-empty-state), where focus goes once a task window
   closes over it (lib/taskFocus.ts). Its smaller scopes come from the
   server: a meeting that stopped fitting offers what its last fitted
   answer named (its top-level projects for All projects, its sub-projects
   for a project), and a fresh one past its limits, and a team's either
   way, the first batch of the navigation reads (projectNav.page with the
   home organization, with the team's id, and projectNav.children), with
   the person's own teams for All projects. They widen nothing, as the
   server answers every scope; none shows a 0, a count or a person the
   answer did not give. */

import { navCursors } from '@/components/projectNavRows'
import { Icon } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { useProjects } from '@/components/useProjects'
import { ViewNote } from '@/components/ViewNote'
import { api } from '../../../convex/_generated/api'
import { LIMITS } from '../../../convex/lib/limits'
import type {
  NavChildRow,
  NavChildren,
  NavPage,
  NavPageRow,
} from '../../../convex/model/projectNavReads'
import { fmtTime } from '../../lib/dates'
import { limitSentence } from '../../lib/fieldLimits'
import { usePagedList } from '../../lib/pagedList'
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

/** The smaller scopes a meeting past its limits offers (useNarrower):
    the choices, null for a sub-project, which has nothing smaller, and a
    line that says the list is loading, could not load, or goes on in the
    scope menu past its first batch. */
type Narrower = { choices: SyncChoice[] | null; line: string | null }

/* What a note's choices say past their first batch, and while they come. */
const MORE_IN_MENU = 'More teams and projects are in the menu above.'
const CHOICES_LOADING = 'Loading the smaller teams and projects…'
const CHOICES_FAILED = "Couldn't load the smaller teams and projects. Use the menu above."

/** A project of the home organization as a choice, its name through the
    project cache where it knows the project, else the row's own. */
const projectChoice = (p: { id: string; name: string }): SyncChoice => ({
  key: `project:${p.id}`,
  label: P.projectLabel(p),
  icon: 'board',
})

/**
 * The smaller scopes a meeting of `scopeKey` past its limits can narrow to,
 * read only while `active`: for All projects the person's teams and the
 * top-level projects they see, for a team the projects and sub-projects
 * shared with it that they see, for a top-level project its sub-projects
 * they see, and null for a sub-project. A meeting that stopped fitting
 * (`stale`) offers its last fitted answer's top-level projects and
 * sub-projects, named through the project cache; a fresh one, and a team
 * either way, the first batch of projectNav.page (with the home
 * organization, and the team's id) or projectNav.children, with a line
 * pointing to the scope menu where the list goes on.
 */
function useNarrower(scopeKey: string, meeting: SyncMeeting, active: boolean): Narrower {
  const scope = parseSyncScope(scopeKey)
  const home = P.homeOrg
  const answer = meeting.state === 'stale' ? meeting.answer : null
  const scopeId = scope.kind === 'project' ? scope.id : null
  // the scope's project and the fitted answer's projects, named while the
  // note shows, so the cache answers whether the scope is a top-level
  // project and what each choice is called
  useProjects(
    active ? [scopeId, ...(answer?.top_projects ?? []), ...(answer?.sub_projects ?? [])] : [],
  )
  const facts = scopeId ? P.project(scopeId) : undefined
  const fromAnswer =
    answer !== null && (scope.kind === 'all' || (scope.kind === 'project' && !!facts))
  // the list a fresh meeting reads, and a team's either way
  const read: { key: string; kind: 'page' | 'team' | 'children' } | null =
    !active || fromAnswer || !home
      ? null
      : scope.kind === 'all'
        ? { key: JSON.stringify(['sync-note', home]), kind: 'page' }
        : scope.kind === 'team'
          ? { key: JSON.stringify(['sync-note', home, scope.id]), kind: 'team' }
          : scope.kind === 'project' && facts?.type === 'meta'
            ? { key: JSON.stringify(['sync-note', scope.id]), kind: 'children' }
            : null
  const pages = usePagedList<NavPage, NavPageRow | (NavPageRow & { parent_id: string | null })>({
    key: read && read.kind !== 'children' ? read.key : null,
    source: {
      kind: 'live',
      query: api.projectNav.page,
      args: (at) => ({
        org_id: home,
        ...(scope.kind === 'team' ? { team_id: scope.id } : {}),
        ...navCursors(at),
      }),
    },
    batch: (a) => (a.state === 'ok' ? a : null),
    id: (row) => row.id,
    most: LIMITS_FIRST_BATCH,
  })
  const children = usePagedList<NavChildren, NavChildRow>({
    key: read?.kind === 'children' ? read.key : null,
    source: {
      kind: 'live',
      query: api.projectNav.children,
      args: (at) => ({ project_id: scopeId ?? '', ...navCursors(at) }),
    },
    batch: (a) => (a.state === 'ok' ? a : null),
    id: (row) => row.id,
    most: LIMITS_FIRST_BATCH,
  })
  if (!active) return { choices: [], line: null }
  const own = scope.kind === 'all' ? pickerChoices().filter((c) => c.key !== 'all') : []
  if (scope.kind === 'project') {
    if (!facts) return { choices: [], line: CHOICES_LOADING }
    if (facts.type !== 'meta') return { choices: null, line: null }
  }
  if (scope.kind !== 'all' && scope.kind !== 'team' && scope.kind !== 'project')
    return { choices: [], line: null }
  if (fromAnswer && answer) {
    const ids = scope.kind === 'all' ? answer.top_projects : answer.sub_projects
    const named = ids.flatMap((id) => {
      const p = P.project(id)
      return p ? [projectChoice(p)] : []
    })
    return {
      choices: [...own, ...named],
      line: named.length < ids.length ? CHOICES_LOADING : null,
    }
  }
  const list = read?.kind === 'children' ? children : pages
  const rows = list.rows.map((row) => projectChoice(row))
  const line =
    list.phase === 'first'
      ? CHOICES_LOADING
      : list.phase === 'failed' || list.phase === 'held'
        ? CHOICES_FAILED
        : list.next || list.stopped
          ? MORE_IN_MENU
          : null
  return { choices: [...own, ...rows], line }
}

/* A note reads one batch of its list: the first, 25 rows. */
const LIMITS_FIRST_BATCH = 25

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

/** The title and hint of a meeting past its limits, `state`, with the
    smaller scopes `smaller` it offers (useNarrower). */
function overText(state: 'over_ceiling' | 'over_budget', smaller: Narrower) {
  const title =
    state === 'over_ceiling'
      ? limitSentence(LIMITS.teamSyncTasks)
      : "This selection could not be loaded within Team sync's limits."
  return {
    title,
    choices: smaller.choices ?? [],
    // a sub-project offers nothing smaller: its Board shows its tasks
    hint:
      smaller.choices === null
        ? 'Team sync cannot show this sub-project. Its Board shows its tasks.'
        : smaller.line
          ? `Choose a smaller team or project. ${smaller.line}`
          : 'Choose a smaller team or project.',
    board: smaller.choices === null,
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
  const past = meeting.state === 'over_ceiling' || meeting.state === 'over_budget'
  const smaller = useNarrower(scopeKey, meeting, past)
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
      const text = overText(meeting.state, smaller)
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

/** Where the resolve of a Team sync address that names a project by its
    number stands while it has not opened the project (views/TeamSync.tsx):
    loading, failed, or the access_unchecked refusal with its sentence, the
    last two with a way to ask again. */
export type ResolveState =
  | { state: 'loading' }
  | { state: 'failed'; retry: () => void }
  | { state: 'unchecked'; message: string; retry: () => void }

/** What Team sync says in place of its meeting while it resolves a
    project its address names by number: that it is opening the project,
    or that it could not, with Retry, never that the project is not
    available. */
export function ResolveNote({ resolving }: { resolving: ResolveState }) {
  if (resolving.state === 'loading')
    return (
      <div data-sync-note="resolving" className="contents">
        <ViewNote
          hooks="sync"
          phone={false}
          icon="people"
          title="Opening the project…"
          hint="Qivo is checking that you can open this project."
        />
      </div>
    )
  return (
    <div data-sync-note={`resolve-${resolving.state}`} className="contents">
      <ViewNote
        hooks="sync"
        phone={false}
        icon="alert"
        title="Couldn't open this project"
        hint={
          resolving.state === 'unchecked'
            ? resolving.message
            : 'Qivo could not check whether you can open this project. Retry asks once more.'
        }
        action={{ label: 'Retry', onClick: resolving.retry }}
      />
    </div>
  )
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
  const shows = meeting.state === 'stale' && !!meeting.note && meeting.stoppedAt !== null
  const smaller = useNarrower(scopeKey, meeting, shows && meeting.note !== 'error')
  if (!shows || !meeting.note || meeting.stoppedAt === null) return null
  const at = fmtTime(new Date(meeting.stoppedAt))
  const stopped = `The meeting below stopped updating at ${at}.`
  const failed = meeting.note === 'error'
  const text = failed ? null : overText(meeting.note as 'over_ceiling' | 'over_budget', smaller)
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
