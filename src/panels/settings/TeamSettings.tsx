/* Settings › Teams and a team's page, for the home organization's admins
   and team leaders.

   Both pages read their rows from the server a batch of 25 at a time in
   name order, with a search over the whole list and Load more, through the
   shared paged list's live source (lib/pagedList.ts): Settings › Teams
   from teams.settingsPage, every team for an admin and the teams a leader
   leads for anyone else, each with its member count from team_counts; a
   team's page from teams.get, its name, count and the caller's rights, and
   teams.members. The Add member picker reads teams.addable once a batch,
   only while it is open. Nothing they read goes into the store, the loaded
   batches stay live while the page shows, stop while the tab is hidden and
   go when the page is left. A count is the server's, never one the browser
   worked out, and a list never claims an end a stopped or failed batch
   did not reach.

   A row paints the store's team, person and membership while the store
   holds them, so this session's writes show at once and give the writes
   their `expected`; until then it shows the answer's, and the controls
   that write through those rows wait. Delete, Remove and Add wait for the
   store's team, as the removal and the add take its organization from it.
   The pages keep, for this visit, the teams created here, the members
   added here and the member rows that hold unsaved hours or an hours save
   the server has not answered, beside the loaded rows in one keyed list,
   so a search never drops typed hours, nor the field a refused save
   brings them back in. */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HoverTooltip } from '@/components/ui/tooltip'
