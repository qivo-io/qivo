/* A project's access on its Settings page, read from the server: the Teams
   and Users lists (projectSettings.teams and users), each a batch of 25 in
   the server's name order with its own search and Load more through the
   shared paged list's live source (lib/pagedList.ts), and the Add team or
   user picker (projectSettings.candidates), 25 choices at a time across
   teams and then people, read once a batch while it is open. The lists are
   the project's explicit grants: access through a team or the parent
   project shows on neither, and a row the lists do not show never reads as
   no access. The browser sorts, filters and counts nothing; every right
   comes from the page (projectSettings.get), and every write names one
   grant with the level its row showed, so the server refuses a change
   made meanwhile. LeadPicker, the Lead field's popover over
   projectSettings.leadCandidates, lives here too, beside the Add picker;
   the New project and New sub-project dialogs use it as well. The search
   box and the end lines both pickers share are in pickerParts.tsx, and
   their words in pickerWords.ts. */
import type { FunctionReference, FunctionReturnType } from 'convex/server'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { api } from '../../convex/_generated/api'
import { LIMITS } from '../../convex/lib/limits'
import { ACCESS_CAPS } from '../lib/accessCaps'
import { DEMO_MODE } from '../lib/demoMode'
import { limitSentence } from '../lib/fieldLimits'
import { useFocusWhenGone } from '../lib/focusWhenGone'
import {
  type BatchAt,
  type ListBatch,
  type ListEnd,
  listEnd,
  listPassed,
  type PagedList,
  usePagedList,
  useSettledSearch,
} from '../lib/pagedList'
import { useUpdateBlocker } from '../lib/updateSafety'
import {
  type AccessChoices,
  type AccessLevel,
  type LeadChoices,
  P,
  REMOVAL_CHECKING,
} from '../store/planner'
import { LimitedInput } from './LimitedField'
import { ChoiceEnd, PickerSearch } from './pickerParts'
import { ACCESS_WORDS, escapeClearsFirst, LEAD_WORDS } from './pickerWords'
import { Avatar, Icon, MenuItem, Popover } from './qivo'
import { SettingsGroup } from './settingsPage'

type UsersAnswer = FunctionReturnType<typeof api.projectSettings.users>
type TeamsAnswer = FunctionReturnType<typeof api.projectSettings.teams>
type UserRow = Extract<UsersAnswer, { state: 'ready' }>['rows'][number]
type TeamRow = Extract<TeamsAnswer, { state: 'ready' }>['rows'][number]
type LeadRow = NonNullable<Extract<UsersAnswer, { state: 'ready' }>['lead']>
/** A choice of the Add team or user picker. */
export type AccessChoice = Extract<AccessChoices, { state: 'ready' }>['rows'][number]
/** A person a lead picker offers. */
export type LeadChoice = Extract<LeadChoices, { state: 'ready' }>['rows'][number]
type GrantLevel = 'user' | 'viewer'
type Kind = 'team' | 'user'

/** The project the lists and pickers read, as the page showed it. */
export type ShownProject = { id: string; org_id: string }

/** What the Add picker keeps of its chosen team or person, by id and
    name, so the button names it through later searches and batches. */
export type AccessTarget = {
  type: Kind
  id: string
  name: string
  levels: readonly GrantLevel[]
  can_lead: boolean
}

const LEVEL_NAMES: Record<AccessLevel, string> = { lead: 'Lead', user: 'User', viewer: 'Viewer' }

/* The arguments of one batch of a list, in a fixed key order with empty
   fields left out, so equal batches share one subscription. */
const listArgs = (project: ShownProject, search: string, at: BatchAt) => ({
  org_id: project.org_id,
  project_id: project.id,
  ...(search === '' ? {} : { search }),
  ...(at.after === null ? {} : { after: at.after }),
  ...(at.through === null ? {} : { through: at.through }),
})

/** One of the two access lists: its search box's text, the settled search
    and the paged list over `query`. */
function useAccessList<A, Row extends { id: string; name: string }>(
  query: FunctionReference<'query'>,
  project: ShownProject,
  batch: (answer: A) => ListBatch<Row> | null,
) {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: JSON.stringify(listArgs(project, search.settled, { after: null, through: null })),
    source: { kind: 'live', query, args: (at) => listArgs(project, search.settled, at) },
    batch,
    id: (row: Row) => row.id,
    most: ACCESS_CAPS.list,
  })
  const end: ListEnd | 'too_long' = search.tooLong
    ? 'too_long'
    : listEnd(list, search.settled !== '')
  return { text, setText, search, list, end }
}