import { api } from '../../../convex/_generated/api'
import { grouped, LIMITS } from '../../../convex/lib/limits'
import { LimitedInput } from '../../components/LimitedField'
import { ChoiceEnd, PickerSearch } from '../../components/pickerParts'
import { escapeClearsFirst, MEMBER_WORDS } from '../../components/pickerWords'
import { Avatar, Icon, MenuItem, Popover } from '../../components/qivo'
import {
  FieldHint,
  PageTitle,
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '../../components/settingsPage'
import { TEAM_CAPS } from '../../lib/accessCaps'
import { DEMO_MODE } from '../../lib/demoMode'
import { limitSentence, overLimit, sentence } from '../../lib/fieldLimits'
import { focusAround, useFocusWhenGone } from '../../lib/focusWhenGone'
import { useUnsaved } from '../../lib/leaveGuard'
import {
  type BatchAt,
  type ListEnd,
  listEnd,
  listPassed,
  type PagedList,
  usePagedList,
  useSettledSearch,
} from '../../lib/pagedList'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { useConfirmArm } from '../../lib/useConfirmArm'
import { useViewVisibility } from '../../lib/viewVisibility'
import {
  P,
  REMOVAL_CHECKING,
  type TeamChoices,
  type TeamListAnswer,
  type TeamMembersAnswer,
} from '../../store/planner'
import { useAccessRemoval } from '../useAccessRemoval'
import { BackLink, TextField } from './controls'
import { PlannableHoursInput } from './UserControls'
import { type TeamSettingsOk, type TeamSettingsRead, useTeamSettings } from './useTeamSettings'

/** A team as Settings › Teams lists it. */
type TeamRowAnswer = Extract<TeamListAnswer, { state: 'ready' }>['rows'][number]
/** A member as a team's page lists them. */
type MemberRowAnswer = Extract<TeamMembersAnswer, { state: 'ready' }>['rows'][number]
/** A person the Add member picker offers. */
type MemberChoice = Extract<TeamChoices, { state: 'ready' }>['rows'][number]

const START: BatchAt = { after: null, through: null }

/** A member a team's page added this visit, with the name it chose them
    by and whether the server added them yet. */
type Added = { name: string; saved: boolean }

/** The arguments of one batch, in a fixed key order with empty fields left
    out, so equal batches share one subscription; `team` for a member
    list. */
const batchArgs = (org: string, team: string | null, search: string, at: BatchAt) => ({
  org_id: org,
  ...(team === null ? {} : { team_id: team }),
  ...(search === '' ? {} : { search }),
  ...(at.after === null ? {} : { after: at.after }),
  ...(at.through === null ? {} : { through: at.through }),
})

/** The home organization's team `id` in the store, while it holds it. */
const storeTeam = (id: string) => {
  const team = P.teamById(id)
  return team && team.org === P.homeOrg ? team : null
}

/** The home organization's person `id` in the store, while it holds them. */
const storePerson = (id: string) => {
  const user = P.user(id)
  return user && user.org === P.homeOrg ? user : null
}

/** The title of a control that waits for the store's team. */
const WAITING = 'Loading this team…'

/** "12 members", "1 member", or "Not counted yet" for a count the server
    does not have. */
const membersLine = (count: number | null) =>
  count === null ? 'Not counted yet' : `${grouped(count)} member${count === 1 ? '' : 's'}`

const noteClass = '[font-size:var(--fs-sm)] [color:var(--text-2)] [padding:4px_2px]'

/** The ready answer of `list` read last, for fields beside the rows. */
function lastReady<A extends { state: string }>(list: PagedList<A, unknown>) {
  for (let i = list.answers.length - 1; i >= 0; i--) {
    const answer = list.answers[i]
    if (answer.state === 'ready') return answer as Extract<A, { state: 'ready' }>
  }
  return null
}

/** Whether the answers `list` holds are current, as Settings › Projects
    asks (ProjectLists.tsx). The page shows, and showed at the last render
    too, since the list hears that it shows only after a render, and the
    list is not refreshing. A hidden page keeps its last answers, which can
    be from before a write, so a kept row asks this before listPassed. */
function useListCurrent(list: Pick<PagedList<unknown, unknown>, 'refreshing'>) {
  const { visible } = useViewVisibility()
  const showed = useRef(visible)
  useEffect(() => {
    showed.current = visible
  })
  return visible && showed.current && !list.refreshing
}

/** The state a list shows on its container: loading, failed, refreshing
    or ok. */
function listState(list: PagedList<unknown, unknown>) {
  if (list.phase === 'first') return 'loading'
  if (list.phase === 'failed' || list.batches.some((b) => b.note === 'failed')) return 'failed'
  return list.refreshing ? 'refreshing' : 'ok'
}

/* ------------------------------------------------------- the end lines */

/** What one of the two lists says at its end and beside its batches. */
type ListWords = {
  /** the data attribute of the end line and of a batch's note */
  probe: string
  loading: string
  notReady: string
  failed: string
  failedMore: string
  full: string
  none: string
  /** a batch that failed above the last */
  batchFailed: string
}

const TEAM_WORDS: ListWords = {
  probe: 'data-teams',
  loading: 'Loading teams…',
  notReady: 'The team list is not ready yet. Try again in a few minutes.',
  failed: "Couldn't load teams.",
  failedMore: "Couldn't load more teams.",
  full: 'Search to find more teams.',
  none: 'No teams match.',
  batchFailed: "Couldn't load these teams.",
}

const MEMBER_LIST_WORDS: ListWords = {
  probe: 'data-team-members',
  loading: 'Loading members…',
  notReady: 'The member list is not ready yet. Try again in a few minutes.',
  failed: "Couldn't load members.",
  failedMore: "Couldn't load more members.",
  full: 'Search to find more members.',
  none: 'No members match.',
  batchFailed: "Couldn't load these members.",
}

/* What a batch says in place, after its rows, with Retry: a read that
   stopped without checking anything, wherever it is, and one that failed
   above the last, since the end line gives the last one's failure. */
function BatchNote({
  words,
  note,
  retrying,
  onRetry,
}: {
  words: ListWords
  note: 'failed' | 'stuck'
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <div
      role="alert"
      {...{ [`${words.probe}-batch-note`]: note }}
      className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-text-2"
    >
      {note === 'failed' ? words.batchFailed : 'Qivo could not check part of the list.'}
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

/* The line that ends a list (lib/pagedList.ts listEnd), with its Load more
   and Retry, as Settings › Labels ends its own. The failure's Retry is the
   same button as Load more in the same place, so focus stays on it when a
   Load more fails. `held` is the line for a first answer with no rows, and
   `empty` the one for the list's real end with nothing shown and no
   search, if any. */
function EndLine({
  words,
  end,
  held,
  empty,
  stopped,
  none,
  first,
  loading,
  onMore,
  onRetry,
}: {
  words: ListWords
  end: ListEnd | 'too_long'
  held: string
  empty: ReactNode
  stopped: boolean
  /** whether no loaded batch holds a row */
  none: boolean
  /** whether the list holds its first batch at most */
  first: boolean
  loading: boolean
  onMore: () => void
  onRetry: () => void
}) {
  const probe = { [`${words.probe}-end`]: end }
  const line = (text: string, status = false) => (
    <p {...probe} role={status ? 'status' : undefined} className={noteClass}>
      {text}
    </p>
  )
  switch (end) {
    case 'too_long':
      return line(limitSentence(LIMITS.search))
    case 'loading':
      return line(words.loading, true)
    case 'held':
      return line(held)
    case 'failed':
      return (
        <div
          role="alert"
          {...probe}
          className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-danger"
        >
          {none || first ? words.failed : words.failedMore}
          <Button type="button" variant="ghost" className="h-control-sm text-sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )
    case 'full':
      return line(words.full)
    case 'more':
      return (
        <div {...probe} className="flex flex-col items-start gap-1">
          {stopped && (
            <p className={noteClass}>
              {none
                ? 'Qivo checked part of the list and found no matches there. Load more continues.'
                : 'Qivo checked part of the list. Load more continues.'}
            </p>
          )}
          <Button
            type="button"
            variant="ghost"
            {...{ [`${words.probe}-more`]: '' }}
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
      return line(words.none)
    case 'end':
      return empty
  }
}

/** The line for a list's first answer with no rows: not ready, or the
    server's sentence for a refusal, or a team that is gone. */
function heldText(words: ListWords, held: { state: string; message?: string } | undefined) {
  if (held?.state === 'refused' && held.message) return sentence(held.message)
  if (held?.state === 'unavailable') return 'This team is no longer available.'
  return words.notReady
}

/**
 * Load more that keeps focus on the button while it reads, and once Load
 * more goes moves it to the first new row's `control`, else to `rest()`,
 * as Settings › Labels does. Answers the end line and the press.
 */
function useListMore<A, Row extends { id: string }>(
  list: PagedList<A, Row>,
  searching: boolean,
  tooLong: boolean,
  control: (id: string) => HTMLElement | null,
  rest: () => HTMLElement | null,
) {
  const from = useRef<number | null>(null)
  const end: ListEnd | 'too_long' = tooLong ? 'too_long' : listEnd(list, searching)
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = from.current === null ? undefined : list.rows[from.current]
    return (row ? control(row.id) : null) ?? rest()
  })
  const more = () => {
    if (list.phase === 'more') return
    from.current = list.rows.length
    list.more()
  }
  return { end, more }
}

/** `set` with `id` in it or not. */
function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (set.has(id) === on) return set
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

/** `map` without the ids `gone` answers true for, the same map when it
    drops none. */
function without<V>(
  map: ReadonlyMap<string, V>,
  gone: (id: string, value: V) => boolean,
): ReadonlyMap<string, V> {
  const left = [...map].filter(([id, value]) => !gone(id, value))
  return left.length === map.size ? map : new Map(left)
}

/* ------------------------------------------------------ a team's page */

/**
 * A team's Settings page. It reads the team, its count and the caller's
 * rights from the server (useTeamSettings), whether or not the store holds
 * the team, and shows nothing of the team until that answer comes. It
 * takes Settings' read when Settings passes one and watches its own only
 * when rendered on its own, so Settings' check and the page follow one
 * read.
 */
export function TeamPage({
  teamId,
  read: given,
  setPage,
  onBackPage = setPage,
}: {
  teamId: string
  /** the read of the team that Settings holds for this page */
  read?: TeamSettingsRead
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
}) {
  const own = useTeamSettings(given ? null : teamId)
  const read = given ?? own
  const answer = read.answer
  return (
    <div
      data-team-settings-state={read.state}
      aria-busy={read.state === 'loading' || read.state === 'refreshing' || undefined}
      className="contents"
    >
      <BackLink to="Teams" onClick={() => onBackPage('org-teams')} />
      <PageTitle>{answer ? storeTeam(teamId)?.name || answer.team.name : 'Team'}</PageTitle>
      {answer ? (
        <TeamFields teamId={teamId} answer={answer} read={read} />
      ) : read.state === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-base text-text-2">
          Couldn't load this team.
          <Button type="button" size="sm" onClick={read.retry}>
            Try again
          </Button>
        </div>
      ) : (
        <p role="status" className="text-base text-text-2">
          {read.state === 'unavailable' ? 'This team is no longer available.' : 'Loading the team…'}
        </p>
      )}
    </div>
  )
}

/* A team's sections from the server's answer. After a failure, Try
   again's wait included, and for a team that has gone, the controls that
   write are off and a typed name stays; the hours keep their draft, since
   the server checks every save and a draft must never go. */
function TeamFields({
  teamId,
  answer,
  read,
}: {
  teamId: string
  answer: TeamSettingsOk
  read: TeamSettingsRead
}) {
  const org = P.homeOrg
  const team = storeTeam(teamId)
  const teamHeld = team !== null
  const name = team?.name ?? answer.team.name
  const blocked = read.afterFailure || read.state === 'unavailable'
  const canManage = answer.can_manage
  const canManageMembers = answer.can_manage_members
  const confirm = useConfirmArm<string>()
  /* Removing a member asks the server which open tasks they would lose
     sight of, and when some, whether to keep them as Viewers or reassign
     their tasks (useAccessRemoval). Focus then goes where the press says,
     taken as it starts, because the removal hides the member's row before
     the server accepts it: the next member's Remove, the previous one's,
     the empty list's line or the member picker. */
  const removal = useAccessRemoval()
  const removing = (id: string) => P.removingAccess({ kind: 'teamMember', teamId, userId: id })

  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: JSON.stringify(batchArgs(org, teamId, search.settled, START)),
    source: {
      kind: 'live',
      query: api.teams.members,
      args: (at) => batchArgs(org, teamId, search.settled, at),
    },
    batch: (a: TeamMembersAnswer) => (a.state === 'ready' ? a : null),
    id: (row: MemberRowAnswer) => row.id,
    most: TEAM_CAPS.members,
  })
  const loaded = new Map(list.rows.map((row) => [row.id, row]))
  // the members this visit added, by id with their names and whether the
  // server added them yet, and the rows holding unsaved hours or an hours
  // save on its way (PlannableHoursInput)
  const [added, setAdded] = useState<ReadonlyMap<string, Added>>(() => new Map())
  const [drafts, setDrafts] = useState<ReadonlySet<string>>(() => new Set())
  const onUnsaved = useCallback((id: string, unsaved: boolean) => {
    setDrafts((s) => (unsaved === s.has(id) ? s : toggled(s, id, unsaved)))
  }, [])
  const current = useListCurrent(list)
  // an added member goes from the kept rows once a loaded batch holds them,
  // or the store holds no such membership, as after a refusal. Until the
  // server added them every answer is from before the add, so only once it
  // did, and the answers are current, may the list tell that it does not
  // hold them, as when someone removed them meanwhile.
  useEffect(() => {
    setAdded((m) =>
      without(m, (id, entry) => {
        const person = storePerson(id)
        return (
          loaded.has(id) ||
          !person?.teams.includes(teamId) ||
          (entry.saved &&
            current &&
            listPassed(list, search.settled, person.name || entry.name, id))
        )
      }),
    )
  })
  const kept = [...new Set([...added.keys(), ...drafts])].filter(
    (id) => !loaded.has(id) && !removing(id) && storePerson(id) !== null,
  )

  const searchBox = useRef<HTMLInputElement>(null)
  const { end, more } = useListMore(
    list,
    search.settled !== '',
    search.tooLong,
    (id) =>
      document.querySelector<HTMLElement>(
        `[data-settings-team-member="${id}"] [data-plannable-for], [data-settings-team-member="${id}"] [data-team-member-remove]`,
      ),
    () => searchBox.current,
  )

  const row = (id: string, member: MemberRowAnswer | null, note: string | null) => (
    <MemberRow
      key={id}
      teamId={teamId}
      id={id}
      answer={member}
      note={note}
      canManage={canManage}
      canManageMembers={canManageMembers}
      teamHeld={teamHeld}
      blocked={blocked}
      armed={confirm.armed === `m:${id}`}
      checking={removal.checking({ kind: 'teamMember', teamId, userId: id })}
      onRemove={(at) =>
        confirm.press(`m:${id}`, () =>
          removal.press({ kind: 'teamMember', teamId, userId: id }, at),
        )
      }
      onUnsaved={onUnsaved}
    />
  )
  const items: ReactNode[] = kept.map((id) =>
    row(id, null, added.has(id) ? 'Added' : 'Not in this list'),
  )
  list.batches.forEach((batch, i) => {
    for (const member of batch.rows)
      if (!removing(member.id)) items.push(row(member.id, member, null))
    const last = i === list.batches.length - 1
    if (batch.note === 'stuck' || (batch.note === 'failed' && !last))
      items.push(
        <BatchNote
          key={`note:${batch.id}`}
          words={MEMBER_LIST_WORDS}
          note={batch.note}
          retrying={batch.retrying}
          onRetry={() => list.retry(batch.id)}
        />,
      )
  })
  const shown = list.rows.some((r) => !removing(r.id)) || kept.length > 0
  const state = listState(list)
  const addMember = (person: { id: string; name: string }) => {
    setAdded((m) => new Map(m).set(person.id, { name: person.name, saved: false }))
    void P.addTeamMember(teamId, person.id).then((saved) => {
      // a refusal, or an add the store did not send, leaves no membership
      // in the store, which drops the row. A second add of someone whose
      // first add waits answers false at once and keeps the row.
      setAdded((m) => {
        const entry = m.get(person.id)
        return entry && saved ? new Map(m).set(person.id, { ...entry, saved: true }) : m
      })
    })
  }

  return (
    <>
      <SettingsSection
        title="Team"
        description={
          canManage ? undefined : 'Only team leaders and organization admins can edit this team.'
        }
      >
        {canManage && teamHeld ? (
          <TextField
            label="Team name"
            record={teamId}
            value={name}
            limit={LIMITS.teamName}
            readOnly={blocked}
            onCommit={(v, save) => {
              // the toast waits for the server, so a refusal never reads as done
              void P.updateTeam(teamId, { name: v }, save.as('name')).then((saved) => {
                if (saved) window.showToast?.('Team renamed')
              })
            }}
          />
        ) : (
          <SettingsField label="Team name">
            <Input
              value={name}
              disabled
              title={canManage ? WAITING : undefined}
              aria-label="Team name"
              className="h-control bg-surface-1 px-2.5 text-base font-sans opacity-55"
            />
          </SettingsField>
        )}
      </SettingsSection>

      <SettingsSection
        title="Members"
        description={<span data-team-member-count="">{membersLine(answer.member_count)}</span>}
      >
        {read.afterFailure && read.state !== 'unavailable' && (
          <div role="alert" data-team-settings-failed="" className={`${noteClass} mb-1`}>
            Couldn't refresh this team. Its name, members and leaders wait until it loads again.
            Hours still save.{' '}
            <Button
              type="button"
              variant="ghost"
              className="h-control-sm text-sm"
              onClick={read.retry}
            >
              Try again
            </Button>
          </div>
        )}
        <LimitedInput
          ref={searchBox}
          limit={LIMITS.search}
          aria-label="Search members"
          data-team-members-search=""
          placeholder="Search members"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Escape clears a typed search first
            if (e.key === 'Escape' && text) {
              e.stopPropagation()
              setText('')
            }
          }}
          wrapperClassName="mb-2"
          className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
        />
        <div
          data-team-members=""
          data-team-members-state={state}
          data-team-waiting={teamHeld ? undefined : ''}
          aria-busy={state === 'loading' || state === 'refreshing' || undefined}
          className="[display:flex] [flex-direction:column] [gap:6px]"
        >
          {items}
          <EndLine
            words={MEMBER_LIST_WORDS}
            end={end}
            held={heldText(MEMBER_LIST_WORDS, list.answers[0])}
            empty={
              shown || search.settled !== '' ? null : (
                <div
                  data-team-members-none=""
                  tabIndex={-1}
                  className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]"
                >
                  No members yet.
                </div>
              )
            }
            stopped={list.stopped}
            none={list.rows.length === 0}
            first={list.batches.length <= 1}
            loading={list.phase === 'more'}
            onMore={more}
            onRetry={() => list.retry()}
          />
        </div>
        {removal.window}
        {canManageMembers && (
          <AddMember
            org={org}
            teamId={teamId}
            disabled={!teamHeld || blocked}
            waiting={teamHeld ? undefined : WAITING}
            onAdd={addMember}
          />
        )}
        <FieldHint>
          Removing a member leaves their other team and individual project access intact.
        </FieldHint>
      </SettingsSection>
    </>
  )
}

/* One member of a team's page. It paints the store's person and membership
   while the store holds them, else the answer's; the Leader box waits for
   the store's membership and team, the hours for the store's person, and
   Remove for the store's team. A kept row says why it shows (`note`). The
   avatar comes first and the name block second, which the phone layout
   stacks (mobile-settings.css). */
function MemberRow({
  teamId,
  id,
  answer,
  note,
  canManage,
  canManageMembers,
  teamHeld,
  blocked,
  armed,
  checking,
  onRemove,
  onUnsaved,
}: {
  teamId: string
  id: string
  /** the answer's row, null for a kept row no loaded batch holds */
  answer: MemberRowAnswer | null
  note: string | null
  canManage: boolean
  canManageMembers: boolean
  teamHeld: boolean
  blocked: boolean
  armed: boolean
  checking: boolean
  /** presses Remove, with where focus goes once the row has left */
  onRemove: (focusAfter: () => HTMLElement | null) => void
  onUnsaved: (id: string, unsaved: boolean) => void
}) {
  const user = storePerson(id)
  const name = user?.name ?? answer?.name ?? ''
  const role = user?.orgRole ?? answer?.org_role
  const isAgent = user ? user.isAgent : answer?.kind === 'agent'
  const memberHeld = !!user && user.teams.includes(teamId)
  const isLeader = memberHeld ? user.teamLeads.includes(teamId) : (answer?.is_leader ?? false)
  // Viewers and agents never lead; an old agent leader row can still be cleared.
  const leaderLocked = role === 'viewer' || (isAgent && !isLeader)
  const leaderReady = memberHeld && teamHeld
  const leaderOn = canManageMembers && leaderReady && !blocked && !leaderLocked
  return (
    <div
      data-settings-team-member={id}
      data-team-member-waiting={user ? undefined : ''}
      className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
    >
      <Avatar id={id} size={28} />
      <div className="[flex:1] [min-width:0]">
        <span className="[font-size:var(--fs-base)] [font-weight:500]">{name}</span>
        {role === 'admin' && (
          <span className="[font-size:var(--fs-xs)] [color:var(--text-2)]">, org admin</span>
        )}
        {role === 'viewer' && (
          <span data-viewer-chip className="[font-size:var(--fs-xs)] [color:var(--text-2)]">
            , read-only
          </span>
        )}
        {note && (
          <span
            data-team-member-kept=""
            className="[margin-left:8px] [font-size:var(--fs-xs)] [color:var(--text-2)]"
          >
            {note}
          </span>
        )}
      </div>
      {/* Leaders can edit the personal capacity they plan against. */}
      <PlannableHoursInput
        user={user ?? { id, name, isAgent, plannableHours: answer?.plannable_hours ?? null }}
        canEdit={canManage && user !== null}
        onUnsaved={onUnsaved}
      />
      {/* Team leadership controls this team's roster only. Project
          leads are assigned from each project's access settings. */}
      <HoverTooltip
        content={
          isAgent
            ? 'Agents cannot lead a team.'
            : role === 'viewer'
              ? 'Organization viewers cannot lead a team.'
              : !canManageMembers
                ? 'Only team leaders and organization admins can change leaders.'
                : leaderReady
                  ? 'Manage this team’s members and settings.'
                  : WAITING
        }
      >
        <label
          htmlFor={`team-leader-${teamId}-${id}`}
          data-team-leader-toggle
          style={{ cursor: leaderOn ? 'pointer' : 'default', opacity: leaderOn ? 1 : 0.55 }}
          className="[display:flex] [align-items:center] [gap:6px] [font-size:var(--fs-sm)] [color:var(--text-2)] [flex-shrink:0]"
        >
          <Input
            id={`team-leader-${teamId}-${id}`}
            type="checkbox"
            checked={isLeader}
            disabled={!leaderOn}
            onChange={(e) => P.setTeamLeader(teamId, id, e.target.checked)}
            className="[accent-color:var(--primary)]"
          />
          Leader
        </label>
      </HoverTooltip>
      {canManageMembers && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          style={{ color: armed ? 'var(--danger)' : undefined }}
          className="w-control-sm h-control-sm"
          aria-label={armed ? 'Click again to confirm' : `Remove ${name} from this team`}
          aria-busy={checking || undefined}
          disabled={checking || !teamHeld || blocked}
          title={
            !teamHeld
              ? WAITING
              : checking
                ? REMOVAL_CHECKING
                : armed
                  ? 'Click again to confirm'
                  : `Remove ${name} from this team`
          }
          data-team-member-remove
          onClick={() =>
            onRemove(
              focusAround(
                'data-settings-team-member',
                id,
                (row) => row.querySelector<HTMLElement>('[data-team-member-remove]:not(:disabled)'),
                () =>
                  document.querySelector<HTMLElement>('[data-team-members-none]') ??
                  document.querySelector<HTMLElement>('[data-team-member-picker]'),
              ),
            )
          }
        >
          <Icon name="close" size={16} />
        </Button>
      )}
    </div>
  )
}