/* What a batch says in place, after its rows, with Retry: a batch above
   the last that failed, and one whose read stopped without checking
   anything, wherever it is, as Settings › Labels shows them. */
function BatchNote({
  kind,
  note,
  retrying,
  onRetry,
}: {
  kind: Kind
  note: 'failed' | 'stuck'
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <div
      role="alert"
      data-project-access-batch-note={note}
      className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-text-2"
    >
      {note === 'failed'
        ? kind === 'team'
          ? "Couldn't load these teams."
          : "Couldn't load these people."
        : 'Qivo could not check part of the list.'}
      <Button
        type="button"
        variant="ghost"
        className="h-control-sm text-sm"
        aria-disabled={retrying || undefined}
        onClick={() => !retrying && onRetry()}
      >
        {retrying ? 'Loading…' : 'Retry'}
      </Button>
    </div>
  )
}

const noteClass = 'px-0.5 py-1 text-sm text-text-2'

/* The line that ends an access list (lib/pagedList.ts listEnd), with its
   Load more and Retry, in that list's words. A list that answered no rows
   says why, and never that the list is empty: `held` names the answer.
   The empty line shows only at the list's real end with nothing shown,
   and takes focus when the last row leaves. A search's no-match line
   shows only when the search matched no row, the lead's included. */
function AccessEndLine({
  kind,
  end,
  held,
  shown,
  matched,
  stopped,
  first,
  loading,
  searching,
  onMore,
  onRetry,
}: {
  kind: Kind
  end: ListEnd | 'too_long'
  /** the state of a first answer with no rows */
  held: string | undefined
  /** whether any row shows, the lead's and kept ones included */
  shown: boolean
  /** whether the search matched a row outside the batches' rows, as the
      lead's row, which the server answers beside them */
  matched: boolean
  stopped: boolean
  /** whether the list holds its first batch at most */
  first: boolean
  loading: boolean
  searching: boolean
  onMore: () => void
  onRetry: () => void
}) {
  const team = kind === 'team'
  const line = (text: string, status = false) => (
    <p data-project-access-end={end} role={status ? 'status' : undefined} className={noteClass}>
      {text}
    </p>
  )
  switch (end) {
    case 'too_long':
      return line(limitSentence(LIMITS.search))
    case 'loading':
      return line(team ? 'Loading teams…' : 'Loading people…', true)
    case 'held':
      return line(
        held === 'unavailable' || held === 'archived'
          ? 'This project is no longer available.'
          : "Project access can't be listed yet. Try again in a few minutes.",
      )
    case 'failed':
      return (
        <div
          role="alert"
          data-project-access-end={end}
          className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-danger"
        >
          {first
            ? team
              ? "Couldn't load teams."
              : "Couldn't load people."
            : team
              ? "Couldn't load more teams."
              : "Couldn't load more people."}
          <Button type="button" variant="ghost" className="h-control-sm text-sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )
    case 'full':
      return line(team ? 'Search to find more teams.' : 'Search to find more people.')
    case 'more':
      return (
        <div data-project-access-end={end} className="flex flex-col items-start gap-1">
          {stopped && (
            <p className={noteClass}>Qivo checked part of the list. Load more continues.</p>
          )}
          <Button
            type="button"
            variant="ghost"
            data-project-access-more={kind}
            aria-disabled={loading || undefined}
            onClick={onMore}
            className="h-control-sm text-sm"
          >
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )
    case 'partial':
      return null
    case 'none':
      // not `shown`: a kept Added row shows whatever the search
      return matched ? null : line(team ? 'No teams match.' : 'No one matches.')
    case 'end':
      return shown || searching ? null : (
        <p data-project-access-none={kind} tabIndex={-1} className="text-sm text-text-2">
          {team ? 'No teams added.' : 'No individual users added.'}
        </p>
      )
  }
}

/* A list's search box. Escape clears a typed search first. */
function ListSearch({
  kind,
  text,
  onText,
  inputRef,
}: {
  kind: Kind
  text: string
  onText: (text: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const label = kind === 'team' ? 'Search teams' : 'Search people'
  return (
    <LimitedInput
      ref={inputRef}
      limit={LIMITS.search}
      aria-label={label}
      placeholder={label}
      data-project-access-list-search={kind}
      value={text}
      onChange={(e) => onText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && text) {
          e.stopPropagation()
          onText('')
        }
      }}
      wrapperClassName="mb-1.5"
      className="h-control-sm w-full bg-surface-1 px-2.5 text-sm font-sans"
    />
  )
}

/** The state an access list marks on its element: loading, failed,
    refreshing after the page showed again, else ok. */
const stateOf = <A, Row>(list: PagedList<A, Row>) =>
  list.phase === 'first'
    ? 'loading'
    : list.phase === 'failed' || list.batches.some((b) => b.note === 'failed')
      ? 'failed'
      : list.refreshing
        ? 'refreshing'
        : 'ok'

/** Load more for `list`, which keeps focus while it reads; once its button
    goes, focus moves to the first new row's role select while it is
    enabled, else to the list's search box (useFocusWhenGone). A reader
    whose role select stays off, such as one without the right to change
    access, gets the search box rather than a target that never takes
    focus. */
function useMore<A, Row extends { id: string }>(
  list: PagedList<A, Row>,
  end: ListEnd | 'too_long',
  rowSelect: (id: string) => HTMLElement | null,
  searchBox: React.RefObject<HTMLInputElement | null>,
) {
  const from = useRef<number | null>(null)
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = from.current === null ? undefined : list.rows[from.current]
    const select = row ? rowSelect(row.id) : null
    return select && !select.matches(':disabled') ? select : searchBox.current
  })
  return () => {
    if (list.phase === 'more') return
    from.current = list.rows.length
    list.more()
  }
}