/* Add member: a button that opens the people who may join the team, read
   from the server once a batch only while the popover is open, and Add,
   which sends the chosen person. The choice stays, by id and name, through
   searches, batches and the popover closing, until Add sends it. The server
   checks the add again. */
function AddMember({
  org,
  teamId,
  disabled,
  waiting,
  onAdd,
}: {
  org: string
  teamId: string
  disabled: boolean
  waiting: string | undefined
  onAdd: (person: { id: string; name: string }) => void
}) {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null)
  useUpdateBlocker(!!target)
  return (
    <SettingsGroup legend="Add a member">
      <div className="[display:flex] [gap:8px]">
        <Popover
          width={300}
          backLayer
          onEscapeKeyDown={escapeClearsFirst('data-team-member-picker-search')}
          wrapStyle={{ minWidth: 160, flexGrow: 1 }}
          button={(toggle, open) => (
            <Button
              type="button"
              variant="outline"
              data-team-member-picker=""
              data-team-member-target={target?.id ?? ''}
              data-on={open ? '' : undefined}
              aria-label={`Add member: ${target ? target.name : 'none chosen'}`}
              disabled={disabled}
              title={waiting}
              onClick={toggle}
              className="h-control w-full justify-between gap-2 bg-surface-1 px-2.5 text-base font-normal text-text-1"
            >
              <span className="flex min-w-0 items-center gap-2">
                {target && <Avatar id={target.id} size={20} />}
                <span className={target ? 'min-w-0 truncate' : 'min-w-0 truncate text-text-2'}>
                  {target?.name ?? 'Add member…'}
                </span>
              </span>
              <Icon name="chevronDown" size={14} color="var(--text-2)" />
            </Button>
          )}
        >
          {(close) => (
            <MemberChoiceList
              org={org}
              teamId={teamId}
              target={target}
              onPick={(picked) => close(() => setTarget(picked))}
            />
          )}
        </Popover>
        <Button
          type="button"
          data-team-member-add=""
          disabled={!target || disabled}
          title={waiting}
          onClick={() => {
            if (!target) return
            onAdd(target)
            setTarget(null)
          }}
        >
          <Icon name="plus" size={16} />
          Add
        </Button>
      </div>
    </SettingsGroup>
  )
}

/* The open Add member picker: a search and the server's people with Load
   more. It says nobody can join only at the list's real end. */
function MemberChoiceList({
  org,
  teamId,
  target,
  onPick,
}: {
  org: string
  teamId: string
  target: { id: string } | null
  onPick: (person: { id: string; name: string }) => void
}) {
  const [text, setText] = useState('')
  const { tooLong, settled: query } = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: `${org}|${teamId}|${query}`,
    source: {
      kind: 'once',
      read: (at) => P.teamMemberChoices({ org_id: org, team_id: teamId }, query, at.after),
    },
    batch: (answer: TeamChoices) => (answer.state === 'ready' ? answer : null),
    id: (person: MemberChoice) => person.id,
    most: TEAM_CAPS.choices,
  })
  const end = listEnd(list, query !== '')
  return (
    <div data-team-member-choices="" className="flex flex-col gap-1">
      <PickerSearch
        text={text}
        onText={setText}
        label="Search people"
        probe="data-team-member-picker-search"
      />
      <div className="max-h-[300px] overflow-y-auto">
        {list.rows.map((person) => {
          const status = !person.active
            ? 'switched off'
            : person.pending && !DEMO_MODE
              ? 'invited'
              : person.kind === 'agent'
                ? 'agent'
                : person.org_role === 'viewer'
                  ? 'viewer'
                  : null
          return (
            <MenuItem
              key={person.id}
              active={target?.id === person.id}
              onClick={() => onPick({ id: person.id, name: person.name })}
              data-team-member-choice={person.id}
            >
              <Avatar id={person.id} size={20} />
              <span className="min-w-0 truncate">{person.name}</span>
              {status && <span className="ml-auto text-xs text-text-2">{status}</span>}
            </MenuItem>
          )
        })}
        <ChoiceEnd end={end} tooLong={tooLong} list={list} words={MEMBER_WORDS} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------ Settings › Teams */

/* Team leaders manage their teams; only organization admins create or
   delete teams. The server lists every team for an admin and the teams a
   leader leads for anyone else; a seat that does neither reads nothing, and
   Settings moves it on. */
export function OrgTeamsPage({ setPage }: { setPage: (page: string) => void }) {
  const admin = P.isAdmin()
  const org = P.homeOrg
  const leads = admin || P.teams.some((t) => t.org === org && P.isTeamLeader(t.id))
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: leads ? JSON.stringify(batchArgs(org, null, search.settled, START)) : null,
    source: {
      kind: 'live',
      query: api.teams.settingsPage,
      args: (at) => batchArgs(org, null, search.settled, at),
    },
    batch: (a: TeamListAnswer) => (a.state === 'ready' ? a : null),
    id: (row: TeamRowAnswer) => row.id,
    most: TEAM_CAPS.teams,
  })
  const removing = (id: string) => P.removingAccess({ kind: 'deleteTeam', teamId: id })
  const loaded = new Map(list.rows.map((row) => [row.id, row]))
  // the teams this visit created, by id with their names, which show above
  // the list until a loaded batch holds them, the store no longer holds
  // them, or the list's current answers tell that they do not. A create
  // answered while the page is hidden finds answers from before it.
  const [made, setMade] = useState<ReadonlyMap<string, string>>(() => new Map())
  const current = useListCurrent(list)
  useEffect(() => {
    setMade((m) =>
      without(m, (id, name) => {
        const team = storeTeam(id)
        return (
          loaded.has(id) ||
          !team ||
          (current && listPassed(list, search.settled, team.name || name, id))
        )
      }),
    )
  })
  const kept = [...made.keys()].filter(
    (id) => !loaded.has(id) && !removing(id) && storeTeam(id) !== null,
  )
  // the teams whose Delete this visit pressed, so a deletion on its way
  // counts though a search hides its team
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set())
  // the organization's teams as the server last counted them, up to three,
  // less the deletions on their way; unknown until a batch answers, which
  // keeps Delete off
  const counted = lastReady(list)?.teams ?? null
  const going = [...new Set([...loaded.keys(), ...made.keys(), ...deleted])].filter(removing).length
  const last = counted === null || counted - going <= 1

  const [teamName, setTeamName] = useState('')
  // a create in flight: Add waits for the server's answer
  const [adding, setAdding] = useState(false)
  useUpdateBlocker(!!teamName)
  useUnsaved(!!teamName.trim(), 'team name')
  const confirm = useConfirmArm<string>()
  /* Deleting a team asks the server which open tasks its members would lose
     sight of, and when some, asks first (useAccessRemoval). Focus then goes
     where the press says, taken as it starts, because the delete hides the
     team's row before the server accepts it: the next team's Delete, or
     its name once it is the last team, whose Delete is disabled, else the
     previous team's. */
  const removal = useAccessRemoval()
  const addTeam = () => {
    const name = teamName.trim()
    if (!name || overLimit(LIMITS.teamName, name) || !admin || adding) return
    // The typed name stays until the server creates the team, and after a
    // refusal, so a paused or refused create can be sent again. The team
    // shows once the server created it.
    setAdding(true)
    const id = crypto.randomUUID()
    void P.addTeam(name, id).then((saved) => {
      setAdding(false)
      if (!saved) return
      setMade((m) => new Map(m).set(id, name))
      window.showToast?.(`Team “${name}” created`)
      setTeamName((typed) => (typed.trim() === name ? '' : typed))
    })
  }

  const searchBox = useRef<HTMLInputElement>(null)
  const { end, more } = useListMore(
    list,
    search.settled !== '',
    search.tooLong,
    (id) => document.querySelector<HTMLElement>(`[data-team-row="${id}"] [data-team-open]`),
    () => searchBox.current,
  )

  const row = (id: string, team: TeamRowAnswer | null, note: string | null) => (
    <TeamRow
      key={id}
      id={id}
      answer={team}
      note={note}
      admin={admin}
      last={last}
      armed={confirm.armed === `t:${id}`}
      checking={removal.checking({ kind: 'deleteTeam', teamId: id })}
      onOpen={() => setPage(`team:${id}`)}
      onDelete={(at) =>
        confirm.press(`t:${id}`, () => {
          setDeleted((s) => toggled(s, id, true))
          removal.press({ kind: 'deleteTeam', teamId: id }, at)
        })
      }
    />
  )
  const items: ReactNode[] = kept.map((id) => row(id, null, 'Added'))
  list.batches.forEach((batch, i) => {
    for (const team of batch.rows) if (!removing(team.id)) items.push(row(team.id, team, null))
    const lastBatch = i === list.batches.length - 1
    if (batch.note === 'stuck' || (batch.note === 'failed' && !lastBatch))
      items.push(
        <BatchNote
          key={`note:${batch.id}`}
          words={TEAM_WORDS}
          note={batch.note}
          retrying={batch.retrying}
          onRetry={() => list.retry(batch.id)}
        />,
      )
  })
  const shown = list.rows.some((r) => !removing(r.id)) || kept.length > 0
  const state = listState(list)

  return (
    <>
      <PageTitle>Teams</PageTitle>
      <SettingsSection
        title="Teams"
        description={
          admin ? undefined : 'Teams you lead. Only organization admins can create or delete teams.'
        }
      >
        {leads ? (
          <>
            <LimitedInput
              ref={searchBox}
              limit={LIMITS.search}
              aria-label="Search teams"
              data-teams-search=""
              placeholder="Search teams"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Escape clears a typed search first
                if (e.key === 'Escape' && text) {
                  e.stopPropagation()
                  setText('')
                }
              }}
              wrapperClassName="mb-2"
              className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
            />
            <div
              data-org-teams=""
              data-teams-state={state}
              aria-busy={state === 'loading' || state === 'refreshing' || undefined}
              className="[display:flex] [flex-direction:column] [gap:6px]"
            >
              {items}
              <EndLine
                words={TEAM_WORDS}
                end={end}
                held={heldText(TEAM_WORDS, list.answers[0])}
                empty={
                  shown || search.settled !== '' || admin ? null : (
                    <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]">
                      You lead no team yet.
                    </div>
                  )
                }
                stopped={list.stopped}
                none={list.rows.length === 0}
                first={list.batches.length <= 1}
                loading={list.phase === 'more'}
                onMore={more}
                onRetry={() => list.retry()}
              />
            </div>
          </>
        ) : (
          <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]">
            You lead no team yet.
          </div>
        )}
        {removal.window}
        {admin && (
          <SettingsGroup legend="New team">
            <div className="[display:flex] [gap:8px]">
              <LimitedInput
                limit={LIMITS.teamName}
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="New team name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTeam()
                }}
                wrapperClassName="[flex:1]"
                className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
              />
              <Button
                type="button"
                disabled={!teamName.trim() || overLimit(LIMITS.teamName, teamName) || adding}
                onClick={addTeam}
              >
                <Icon name="plus" size={16} />
                Add team
              </Button>
            </div>
          </SettingsGroup>
        )}
      </SettingsSection>
    </>
  )
}