/** One kept row: a grant this visit added past the loaded rows. */
type Kept = { kind: Kind; id: string; name: string; level: AccessLevel }

/**
 * A project's Teams and Users access lists and the Add team or user
 * picker. `canManageUsers`, `canManageTeams` and `canChangeLead` are the
 * page's rights (projectSettings.get). `current` is false from a failure
 * of the page's read until a new answer comes, Try again's wait included,
 * and while its project is no longer available (unavailable or archived),
 * and every control that writes is off then. A page refreshing for another
 * reason, as after the tab showed again, keeps the controls of the answer
 * it kept.
 * `onLevel` sends one grant's level, or Lead through the Lead field's
 * write, with the level the row showed (null for a new grant), and
 * resolves whether the server accepted it; the row shows the chosen level,
 * disabled and busy, until then. `onRemove` presses a row's Remove;
 * `checking` says the press waits for the server's preview, and `removing`
 * that its write is on its way, which hides the row until the list no
 * longer holds it, and shows it again on a refusal. A grant added past the
 * loaded rows shows at the top of its list as "Added", without controls,
 * until a loaded batch holds it or tells that it does not.
 */
export function ProjectAccessEditor({
  project,
  canManageUsers,
  canManageTeams,
  canChangeLead,
  current,
  role,
  onRoleChange,
  onLevel,
  onRemove,
  checking,
  removing,
}: {
  project: ShownProject
  canManageUsers: boolean
  canManageTeams: boolean
  canChangeLead: boolean
  current: boolean
  role: AccessLevel
  onRoleChange: (role: AccessLevel) => void
  onLevel: (
    kind: Kind,
    id: string,
    level: AccessLevel,
    shown: GrantLevel | null,
  ) => Promise<boolean>
  onRemove: (kind: Kind, id: string) => void
  checking: (kind: Kind, id: string) => boolean
  removing: (kind: Kind, id: string) => boolean
}) {
  const teams = useAccessList(api.projectSettings.teams, project, (answer: TeamsAnswer) =>
    answer.state === 'ready' ? answer : null,
  )
  const users = useAccessList(api.projectSettings.users, project, (answer: UsersAnswer) =>
    answer.state === 'ready' ? answer : null,
  )
  const firstUsers = users.list.answers[0]
  const lead: LeadRow | null =
    firstUsers?.state === 'ready' && firstUsers.lead && !removing('user', firstUsers.lead.id)
      ? firstUsers.lead
      : null
  // the levels chosen and on their way, by kind and id
  const [pending, setPending] = useState<ReadonlyMap<string, AccessLevel>>(() => new Map())
  const [kept, setKept] = useState<readonly Kept[]>([])
  const [target, setTarget] = useState<AccessTarget | null>(null)
  const [adding, setAdding] = useState(false)
  useUpdateBlocker(!!target)
  const teamSearch = useRef<HTMLInputElement>(null)
  const userSearch = useRef<HTMLInputElement>(null)

  // the lead the users answer names, whether or not a removal of the lead
  // is on its way, for the kept rows' cleanup
  const leadId = firstUsers?.state === 'ready' ? (firstUsers.lead?.id ?? null) : null
  // a kept row goes once a loaded batch holds it, or tells that it does
  // not, or, for a person, once the users answer names them as the lead,
  // as after the Lead field made them lead, so they do not show twice
  useEffect(() => {
    setKept((all) => {
      const left = all.filter((k) =>
        k.kind === 'team'
          ? !teams.list.rows.some((r) => r.id === k.id) &&
            !listPassed(teams.list, teams.search.settled, k.name, k.id)
          : k.id !== leadId &&
            !users.list.rows.some((r) => r.id === k.id) &&
            !listPassed(users.list, users.search.settled, k.name, k.id),
      )
      return left.length === all.length ? all : left
    })
  })

  const writable = current && !adding
  const change = (kind: Kind, id: string, level: AccessLevel, shown: GrantLevel | null) => {
    const key = `${kind}:${id}`
    setPending((m) => new Map(m).set(key, level))
    void onLevel(kind, id, level, shown).then(() =>
      setPending((m) => {
        const next = new Map(m)
        next.delete(key)
        return next
      }),
    )
  }

  // the roles the chosen target may be given
  const leadOk = !!target && target.type === 'user' && target.can_lead && canChangeLead
  const roles: AccessLevel[] = target
    ? [...(leadOk ? (['lead'] as const) : []), ...target.levels]
    : ['user', 'viewer']
  const chosenRole: AccessLevel = roles.includes(role)
    ? role
    : roles.includes('user')
      ? 'user'
      : 'viewer'
  const canPick = (canManageTeams || canManageUsers) && current
  const canAdd = !!target && writable && (target.type === 'team' ? canManageTeams : canManageUsers)
  const add = () => {
    if (!target || !canAdd) return
    const chosen = target
    setAdding(true)
    void onLevel(chosen.type, chosen.id, chosenRole, null).then((saved) => {
      setAdding(false)
      if (!saved) return
      setTarget((t) => (t?.id === chosen.id && t.type === chosen.type ? null : t))
      if (chosenRole !== 'lead')
        setKept((all) => [
          { kind: chosen.type, id: chosen.id, name: chosen.name, level: chosenRole },
          ...all.filter((k) => !(k.kind === chosen.type && k.id === chosen.id)),
        ])
    })
  }

  const teamRow = (row: TeamRow) => {
    const busy = pending.get(`team:${row.id}`)
    const check = checking('team', row.id)
    return (
      <div
        key={row.id}
        data-project-access-team={row.id}
        className="flex items-center gap-2 rounded-md border border-border bg-surface-1 p-2"
      >
        <span className="min-w-0 flex-1 truncate text-base font-medium">{row.name}</span>
        <NativeSelect
          data-project-team-role={row.id}
          aria-label={`Project role for ${row.name}`}
          aria-busy={busy !== undefined || undefined}
          disabled={!canManageTeams || !writable || busy !== undefined}
          value={busy ?? row.level}
          onChange={(event) => change('team', row.id, event.target.value as GrantLevel, row.level)}
          className="h-control-sm w-28 shrink-0 bg-surface-1 text-sm font-sans"
        >
          <option value="user">User</option>
          <option value="viewer">Viewer</option>
        </NativeSelect>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-control-sm w-control-sm shrink-0"
          data-project-access-remove
          aria-label={`Remove ${row.name} team access`}
          aria-busy={check || undefined}
          title={check ? REMOVAL_CHECKING : `Remove ${row.name} team access`}
          disabled={!canManageTeams || !writable || check || busy !== undefined}
          onClick={() => onRemove('team', row.id)}
        >
          <Icon name="close" size={16} />
        </Button>
      </div>
    )
  }

  const chips = (person: Pick<UserRow, 'org_role' | 'pending'>) => (
    <>
      {person.org_role === 'guest' && (
        <span data-guest-chip className="ml-1.5 text-xs font-bold text-text-2">
          guest
        </span>
      )}
      {person.org_role === 'viewer' && (
        <span data-viewer-chip className="ml-1.5 text-xs font-bold text-text-2">
          viewer
        </span>
      )}
      {person.pending && !DEMO_MODE && (
        <span data-invited-chip className="ml-1.5 text-xs font-bold text-[var(--warn)]">
          invited
        </span>
      )}
    </>
  )

  const leadRow = (row: LeadRow) => (
    <div
      key={`lead:${row.id}`}
      data-project-access-user={row.id}
      data-project-access-lead=""
      className="flex items-center gap-2 rounded-md border border-border bg-surface-1 p-2"
    >
      <Avatar id={row.id} size={28} />
      <span className="min-w-0 flex-1 truncate text-base font-medium">
        {row.inherited ? `${row.name} (from the project)` : row.name}
        {chips(row)}
      </span>
      <NativeSelect
        data-project-role={row.id}
        aria-label={`Project role for ${row.name}`}
        disabled
        value="lead"
        onChange={() => {}}
        className="h-control-sm w-28 shrink-0 bg-surface-1 text-sm font-sans"
        title="Choose another lead to transfer project control"
      >
        <option value="lead">Lead</option>
      </NativeSelect>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-control-sm w-control-sm shrink-0"
        data-project-access-remove
        aria-label={`Remove ${row.name} direct access`}
        title="Choose another lead to transfer project control"
        disabled
      >
        <Icon name="close" size={16} />
      </Button>
    </div>
  )

  const userRow = (row: UserRow) => {
    const busy = pending.get(`user:${row.id}`)
    const check = checking('user', row.id)
    const off = !canManageUsers || !writable || busy !== undefined
    return (
      <div
        key={row.id}
        data-project-access-user={row.id}
        className="flex items-center gap-2 rounded-md border border-border bg-surface-1 p-2"
      >
        <Avatar id={row.id} size={28} />
        <span className="min-w-0 flex-1 truncate text-base font-medium">
          {row.name}
          {chips(row)}
        </span>
        <NativeSelect
          data-project-role={row.id}
          aria-label={`Project role for ${row.name}`}
          aria-busy={busy !== undefined || undefined}
          disabled={off}
          value={busy ?? row.level}
          onChange={(event) => change('user', row.id, event.target.value as AccessLevel, row.level)}
          className="h-control-sm w-28 shrink-0 bg-surface-1 text-sm font-sans"
          title={
            row.org_role === 'viewer'
              ? 'Organization viewers have read-only access'
              : 'Direct role; team access still applies'
          }
        >
          {row.can_lead && canChangeLead && <option value="lead">Lead</option>}
          {row.levels.map((level) => (
            <option key={level} value={level}>
              {LEVEL_NAMES[level]}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-control-sm w-control-sm shrink-0"
          data-project-access-remove
          aria-label={`Remove ${row.name} direct access`}
          aria-busy={check || undefined}
          title={check ? REMOVAL_CHECKING : `Remove ${row.name} direct access`}
          disabled={off || check}
          onClick={() => onRemove('user', row.id)}
        >
          <Icon name="close" size={16} />
        </Button>
      </div>
    )
  }

  const keptRow = (k: Kept) => (
    <div
      key={`kept:${k.kind}:${k.id}`}
      data-project-access-kept={k.id}
      data-project-access-kept-type={k.kind}
      className="flex items-center gap-2 rounded-md border border-border bg-surface-1 p-2"
    >
      {k.kind === 'user' && <Avatar id={k.id} size={28} />}
      <span className="min-w-0 flex-1 truncate text-base font-medium">{k.name}</span>
      <span className="shrink-0 text-sm text-text-2">{LEVEL_NAMES[k.level]} · Added</span>
    </div>
  )

  /* The rows of `list` in batch order with each batch's note, after the
     kept rows and `first`, leaving out the rows whose removal is on its
     way. */
  function items<A, Row extends { id: string; name: string }>(
    kind: Kind,
    list: PagedList<A, Row>,
    row: (row: Row) => ReactNode,
    first: ReactNode[] = [],
  ) {
    const out: ReactNode[] = [...kept.filter((k) => k.kind === kind).map(keptRow), ...first]
    list.batches.forEach((batch, i) => {
      for (const r of batch.rows) if (!removing(kind, r.id)) out.push(row(r))
      const last = i === list.batches.length - 1
      if (batch.note === 'stuck' || (batch.note === 'failed' && !last))
        out.push(
          <BatchNote
            key={`note:${batch.id}`}
            kind={kind}
            note={batch.note}
            retrying={batch.retrying}
            onRetry={() => list.retry(batch.id)}
          />,
        )
    })
    return out
  }

  const roleSelect = (kind: Kind) => (id: string) =>
    document.querySelector<HTMLElement>(
      kind === 'team' ? `[data-project-team-role="${id}"]` : `[data-project-role="${id}"]`,
    )
  const moreTeams = useMore(teams.list, teams.end, roleSelect('team'), teamSearch)
  const moreUsers = useMore(users.list, users.end, roleSelect('user'), userSearch)

  const section = <A extends { state: string }, Row extends { id: string; name: string }>(
    kind: Kind,
    of: {
      text: string
      setText: (text: string) => void
      search: { settled: string }
      list: PagedList<A, Row>
      end: ListEnd | 'too_long'
    },
    rows: ReactNode[],
    more: () => void,
    search: React.RefObject<HTMLInputElement | null>,
    matched = false,
  ) => {
    const state = stateOf(of.list)
    return (
      <>
        <ListSearch kind={kind} text={of.text} onText={of.setText} inputRef={search} />
        <div
          data-project-access-list={kind}
          data-project-access-state={state}
          aria-busy={state === 'loading' || state === 'refreshing' || undefined}
          className="space-y-1.5"
        >
          {rows}
          <AccessEndLine
            kind={kind}
            end={of.end}
            held={of.list.phase === 'held' ? of.list.answers[0]?.state : undefined}
            shown={rows.length > 0}
            matched={matched}
            stopped={of.list.stopped}
            first={of.list.batches.length <= 1}
            loading={of.list.phase === 'more'}
            searching={of.search.settled !== ''}
            onMore={more}
            onRetry={() => of.list.retry()}
          />
        </div>
      </>
    )
  }

  return (
    <div data-project-access>
      <SettingsGroup legend="Teams" data-project-access-teams="">
        {section('team', teams, items('team', teams.list, teamRow), moreTeams, teamSearch)}
      </SettingsGroup>

      <SettingsGroup legend="Users" data-project-access-users="">
        {section(
          'user',
          users,
          items('user', users.list, userRow, lead ? [leadRow(lead)] : []),
          moreUsers,
          userSearch,
          lead !== null,
        )}
      </SettingsGroup>

      {/* the creation controls stand a group's distance below the lists */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <AddPicker
          project={project}
          canManageTeams={canManageTeams}
          target={target}
          disabled={!canPick || adding}
          onPick={(picked) => {
            setTarget(picked)
            if (picked.type === 'user' && !picked.levels.includes('user')) onRoleChange('viewer')
            else if (picked.type === 'team' && role === 'lead') onRoleChange('user')
          }}
        />
        <NativeSelect
          data-project-access-new-role
          aria-label="New project access role"
          disabled={!canPick || adding}
          value={chosenRole}
          onChange={(event) => onRoleChange(event.target.value as AccessLevel)}
          className="h-control w-28 bg-surface-1 text-base font-sans"
        >
          {roles.map((level) => (
            <option key={level} value={level}>
              {LEVEL_NAMES[level]}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="button"
          data-add-project-user
          data-add-project-access
          aria-busy={adding || undefined}
          disabled={!canAdd}
          onClick={add}
        >
          + Add
        </Button>
      </div>
      {!canManageUsers && (
        <p className="mt-2 text-sm text-text-2">Project access is read-only for your role.</p>
      )}
      {!canManageTeams && canManageUsers && (
        <p className="mt-2 text-sm text-text-2">Your role cannot change team access.</p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- pickers */

/* The Add team or user picker: a button naming the chosen team or person
   that opens the server's choices, read once a batch while it is open. */
function AddPicker({
  project,
  canManageTeams,
  target,
  disabled,
  onPick,
}: {
  project: ShownProject
  canManageTeams: boolean
  target: AccessTarget | null
  disabled: boolean
  onPick: (target: AccessTarget) => void
}) {
  const empty = canManageTeams ? 'Add team or user…' : 'Add user…'
  return (
    <Popover
      width={300}
      backLayer
      onEscapeKeyDown={escapeClearsFirst('data-project-access-picker-search')}
      // grows into the row; a phone gives it a row of its own
      // (mobile-settings.css)
      wrapStyle={{ minWidth: 160, flexGrow: 1 }}
      button={(toggle, open) => (
        <Button
          type="button"
          variant="outline"
          data-project-access-picker=""
          data-project-access-target={target ? `${target.type}:${target.id}` : ''}
          data-on={open ? '' : undefined}
          aria-label={`${canManageTeams ? 'Add team or user' : 'Add user'}: ${target ? target.name : 'none chosen'}`}
          disabled={disabled}
          onClick={toggle}
          className="h-control w-full justify-between gap-2 bg-surface-1 px-2.5 text-base font-normal text-text-1"
        >
          <span className="flex min-w-0 items-center gap-2">
            {target?.type === 'user' && <Avatar id={target.id} size={20} />}
            <span className={target ? 'min-w-0 truncate' : 'min-w-0 truncate text-text-2'}>
              {target?.name ?? empty}
            </span>
          </span>
          <Icon name="chevronDown" size={14} color="var(--text-2)" />
        </Button>
      )}
    >
      {(close) => (
        <AccessChoiceList
          project={project}
          target={target}
          onPick={(picked) => close(() => onPick(picked))}
        />
      )}
    </Popover>
  )
}

/* The open Add team or user picker: a search and the server's choices,
   teams first under Teams and then people under Users, with Load more. A
   group says it is empty only once the list has passed into the next group
   or ended, never where a batch stopped or failed. */
function AccessChoiceList({
  project,
  target,
  onPick,
}: {
  project: ShownProject
  target: AccessTarget | null
  onPick: (target: AccessTarget) => void
}) {
  const [text, setText] = useState('')
  const { tooLong, settled: query } = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: `${project.org_id}|${project.id}|${query}`,
    source: {
      kind: 'once',
      read: (at) =>
        P.accessChoices({ org_id: project.org_id, project_id: project.id }, query, at.after),
    },
    batch: (answer: AccessChoices) => (answer.state === 'ready' ? answer : null),
    id: (choice: AccessChoice) => `${choice.type}:${choice.id}`,
    most: ACCESS_CAPS.choices,
  })
  const end = listEnd(list, query !== '')
  const teamRows = list.rows.filter((r) => r.type === 'team')
  const people = list.rows.filter((r) => r.type === 'user')
  const ended = end === 'end'
  const noTeams = list.rows.length > 0 && teamRows.length === 0 && (people.length > 0 || ended)
  const noPeople = list.rows.length > 0 && people.length === 0 && ended
  const legend = (text: string) => (
    <p className="px-2 pt-1.5 pb-0.5 text-xs font-semibold text-text-2">{text}</p>
  )
  const choice = (row: AccessChoice) => (
    <MenuItem
      key={`${row.type}:${row.id}`}
      active={target?.type === row.type && target.id === row.id}
      onClick={() =>
        onPick(
          row.type === 'team'
            ? {
                type: 'team',
                id: row.id,
                name: row.name,
                levels: ['user', 'viewer'],
                can_lead: false,
              }
            : {
                type: 'user',
                id: row.id,
                name: row.name,
                levels: row.levels,
                can_lead: row.can_lead,
              },
        )
      }
      data-project-access-choice={row.id}
      data-project-access-choice-type={row.type}
    >
      {row.type === 'user' && <Avatar id={row.id} size={20} />}
      <span className="min-w-0 truncate">{row.name}</span>
      {row.type === 'user' && (row.org_role === 'guest' || row.org_role === 'viewer') && (
        <span className="ml-auto text-xs text-text-2">{row.org_role}</span>
      )}
      {row.type === 'user' && row.kind === 'agent' && (
        <span className="ml-auto text-xs text-text-2">agent</span>
      )}
    </MenuItem>
  )
  return (
    <div data-project-access-choices="" className="flex flex-col gap-1">
      <PickerSearch
        text={text}
        onText={setText}
        label="Search teams and people"
        probe="data-project-access-picker-search"
      />
      <div className="max-h-[300px] overflow-y-auto">
        {(teamRows.length > 0 || noTeams) && legend('Teams')}
        {teamRows.map(choice)}
        {noTeams && (
          <p data-picker-group-none="team" className="px-2 py-1 text-sm text-text-2">
            {query ? 'No teams match.' : 'No teams to add.'}
          </p>
        )}
        {(people.length > 0 || noPeople) && legend('Users')}
        {people.map(choice)}
        {noPeople && (
          <p data-picker-group-none="user" className="px-2 py-1 text-sm text-text-2">
            {query ? 'No one matches.' : 'No one to add.'}
          </p>
        )}
        <ChoiceEnd end={end} tooLong={tooLong} list={list} words={ACCESS_WORDS} />
      </div>
    </div>
  )
}

/** Who a lead picker reads for (projectSettings.leadCandidates): the Lead
    field of project `project_id`, the lead of a new sub-project under
    `parent_id`, or with neither the lead of a new top-level project, each
    in organization `org_id`. */
export type LeadPickerFor = { org_id: string; project_id?: string; parent_id?: string }

/**
 * A Lead field: a button naming the lead that opens the people a lead
 * write accepts (projectSettings.leadCandidates), read once a batch while
 * it is open, with a search and Load more. `lead` is the person the
 * button names, and with no lead it names `emptyLabel`, else "No lead".
 * `busy` says a pick is on its way, and `onPick` hears the person picked.
 * While `disabled` or `busy`, an open list keeps reading but its choices
 * are off, so a pick made as the page's writes turn off sends nothing.
 */
export function LeadPicker({
  on,
  lead,
  emptyLabel,
  disabled,
  busy,
  onPick,
}: {
  on: LeadPickerFor
  lead: { id: string; name: string } | null
  emptyLabel?: string
  disabled: boolean
  busy: boolean
  onPick: (person: { id: string; name: string }) => void
}) {
  const label = lead?.name ?? emptyLabel ?? 'No lead'
  const off = disabled || busy
  return (
    <Popover
      width={280}
      backLayer
      onEscapeKeyDown={escapeClearsFirst('data-lead-picker-search')}
      wrapStyle={{ minWidth: 0 }}
      button={(toggle, open) => (
        <Button
          type="button"
          variant="outline"
          data-project-lead-picker={lead?.id ?? ''}
          data-on={open ? '' : undefined}
          aria-label={`Lead: ${label}`}
          aria-busy={busy || undefined}
          disabled={off}
          onClick={toggle}
          className="h-control w-full max-w-full justify-between gap-2 bg-surface-1 px-2.5 text-base font-normal text-text-1"
        >
          <span className="flex min-w-0 items-center gap-2">
            {lead && <Avatar id={lead.id} size={20} />}
            <span className="min-w-0 truncate">{label}</span>
          </span>
          <Icon name="chevronDown" size={14} color="var(--text-2)" />
        </Button>
      )}
    >
      {(close) => (
        <LeadChoiceList
          on={on}
          lead={lead}
          off={off}
          onPick={(person) => {
            if (!off) close(() => onPick(person))
          }}
        />
      )}
    </Popover>
  )
}

/* The open lead picker: a search and the server's people with Load more,
   whose choices are off while `off`. */
function LeadChoiceList({
  on,
  lead,
  off,
  onPick,
}: {
  on: LeadPickerFor
  lead: { id: string } | null
  off: boolean
  onPick: (person: { id: string; name: string }) => void
}) {
  const [text, setText] = useState('')
  const { tooLong, settled: query } = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: `${JSON.stringify(on)}|${query}`,
    source: { kind: 'once', read: (at) => P.leadChoices(on, query, at.after) },
    batch: (answer: LeadChoices) => (answer.state === 'ready' ? answer : null),
    id: (person: LeadChoice) => person.id,
    most: ACCESS_CAPS.choices,
  })
  const end = listEnd(list, query !== '')
  return (
    <div data-lead-choices="" className="flex flex-col gap-1">
      <PickerSearch
        text={text}
        onText={setText}
        label="Search people"
        probe="data-lead-picker-search"
      />
      <div className="max-h-[280px] overflow-y-auto">
        {list.rows.map((person) => (
          <MenuItem
            key={person.id}
            active={lead?.id === person.id}
            disabled={off}
            onClick={() => onPick({ id: person.id, name: person.name })}
            data-lead-choice={person.id}
          >
            <Avatar id={person.id} size={20} />
            <span className="min-w-0 truncate">{person.name}</span>
            {person.kind === 'agent' && <span className="ml-auto text-xs text-text-2">agent</span>}
            {person.org_role === 'guest' && (
              <span className="ml-auto text-xs text-text-2">guest</span>
            )}
          </MenuItem>
        ))}
        <ChoiceEnd end={end} tooLong={tooLong} list={list} words={LEAD_WORDS} />
      </div>
    </div>
  )
}