/* One team of Settings › Teams: its name, which opens its page, its member
   count from the server, or a kept row's note in its place, and Delete for
   an admin. It paints the store's name while the store holds the team;
   Delete waits for the store's team, and stays off for the organization's
   last team (`last`). */
function TeamRow({
  id,
  answer,
  note,
  admin,
  last,
  armed,
  checking,
  onOpen,
  onDelete,
}: {
  id: string
  /** the answer's row, null for a kept row no loaded batch holds */
  answer: TeamRowAnswer | null
  note: string | null
  admin: boolean
  last: boolean
  armed: boolean
  checking: boolean
  onOpen: () => void
  /** presses Delete, with where focus goes once the row has left */
  onDelete: (focusAfter: () => HTMLElement | null) => void
}) {
  const team = storeTeam(id)
  const name = team?.name ?? answer?.name ?? ''
  const held = team !== null
  const lastLine = "The last team can't be deleted. Create another team first."
  return (
    <div
      data-team-row={id}
      data-team-waiting={held ? undefined : ''}
      className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
    >
      <Button
        type="button"
        data-team-open
        onClick={onOpen}
        title={`Open ${name}`}
        className="[flex:1] [text-align:left] [background:none] [border:none] [padding:0] [cursor:pointer] [font-size:var(--fs-base)] [font-weight:600] [color:var(--text-1)] [font-family:var(--sans)]"
        variant="unstyled"
      >
        {name}
      </Button>
      <span
        data-team-count=""
        className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono"
      >
        {note !== null ? (
          <span data-team-kept="">{note}</span>
        ) : (
          membersLine(answer?.member_count ?? null)
        )}
      </span>
      {admin && (
        <Button
          type="button"
          variant="ghost"
          size={armed ? 'sm' : 'icon-sm'}
          disabled={last || checking || !held}
          aria-busy={checking || undefined}
          style={{ opacity: last ? 0.35 : 1, color: armed ? 'var(--danger)' : undefined }}
          aria-label={last ? lastLine : armed ? 'Click again to delete this team' : 'Delete team'}
          title={
            last
              ? lastLine
              : !held
                ? WAITING
                : checking
                  ? REMOVAL_CHECKING
                  : armed
                    ? 'Click again to delete this team'
                    : 'Delete team'
          }
          data-team-delete
          onClick={() => {
            if (last) return
            onDelete(
              focusAround(
                'data-team-row',
                id,
                (row) =>
                  row.querySelector<HTMLElement>('[data-team-delete]:not(:disabled)') ??
                  row.querySelector<HTMLElement>('[data-team-open]'),
              ),
            )
          }}
        >
          <Icon name="trash" size={16} />
          {armed && 'Delete?'}
        </Button>
      )}
    </div>
  )
}
