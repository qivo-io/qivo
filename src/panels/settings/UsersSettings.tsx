/* Settings → Organization → Users, the home organization's people, agents
   and guests, read from the server a page at a time, with their roles,
   hours and an agent's keys, and the form that adds a person or an agent.

   The list is people.settingsPage, 25 records a page across the people and
   agents and then the guests, in name order, with a search over names and
   addresses on the server and Previous and Next (lib/pagedList.ts
   usePagedPages). A row shows the store's profile while the store holds
   it, so this session's writes show at once, else the answer's values, and
   every write sends what the row showed (UserControls.tsx ShownPerson,
   store/planner.ts PersonShown) with its `expected` from it, whether or
   not the store holds the person, so no control waits for the store. Each
   row's face is P.person's, its picture editor included, and the page
   names the people of its rows and kept rows (usePeople). A removal
   hides its row while it is on its way and after the server accepted it,
   and a refused one shows it again. The last-admin lock follows the
   server's count of active admins, never the rows on screen. An agent's key line and its key panel read tokens.agentKeys
   once, for the agents on screen, and again after a key write and when
   the tab shows again, never as a subscription, and a key line says
   Checking keys… while its read waits. A row whose name, address or hours
   are being typed or wait for the server's answer to their save, an agent
   whose key panel is open and a person added on this visit stay on screen
   through a search or a page move.
   Leaving the page drops every answer; the page remembers only its search
   and page starts (usersKept). */
import React, { useEffect as useEffectS, useRef as useRefS, useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { api } from '../../../convex/_generated/api'
import { emailRefusal } from '../../../convex/lib/email'
import { LIMITS } from '../../../convex/lib/limits'
import { CopyValue } from '../../components/CopyValue'
import { LimitedInput } from '../../components/LimitedField'
import { PageFold } from '../../components/pageFold'
import { pagesState, useMoveFocus } from '../../components/pageMoves'
import { Avatar, Icon, Seg } from '../../components/qivo'
import { FieldHint, PageTitle, SettingsGroup, SettingsSection } from '../../components/settingsPage'
import { usePeople } from '../../components/usePeople'
import { DEMO_MODE } from '../../lib/demoMode'
import { cleanName, overLimit, sentence } from '../../lib/fieldLimits'
import { type InviteReads, InviteRows, useInviteDeliveries } from '../../lib/inviteDeliveries'
import { useUnsaved } from '../../lib/leaveGuard'
import { pageEnd, usePagedPages, useSettledSearch } from '../../lib/pagedList'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { useConfirmArm } from '../../lib/useConfirmArm'
import { useViewVisibility } from '../../lib/viewVisibility'
import type {
  AgentKeysRow,
  NewUserInput,
  PeoplePageAnswer,
  SettingsPersonRow,
  UserVM,
} from '../../store/planner'
import { P, personShownOf } from '../../store/planner'
import { BackLink, DemoCapabilityNotice } from './controls'
import { AvatarPicker } from './ProfileControls'
import {
  InviteLabel,
  PlannableHoursInput,
  ProjectRightCell,
  ProjectRightHeader,
  type ShownPerson,
  UserEmail,
  UserName,
  UserRoleSelect,
  WAITING,
} from './UserControls'
import type { PersonSettingsRead } from './usePersonSettings'

/* How long typing pauses before the Add row says why an address is refused. */
const EMAIL_NOTE_DELAY_MS = 500

const agentKeyFingerprint = (stored: string) =>
  stored.includes('...') || stored.includes('…') ? stored : `${stored}…`

type PageReady = Extract<PeoplePageAnswer, { state: 'ready' }>

/* ------------------------------------------------------------- the rows */

/** The store's profile of `id` in the home organization, or undefined,
    which a row paints over the answer so this session's writes show at
    once, and which keeps an "Added" row on screen. */
const held = (id: string): UserVM | undefined => {
  const user = P.user(id)
  return user && user.org === P.homeOrg ? user : undefined
}

/** `answer` as the row shows it and its writes send it. */
const shownOf = (answer: SettingsPersonRow): ShownPerson => ({
  id: answer.id,
  orgId: P.homeOrg,
  name: answer.name,
  orgRole: answer.org_role,
  active: answer.active,
  isAgent: answer.kind === 'agent',
  email: answer.email,
  pending: answer.pending,
  plannableHours: answer.plannable_hours,
  canCreateProjects: answer.can_create_projects,
})

/** Person `id` as the row shows them: the store's profile while it holds
    them, else the answer, or null with neither. */
const rowShown = (id: string, answer: SettingsPersonRow | null): ShownPerson | null => {
  const vm = held(id)
  return vm ? { id, ...personShownOf(vm) } : answer ? shownOf(answer) : null
}

/** A row's face, P.person's, with the picture editor for an admin. In a
    div, so the row's name block stays its second div, as the phone layout
    reads it. */
function RowFace({ id }: { id: string }) {
  return (
    <div className="flex shrink-0">
      <AvatarPicker person={P.person(id, P.homeOrg) ?? { state: 'loading', id }} />
    </div>
  )
}

/** The note a kept row carries, for a person added on this visit or a
    row the page on screen does not hold. */
type KeptNote = 'Added' | 'Not on this page'

/** An agent's key line state, from the page's one-shot key reads. */
type KeyLine = AgentKeysRow | 'failed' | 'gone' | undefined

/** The words of an agent's key line (`data-agent-keyline`). "no key" only
    from an answer that holds every key of the agent. */
function KeyLineText({ line }: { line: KeyLine }) {
  if (DEMO_MODE) return <>no key, cannot sign in</>
  if (line === undefined) return <>Checking keys…</>
  if (line === 'failed' || line === 'gone') return <>Couldn't check keys.</>
  const active = line.keys.filter((k) => !k.revokedAt)
  const shown = active[0]
  if (!shown)
    return <>{line.more ? 'No active key among the newest 50.' : 'no key, cannot sign in'}</>
  const others = active.length - 1
  const tail = line.more
    ? others > 0
      ? `, +${others} or more`
      : ', and maybe more'
    : others > 0
      ? `, +${others} more`
      : ''
  return (
    <>
      {agentKeyFingerprint(shown.prefix)}
      {tail}
    </>
  )
}

/* One agent's keys, opened from its row. A key is the agent's login, so this
   is the closest thing the app has to a password field, and the secret is
   shown exactly once, at creation, because only its SHA-256 and safe display
   fingerprint are stored. The panel reads the agent's keys once when it
   opens, again after each of its writes (P.agentKeys), which it tells the
   page so the key lines read again too, and again when the tab shows
   again (`shownAt`), as the page's key lines do. A read keeps the typed
   name and a fresh secret. */
function AgentKeyPanel({
  agent,
  shownAt,
  onKeysChanged,
}: {
  agent: Pick<UserVM, 'id' | 'name'>
  /** when the tab or window last showed (lib/viewVisibility.ts) */
  shownAt: number
  onKeysChanged: () => void
}) {
  const [name, setName] = useStateS('')
  const [fresh, setFresh] = useStateS<{ secret: string } | null>(null)
  const [busy, setBusy] = useStateS(false)
  const [read, setRead] = useStateS<
    { state: 'loading' } | { state: 'failed' } | { state: 'ok'; row: AgentKeysRow | null }
  >({ state: 'loading' })
  const [attempt, setAttempt] = useStateS(0)
  const confirm = useConfirmArm<string>()
  useUpdateBlocker(!!name || !!fresh || busy)
  useUnsaved(!!name.trim(), 'name')
  useEffectS(() => {
    let live = true
    setRead({ state: 'loading' })
    void P.agentKeys(P.homeOrg, [agent.id]).then((answer) => {
      if (!live) return
      setRead(
        answer === null
          ? { state: 'failed' }
          : { state: 'ok', row: answer.agents.find((a) => a.agent_id === agent.id) ?? null },
      )
    })
    return () => {
      live = false
    }
  }, [agent.id, attempt, shownAt])
  const reload = () => {
    setAttempt((n) => n + 1)
    onKeysChanged()
  }
  const gone = read.state === 'ok' && read.row === null
  const mine = read.state === 'ok' ? (read.row?.keys ?? []) : []
  const mint = async () => {
    // a paused create keeps the typed name and says why
    if (busy || gone || overLimit(LIMITS.keyName, name) || P.refusePausedEdit()) return
    setBusy(true)
    const res = await P.createAgentKey(agent.id, name.trim() || 'Key')
    setBusy(false)
    if (!res) {
      window.showToast?.("Couldn't create that key", 'error')
      return
    }
    setFresh({ secret: res.secret })
    setName('')
    reload()
  }
  const note = 'text-sm text-text-2 italic'
  return (
    <div
      data-agent-keys={agent.id}
      data-agent-keys-state={read.state}
      className="[margin:0_0_6px_38px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-2)]"
    >
      {fresh && (
        <div className="[margin-bottom:8px] [border:1px_solid_var(--primary)] [border-radius:var(--r-md)] [padding:20px] [background:var(--accent-soft)]">
          <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [margin-bottom:8px]">
            Copy this key now. It cannot be shown again.
          </div>
          <div className="flex items-center gap-2">
            {/* on a phone, mobile-settings.css gives [data-fresh-key] its own row */}
            <div data-fresh-key className="min-w-0 flex-1">
              <CopyValue value={fresh.secret} label="Copy key" />
            </div>
            <Button type="button" variant="ghost" onClick={() => setFresh(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      <div className="[display:flex] [flex-direction:column] [gap:8px] mb-6">
        {read.state === 'loading' && (
          <div className={note} role="status">
            Loading keys…
          </div>
        )}
        {read.state === 'failed' && (
          <div role="alert" className="flex items-center gap-2 text-sm text-danger">
            Couldn't load keys.
            <Button
              type="button"
              variant="ghost"
              className="h-control-sm text-sm"
              data-agent-keys-retry
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry
            </Button>
          </div>
        )}
        {gone && <div className={note}>This agent is no longer in the organization.</div>}
        {read.state === 'ok' && !gone && mine.length === 0 && (
          <div className={note}>No keys. This agent cannot sign in until it has one.</div>
        )}
        {mine.map((k) => {
          const arm = confirm.armed === k.id
          return (
            <div
              key={k.id}
              style={{ opacity: k.revokedAt ? 0.55 : 1 }}
              className="[display:flex] [align-items:center] [gap:8px]"
            >
              <Icon name="zap" size={16} color="var(--text-2)" />
              <div className="[flex:1] [min-width:0]">
                <div className="[font-size:var(--fs-sm)] [font-weight:600] [overflow-wrap:anywhere]">
                  {k.name}
                  {k.revokedAt && (
                    <span className="[margin-left:6px] [font-size:var(--fs-xs)] [font-weight:700] [color:var(--danger)]">
                      revoked
                    </span>
                  )}
                </div>
                <div className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                  {agentKeyFingerprint(k.prefix)}, created {P.fmtDate(new Date(k.createdAt))}
                  {k.lastUsedAt
                    ? `, last used ${P.fmtDate(new Date(k.lastUsedAt))}`
                    : ', never used'}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size={arm && k.revokedAt ? 'sm' : 'icon-sm'}
                style={{ color: arm ? 'var(--danger)' : undefined }}
                className="[flex-shrink:0]"
                aria-label={
                  k.revokedAt
                    ? arm
                      ? 'Confirm key deletion'
                      : 'Delete this revoked key'
                    : arm
                      ? 'Confirm revocation. This key loses access immediately'
                      : 'Revoke this key'
                }
                title={
                  k.revokedAt
                    ? arm
                      ? 'Confirm key deletion'
                      : 'Delete this revoked key'
                    : arm
                      ? 'Confirm revocation. This key loses access immediately'
                      : 'Revoke this key'
                }
                onClick={() => {
                  // press disarms before the request, so a click while it
                  // runs arms the button again instead of sending it twice
                  confirm.press(k.id, async () => {
                    const ok = k.revokedAt
                      ? await P.deleteAgentKey(k.id)
                      : await P.revokeAgentKey(k.id)
                    if (ok) window.showToast?.(k.revokedAt ? 'Key deleted' : `“${k.name}” revoked`)
                    else window.showToast?.("That didn't go through", 'error')
                    reload()
                  })
                }}
              >
                <Icon name={k.revokedAt ? 'trash' : 'blocked'} size={16} />
                {arm && k.revokedAt && 'Delete?'}
              </Button>
            </div>
          )
        })}
        {read.state === 'ok' && read.row?.more && (
          <div data-agent-keys-more className="text-xs text-text-2">
            Showing the newest 50 keys. Organization › API access lists every key of this agent.
          </div>
        )}
      </div>
      <div className="[display:flex] [gap:8px] [align-items:center]">
        <LimitedInput
          limit={LIMITS.keyName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name, e.g. CI runner"
          onKeyDown={(e) => {
            if (e.key === 'Enter') mint()
          }}
          wrapperClassName="[flex:1]"
          className="h-control w-full bg-surface-1 px-2.5 text-base font-sans [font-size:var(--fs-sm)]"
        />
        <Button
          type="button"
          data-new-agent-key={agent.id}
          disabled={busy || gone || overLimit(LIMITS.keyName, name)}
          onClick={mint}
        >
          <Icon name="plus" size={16} />
          New key
        </Button>
      </div>
    </div>
  )
}

/** What the page tells a row, and what a row tells the page. */
type RowContext = {
  /** the organization's active admins as the server counted them, or
      null while no current answer holds the count, which locks */
  admins: number | null
  rightColumn: boolean
  confirm: ReturnType<typeof useConfirmArm<string>>
  keyLine: (id: string) => KeyLine
  /** when the tab last showed, after which an open key panel reads its
      keys again, as the key lines do */
  shownAt: number
  openKeys: string | null
  setOpenKeys: (id: string | null) => void
  onKeysChanged: () => void
  onUnsaved: (field: string) => (id: string, unsaved: boolean) => void
  /** Hides person `id`'s row while their removal `removal` is on its way
      and once the server accepted it, then runs `done`; a refused one
      shows the row again. */
  onRemove: (id: string, removal: Promise<boolean>, done: () => void) => void
}

/* One person or agent of the list, by id. While the store holds the
   profile, the row paints it and every control writes; otherwise it shows
   `answer` read-only and its controls wait (WAITING). `note` marks a kept
   row. `labelled` is the phone's user page, one row with a labelled
   project right; `forceWaiting` keeps the writes off there while its read
   is not current. The key panel renders inside the row, so a kept row
   that moves keeps the panel's fresh secret and typed name. */
function UserRow({
  id,
  answer,
  note,
  labelled = false,
  forceWaiting = false,
  pageRow = false,
  ctx,
}: {
  id: string
  answer: SettingsPersonRow | null
  note: KeptNote | null
  labelled?: boolean
  forceWaiting?: boolean
  pageRow?: boolean
  ctx: RowContext
}) {
  const u = rowShown(id, answer)
  if (!u) return null
  const waiting = forceWaiting
  const isSelf = id === P.CURRENT_USER
  const lastAdmin = u.orgRole === 'admin' && u.active && (ctx.admins === null || ctx.admins <= 1)
  const blocked = isSelf || lastAdmin || waiting
  const arm = ctx.confirm.armed === `u:${id}`
  const open = ctx.openKeys === id
  return (
    <>
      <div
        data-user-row={id}
        {...(pageRow ? { 'data-users-page-row': '' } : {})}
        {...(note ? { 'data-user-kept': note === 'Added' ? 'added' : 'kept' } : {})}
        style={{ opacity: u.active ? 1 : 0.62 }}
        className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
      >
        <RowFace id={id} />
        <div className="[flex:1] [min-width:0]">
          <UserName user={u} isSelf={isSelf} waiting={waiting} onUnsaved={ctx.onUnsaved('name')} />
          {/* an agent has no address to show or edit; what stands in its
              place is the thing it actually signs in with */}
          {u.isAgent ? (
            <div
              data-agent-keyline={id}
              className="[padding-left:6px] [font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]"
            >
              <KeyLineText line={ctx.keyLine(id)} />
            </div>
          ) : (
            <UserEmail user={u} waiting={waiting} onUnsaved={ctx.onUnsaved('email')} />
          )}
          {note && (
            <div data-kept-note className="pl-1.5 text-xs text-text-2 italic">
              {note}
            </div>
          )}
        </div>
        {/* Org admins may edit each person's planning capacity. */}
        <PlannableHoursInput
          user={u}
          canEdit={!waiting}
          waiting={waiting}
          onUnsaved={ctx.onUnsaved('hours')}
        />
        {u.isAgent && !DEMO_MODE && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            style={{ background: open ? 'var(--accent-soft)' : undefined }}
            className="w-control-sm h-control-sm [flex-shrink:0]"
            aria-label={open ? "Hide this agent's keys" : "Manage this agent's keys"}
            title={open ? "Hide this agent's keys" : "Manage this agent's keys"}
            onClick={() => ctx.setOpenKeys(open ? null : id)}
          >
            <Icon name="zap" size={16} />
          </Button>
        )}
        {ctx.rightColumn && <ProjectRightCell user={u} labelled={labelled} waiting={waiting} />}
        <UserRoleSelect user={u} isSelf={isSelf} lastAdmin={lastAdmin} waiting={waiting} />
        <Button
          type="button"
          variant="ghost"
          size={arm ? 'sm' : 'icon-sm'}
          disabled={blocked}
          style={{
            opacity: blocked ? 0.35 : 1,
            color: arm ? 'var(--danger)' : undefined,
          }}
          className="[flex-shrink:0]"
          aria-label={
            waiting
              ? WAITING
              : isSelf
                ? "You can't remove yourself"
                : lastAdmin
                  ? 'Add another admin first'
                  : arm
                    ? 'Click again to confirm removal'
                    : 'Remove from the organization, or switch them to Inactive to keep their history intact'
          }
          title={
            waiting
              ? WAITING
              : isSelf
                ? "You can't remove yourself"
                : lastAdmin
                  ? 'Add another admin first'
                  : arm
                    ? 'Click again to confirm removal'
                    : 'Remove from the organization, or switch them to Inactive to keep their history intact'
          }
          onClick={() => {
            if (blocked) return
            ctx.confirm.press(`u:${id}`, () =>
              ctx.onRemove(id, P.removeUser(id, { orgId: u.orgId }), () =>
                window.showToast?.(`${u.name} removed from the organization`),
              ),
            )
          }}
        >
          <Icon name="trash" size={16} />
          {arm && 'Delete?'}
        </Button>
      </div>
      {u.isAgent && !DEMO_MODE && open && (
        <AgentKeyPanel agent={u} shownAt={ctx.shownAt} onKeysChanged={ctx.onKeysChanged} />
      )}
    </>
  )
}

/* One guest of the list, by id, with the address, the invitation's state,
   the first projects the server listed and the hours, and a two-press
   Remove. Like UserRow, it paints the store's profile while the store
   holds it, else the answer, and writes with what it showed. */
function GuestRow({
  id,
  answer,
  note,
  ctx,
  pageRow = false,
}: {
  id: string
  answer: SettingsPersonRow | null
  note: KeptNote | null
  ctx: RowContext
  pageRow?: boolean
}) {
  const u = rowShown(id, answer)
  if (!u) return null
  const waiting = false
  const arm = ctx.confirm.armed === `g:${id}`
  const projects = answer?.guest ?? null
  return (
    <div
      data-guest-row={u.email || id}
      data-user-row={id}
      {...(pageRow ? { 'data-users-page-row': '' } : {})}
      {...(note ? { 'data-user-kept': note === 'Added' ? 'added' : 'kept' } : {})}
      className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
    >
      <RowFace id={id} />
      <div className="[flex:1] [min-width:0]">
        {/* the address gives way to a long line, never the invitation's
            state and its Send invitation */}
        <div className="[display:flex] [align-items:baseline] [min-width:0] [font-size:var(--fs-base)] [font-weight:600] [white-space:nowrap]">
          <span className="[min-width:0] [overflow:hidden] [text-overflow:ellipsis]">
            {u.email || u.name}
          </span>
          {u.pending && (
            <InviteLabel user={u} waiting={waiting} className="[margin-left:6px] [flex-shrink:0]" />
          )}
        </div>
        <div
          data-guest-projects
          className="[font-size:var(--fs-xs)] [color:var(--text-2)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]"
        >
          {projects === null
            ? 'Checking projects…'
            : projects.projects.length
              ? `${projects.projects.map((p) => `${p.name} (${p.level})`).join(', ')}${projects.more ? ', and more' : ''}`
              : projects.more
                ? 'Projects not listed here.'
                : 'no shared projects'}
        </div>
        {note && (
          <div data-kept-note className="pl-0 text-xs text-text-2 italic">
            {note}
          </div>
        )}
      </div>
      <PlannableHoursInput
        user={u}
        canEdit={!waiting}
        waiting={waiting}
        onUnsaved={ctx.onUnsaved('hours')}
      />
      {/* revoking the seat removes every grant with it; the two clicks
          match every other destructive control */}
      <Button
        type="button"
        variant="ghost"
        size={arm ? 'sm' : 'icon-sm'}
        disabled={waiting}
        style={{ color: arm ? 'var(--danger)' : undefined, opacity: waiting ? 0.35 : 1 }}
        className="[flex-shrink:0]"
        aria-label={
          waiting
            ? WAITING
            : arm
              ? 'Click again to remove this guest'
              : 'Remove guest. They lose every project shared with them.'
        }
        title={
          waiting
            ? WAITING
            : arm
              ? 'Click again to remove this guest'
              : 'Remove guest. They lose every project shared with them.'
        }
        onClick={() => {
          if (waiting) return
          ctx.confirm.press(`g:${id}`, () =>
            ctx.onRemove(id, P.removeUser(id, { orgId: u.orgId }), () =>
              window.showToast?.(`${u.email || u.name} no longer has access`),
            ),
          )
        }}
      >
        <Icon name="trash" size={16} />
        {arm && 'Delete?'}
      </Button>
    </div>
  )
}

/* A phone row of the list, a link to the person's page with the name,
   "Agent" or the address, and the role or Inactive. */
function PhoneRow({
  id,
  answer,
  note,
  setPage,
  pageRow,
}: {
  id: string
  answer: SettingsPersonRow | null
  note: KeptNote | null
  setPage: (page: string) => void
  pageRow: boolean
}) {
  const u = rowShown(id, answer)
  if (!u) return null
  return (
    <Button
      variant="unstyled"
      className="settings-mobile-menu-row"
      data-user-row={id}
      data-settings-open-user={id}
      {...(pageRow ? { 'data-users-page-row': '' } : {})}
      {...(note ? { 'data-user-kept': note === 'Added' ? 'added' : 'kept' } : {})}
      aria-label={`Manage ${u.name}`}
      onClick={() => setPage(`user:${id}`)}
    >
      <Avatar id={id} size={28} />
      <span className="settings-mobile-menu-copy">
        <span>
          {u.name}
          {id === P.CURRENT_USER ? ' (you)' : ''}
          {note ? ` · ${note}` : ''}
        </span>
        <span>
          {u.isAgent ? 'Agent' : u.email || 'No email'} · {u.active ? u.orgRole : 'Inactive'}
        </span>
      </span>
      <Icon name="chevronRight" size={16} />
    </Button>
  )
}

/** The line a page shows while a read of its invitation rows failed,
    with Try again, which reads them all afresh. Meanwhile the labels of
    those seats say Qivo couldn't check them, never "invited". */
function InviteReadsFailed({ reads }: { reads: InviteReads }) {
  if (reads.failed.size === 0) return null
  return (
    <p role="alert" data-invites-failed className="flex items-center gap-2 text-sm text-danger">
      Couldn't check invitation emails.
      <Button
        type="button"
        variant="ghost"
        className="h-control-sm text-sm"
        data-invites-retry
        onClick={reads.retry}
      >
        Try again
      </Button>
    </p>
  )
}

/* ------------------------------------------------------------ the page */

/* What Settings › Users keeps for the browser session, so Back from a
   person's page lands on the page it came from, read again. It keeps the
   settled search and the page starts, for the login that left them, and
   never an answer. */
let usersKept: { login: string; search: string; starts: readonly (string | null)[] } | null = null
const loginNow = () => P.myProfileIds.join(',')

/** The arguments of one page of people.settingsPage, in a fixed key order
    with empty fields left out. */
const usersArgs = (org: string, search: string, after: string | null) => ({
  org_id: org,
  ...(search === '' ? {} : { search }),
  ...(after === null ? {} : { after }),
})

const readyPage = (answer: PeoplePageAnswer): PageReady | null =>
  answer.state === 'ready' ? answer : null

/** The Settings → Organization → Users page. On a narrow screen the list
    becomes a list of links, and a `user:<id>` page (`person`, Settings'
    read of that person) shows one member's controls with a link back to
    the list. */
export function OrgUsersPage({
  narrow = false,
  person = null,
  setPage,
  onBackPage = setPage,
}: {
  narrow?: boolean
  /** the read of a `user:` page's person (usePersonSettings), null on the
      list */
  person?: PersonSettingsRead | null
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
}) {
  const [addName, setAddName] = useStateS('')
  const [addEmail, setAddEmail] = useStateS('')
  const [addRole, setAddRole] = useStateS<NewUserInput['orgRole']>('user')
  const [addKind, setAddKind] = useStateS<NonNullable<NewUserInput['kind']>>('person')
  const confirm = useConfirmArm<string>()
  const [openKeys, setOpenKeys] = useStateS<string | null>(null)
  const [freshAgent, setFreshAgent] = useStateS<{ name: string; secret: string } | null>(null)
  useUpdateBlocker(!!addName || !!addEmail || addRole !== 'user' || !!freshAgent)
  useUnsaved(!!addName.trim(), 'name')
  useUnsaved(!!addEmail.trim(), 'email')
  // the per-person project-creation right only counts under Selected users
  const rightColumn = P.org.projectCreators === 'selected'
  const admin = P.isAdmin()
  const personPage = narrow && person !== null

  /* ---- the list ---- */
  const kept = usersKept?.login === loginNow() ? usersKept : null
  const [text, setText] = useStateS(kept?.search ?? '')
  const search = useSettledSearch(text, LIMITS.search)
  const searchBox = useRefS<HTMLInputElement>(null)
  const org = P.homeOrg
  // a seat that is not an admin reads nothing; the server refuses it too
  const listKey =
    admin && org && !personPage ? JSON.stringify(usersArgs(org, search.settled, null)) : null
  const page = usePagedPages({
    key: listKey,
    query: api.people.settingsPage,
    args: (after) => usersArgs(org, search.settled, after),
    batch: readyPage,
    starts: kept && kept.search === search.settled ? kept.starts : undefined,
  })
  useEffectS(() => {
    if (listKey !== null)
      usersKept = { login: loginNow(), search: search.settled, starts: page.starts }
  })
  // the count of active admins, from the page on screen while its answer
  // is current; unknown, and so locked, while it loads, holds no rows,
  // failed or refreshes
  const pageAnswer =
    (page.phase === 'ready' || page.phase === 'moving') &&
    !page.refreshing &&
    page.answer?.state === 'ready'
      ? page.answer
      : null
  const admins = personPage
    ? person?.state === 'ok'
      ? (person.answer?.admins ?? null)
      : null
    : (pageAnswer?.admins ?? null)

  /* ---- the rows kept on screen ---- */
  // the people this visit added, which leave once a page has held them
  const [added, setAdded] = useStateS<readonly string[]>([])
  // the fields that hold their row, with unsaved text or a save the server
  // has not answered (UserControls.tsx useHeldRow), by person
  const [drafts, setDrafts] = useStateS<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map())
  // the people removed here, hidden while the removal is on its way and
  // once the server accepted it; a refused one comes back
  const [removed, setRemoved] = useStateS<ReadonlySet<string>>(() => new Set())
  // the row that holds focus, which stays while a person edits it, so a
  // kept row does not leave under the cursor as its text passes through
  // the saved value or empty
  const [focused, setFocused] = useStateS<string | null>(null)
  // the answer row each person last showed with, for the rows kept
  const known = useRefS(new Map<string, SettingsPersonRow>())
  const pageRows = page.rows
  for (const row of pageRows) known.current.set(row.id, row)
  const onPage = new Set(pageRows.map((r) => r.id))
  useEffectS(() => {
    const seen = added.filter((id) => onPage.has(id) || !held(id))
    if (seen.length > 0) setAdded((was) => was.filter((id) => !seen.includes(id)))
  })
  const onUnsaved = React.useCallback(
    (field: string) => (id: string, unsaved: boolean) =>
      setDrafts((was) => {
        const fields = was.get(id)
        if (unsaved === !!fields?.has(field)) return was
        const next = new Map(was)
        const now = new Set(fields)
        if (unsaved) now.add(field)
        else now.delete(field)
        if (now.size > 0) next.set(id, now)
        else next.delete(id)
        return next
      }),
    [],
  )
  const keptIds: { id: string; note: KeptNote }[] = []
  const keep = (id: string, note: KeptNote) => {
    if (onPage.has(id) || keptIds.some((k) => k.id === id)) return
    if (removed.has(id)) return
    keptIds.push({ id, note })
  }
  if (!personPage) {
    for (const id of added) if (held(id)) keep(id, 'Added')
    for (const id of drafts.keys()) keep(id, 'Not on this page')
    if (focused !== null && known.current.has(focused)) keep(focused, 'Not on this page')
    if (openKeys !== null) keep(openKeys, 'Not on this page')
  }
  // forget the answers of rows neither the page nor a kept row shows
  for (const id of known.current.keys())
    if (!onPage.has(id) && !keptIds.some((k) => k.id === id)) known.current.delete(id)
  // the people the page shows, named while it shows: the kept rows, then
  // the page's rows, or the phone page's one person
  usePeople(
    (personPage
      ? person?.answer
        ? [person.answer.person.id]
        : []
      : [...keptIds.map((k) => k.id), ...pageRows.map((r) => r.id)]
    ).map((id) => ({ org: P.homeOrg, id })),
  )

  /* ---- the key lines ---- */
  const { visible, shownAt } = useViewVisibility()
  const [keyEpoch, setKeyEpoch] = useStateS(0)
  // the answer of the last key read that landed, for the agents it named
  // alone, with the read it answers (keyRead)
  const [keyAnswer, setKeyAnswer] = useStateS<{
    read: string
    lines: ReadonlyMap<string, KeyLine>
  } | null>(null)
  // the agents whose default key is being made, whose line waits for it
  const [minting, setMinting] = useStateS<ReadonlySet<string>>(() => new Set())
  const shownAgents = new Set<string>()
  const isAgentRow = (id: string) => {
    const vm = held(id)
    return vm ? vm.isAgent : known.current.get(id)?.kind === 'agent'
  }
  // the phone's list shows no key line, so only its person page reads
  // keys, for the person the store holds or, while it does not, as the
  // page's answer has them
  const pagePerson = personPage ? (person?.answer?.person ?? null) : null
  if (personPage) {
    if (pagePerson && (held(pagePerson.id)?.isAgent ?? pagePerson.kind === 'agent'))
      shownAgents.add(pagePerson.id)
  } else if (!narrow) {
    for (const row of pageRows)
      if (row.kind === 'agent' && !removed.has(row.id)) shownAgents.add(row.id)
    for (const k of keptIds) if (isAgentRow(k.id)) shownAgents.add(k.id)
  }
  const agentIds = [...shownAgents].filter((id) => !minting.has(id)).sort()
  const agentsKey = agentIds.join(',')
  const keyRead = `${keyEpoch}:${agentsKey}`
  // a line shows only the answer of the read for the agents on screen now,
  // so while a read waits its agents say Checking keys, never an earlier
  // answer, from the first frame after a page move or a key write
  const keyLines = keyAnswer?.read === keyRead ? keyAnswer.lines : null
  // one read each time the agents shown change, after a key write and when
  // the tab or window shows again, the list's and the phone's user page
  // alike, since a key may have been revoked meanwhile. Each run first
  // drops the answer before it, so the same agents shown again after a
  // page without agents, or after the tab hid, say Checking keys until
  // their new answer lands, and no answer stays for an agent off screen.
  useEffectS(() => {
    setKeyAnswer(null)
    if (DEMO_MODE || !visible || agentIds.length === 0) return
    let live = true
    void P.agentKeys(P.homeOrg, agentIds).then((answer) => {
      if (!live) return
      const lines = new Map<string, KeyLine>()
      for (const id of agentIds)
        lines.set(
          id,
          answer === null ? 'failed' : (answer.agents.find((a) => a.agent_id === id) ?? 'gone'),
        )
      setKeyAnswer({ read: keyRead, lines })
    })
    return () => {
      live = false
    }
  }, [keyRead, visible])
  const onKeysChanged = React.useCallback(() => setKeyEpoch((n) => n + 1), [])

  /* ---- invitation labels, for the pending rows on screen ---- */
  const pendingIds: string[] = []
  const pendingOf = (id: string) => {
    const vm = held(id)
    return vm ? vm.pending : !!known.current.get(id)?.pending
  }
  // a phone row shows no invitation label and only a guest's row does, so
  // the phone's list reads the pending guests alone
  const labelled = (id: string) =>
    !narrow || (held(id)?.orgRole ?? known.current.get(id)?.org_role) === 'guest'
  if (personPage) {
    if (pagePerson && (held(pagePerson.id)?.pending ?? pagePerson.pending))
      pendingIds.push(pagePerson.id)
  } else
    for (const id of [...onPage, ...keptIds.map((k) => k.id)])
      if (pendingOf(id) && labelled(id)) pendingIds.push(id)
  const inviteRows = useInviteDeliveries(org, pendingIds)

  const ctx: RowContext = {
    admins,
    rightColumn,
    confirm,
    keyLine: (id) => (minting.has(id) ? undefined : keyLines?.get(id)),
    shownAt,
    openKeys,
    setOpenKeys,
    onKeysChanged,
    onUnsaved,
    onRemove: (id, removal, done) => {
      setRemoved((was) => new Set(was).add(id))
      void removal.then((accepted) => {
        if (accepted) return done()
        setRemoved((was) => {
          const next = new Set(was)
          next.delete(id)
          return next
        })
      })
    },
  }

  /* ---- the add form ---- */
  const agentMode = addKind === 'agent'
  // People need a claimable email: empty disables Add, malformed also marks
  // the field invalid. Agents have no email, so both checks must be bypassed.
  const emailMissing = !agentMode && !addEmail.trim()
  const emailBad = !agentMode && !emailMissing && !P.emailLooksValid(addEmail)
  // a well-formed address can still be longer than the server stores, or
  // one a password login cannot use
  const emailRefused = emailRefusal(addEmail)
  const emailWhy =
    emailRefused === null ? 'That does not look like an email address' : sentence(emailRefused)
  // A whole address the server refuses says why under the row: the tooltip
  // shows when the field gains focus, before the typed address is refused.
  // It first waits until typing pauses, so an address on its way to .com,
  // refused at bo@example.c, never flashes it. Once shown it stays while
  // the address stays refused, so editing it neither blinks nor repeats it.
  const [settledEmail, setSettledEmail] = useStateS(addEmail)
  useEffectS(() => {
    const timer = setTimeout(() => setSettledEmail(addEmail), EMAIL_NOTE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [addEmail])
  const emailNote =
    !agentMode && emailRefused !== null && emailRefusal(settledEmail) !== null ? emailWhy : null
  const emailNoteId = React.useId()
  // counted as the server stores it, with whitespace runs collapsed
  const nameTooLong = overLimit(LIMITS.personName, cleanName(addName))
  const addUser = async () => {
    if (!addName.trim() || nameTooLong || emailBad || emailMissing) return
    // Preserve the entered fields when addUser refuses a duplicate seat.
    const made = P.addUser(
      agentMode
        ? { name: cleanName(addName), kind: 'agent', orgRole: addRole }
        : { name: cleanName(addName), email: addEmail, orgRole: addRole },
    )
    if (!made) return
    const name = cleanName(addName)
    setAddName('')
    setAddEmail('')
    setAddRole('user')
    // shown at the top until a page holds them
    setAdded((was) => [...was, made])
    if (!agentMode) {
      window.showToast?.(`${name} added to the organization`)
      return
    }
    // An agent with no key cannot sign in, so creating one is a single act:
    // the agent AND the key it authenticates with, revealed once, here.
    setMinting((was) => new Set(was).add(made))
    const res = await P.createAgentKey(made, 'Default key')
    setMinting((was) => {
      const next = new Set(was)
      next.delete(made)
      return next
    })
    onKeysChanged()
    if (!res) {
      window.showToast?.(
        `${name} added, but its key could not be created. Mint one below.`,
        'error',
      )
      setOpenKeys(made)
      return
    }
    setFreshAgent({ name, secret: res.secret })
  }

  // focus after Previous and Next goes to the page's first row's name
  // field, or on the phone its first link, else to the search box
  const move = useMoveFocus(
    page,
    'users',
    () =>
      narrow
        ? document.querySelector<HTMLElement>('[data-org-users] button[data-users-page-row]')
        : (document.querySelector<HTMLElement>(
            '[data-org-users] [data-users-page-row] input[data-user-name]',
          ) ??
          document.querySelector<HTMLElement>('[data-org-users] [data-users-page-row] button')),
    () => searchBox.current,
  )

  /* ---- the phone's user page ---- */
  if (personPage && person) {
    const answer = person.answer
    const name = answer?.person.name ?? held(answer?.person.id ?? '')?.name
    const id = answer?.person.id ?? null
    return (
      <InviteRows.Provider value={inviteRows}>
        <div data-settings-user-detail={id ?? ''} data-person-state={person.state}>
          <BackLink to="Users" onClick={() => onBackPage('org-users')} />
          <PageTitle>{name ?? 'User'}</PageTitle>
          {answer === null && person.state !== 'failed' && (
            <p className="text-sm text-text-2" role="status" data-person-loading>
              Loading this person…
            </p>
          )}
          {/* also beside a row kept from an earlier answer, whose
              controls wait until a read is current again */}
          {person.state === 'failed' && (
            <p
              role="alert"
              className="flex items-center gap-2 text-sm text-danger"
              data-person-failed
            >
              {answer === null ? "Couldn't load this person." : "Couldn't refresh this person."}
              <Button
                type="button"
                variant="ghost"
                className="h-control-sm text-sm"
                data-person-retry
                onClick={person.retry}
              >
                Try again
              </Button>
            </p>
          )}
          <InviteReadsFailed reads={inviteRows} />
          {answer !== null && id !== null && (
            <SettingsSection>
              <div className="[display:flex] [flex-direction:column] [gap:6px]">
                {answer.person.org_role === 'guest' ? (
                  <GuestRow id={id} answer={answer.person} note={null} ctx={ctx} />
                ) : (
                  <UserRow
                    id={id}
                    answer={answer.person}
                    note={null}
                    labelled
                    forceWaiting={person.state !== 'ok'}
                    ctx={ctx}
                  />
                )}
              </div>
            </SettingsSection>
          )}
        </div>
      </InviteRows.Provider>
    )
  }

  /* ---- the list's rows: one keyed array ---- */
  const searching = search.settled !== ''
  const end = pageEnd(page, searching)
  const state = pagesState(page)
  const rowFor = (
    id: string,
    answer: SettingsPersonRow | null,
    note: KeptNote | null,
    pageRow: boolean,
  ) => {
    if (removed.has(id)) return null
    const role = held(id)?.orgRole ?? answer?.org_role
    if (role === 'guest')
      return <GuestRow key={id} id={id} answer={answer} note={note} ctx={ctx} pageRow={pageRow} />
    if (narrow)
      return (
        <PhoneRow
          key={id}
          id={id}
          answer={answer}
          note={note}
          setPage={setPage}
          pageRow={pageRow}
        />
      )
    return <UserRow key={id} id={id} answer={answer} note={note} ctx={ctx} pageRow={pageRow} />
  }
  const pagePeople = pageRows.filter((r) => r.org_role !== 'guest')
  const pageGuests = pageRows.filter((r) => r.org_role === 'guest')
  const items: React.ReactNode[] = []
  if (rightColumn && !narrow) items.push(<ProjectRightHeader key="project-right-header" />)
  for (const k of keptIds) items.push(rowFor(k.id, known.current.get(k.id) ?? null, k.note, false))
  for (const row of pagePeople) items.push(rowFor(row.id, row, null, true))
  if (pageGuests.length > 0) {
    items.push(
      <div key="guests-heading" data-org-guests className="pt-4">
        <div className="text-sm font-semibold text-text-1">Guests</div>
        <p className="m-0 text-sm text-text-2">Guest hours apply within this organization.</p>
      </div>,
    )
    for (const row of pageGuests) items.push(rowFor(row.id, row, null, true))
  }
  items.push(
    <PageFold
      key="fold"
      page={page}
      end={end}
      hook="users"
      tooLong={search.tooLong}
      focus={move}
      held={() => ({
        line: 'The user list is not ready yet. Try again in a few minutes.',
        retry: false,
      })}
      words={{
        loading: 'Loading people…',
        failed: "Couldn't load people.",
        none: 'No people match.',
        empty: 'No people yet.',
        nomore: 'No more people on this page.',
      }}
    />,
  )

  return (
    <InviteRows.Provider value={inviteRows}>
      <div>
        <PageTitle>Users</PageTitle>

        {freshAgent && (
          <div
            data-fresh-agent
            className="[max-width:640px] [border:1px_solid_var(--primary)] [border-radius:var(--r-md)] [padding:20px] [background:var(--accent-soft)]"
          >
            <div className="[font-size:var(--fs-base)] [font-weight:600] [margin-bottom:8px]">
              “{freshAgent.name}” created
            </div>
            <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [margin-bottom:8px]">
              Copy the agent's sign-in key now. It cannot be shown again.
            </div>
            <div className="flex items-center gap-2">
              {/* on a phone, mobile-settings.css gives [data-fresh-key] its own row */}
              <div data-fresh-key className="min-w-0 flex-1">
                <CopyValue value={freshAgent.secret} label="Copy key" />
              </div>
              <Button type="button" variant="ghost" onClick={() => setFreshAgent(null)}>
                Done
              </Button>
            </div>
            <FieldHint>Give this agent project access to let it start working.</FieldHint>
          </div>
        )}

        <SettingsSection title={narrow ? undefined : 'Users'}>
          <LimitedInput
            ref={searchBox}
            limit={LIMITS.search}
            aria-label="Search people"
            placeholder="Search by name or email address"
            data-users-search=""
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // a typed search clears before Settings' own Escape leaves
              if (e.key === 'Escape' && text) {
                e.stopPropagation()
                setText('')
              }
            }}
            wrapperClassName="mb-2"
            className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
          />
          <InviteReadsFailed reads={inviteRows} />
          <div
            data-org-users=""
            onFocus={(e) => {
              const row = e.target.closest<HTMLElement>('[data-user-row]')
              setFocused(row?.dataset.userRow ?? null)
            }}
            onBlur={(e) => {
              const next = e.relatedTarget instanceof Element ? e.relatedTarget : null
              const row = next?.closest<HTMLElement>('[data-user-row]')
              setFocused(row?.dataset.userRow ?? null)
            }}
            data-users-state={state}
            aria-busy={state === 'loading' || state === 'refreshing' || undefined}
            className="[display:flex] [flex-direction:column] [gap:6px]"
          >
            {items}
          </div>

          {DEMO_MODE && (
            <DemoCapabilityNotice>
              The demo includes fictional teammates. Adding people or connecting agents is
              unavailable.
            </DemoCapabilityNotice>
          )}
          {!DEMO_MODE && (
            <SettingsGroup legend="Add a person or an agent">
              {/* Person or agent is the FIRST choice, because it decides what the rest
            of the form even means: a person is an address to sign in with, an
            agent is a key to hand to a machine. */}
              <div className="mb-2">
                <Seg
                  value={addKind}
                  // Clear person-only state when switching to an agent: admin
                  // is forbidden and the hidden email must not affect validation.
                  onChange={(next) => {
                    setAddKind(next)
                    setAddEmail('')
                    if (next === 'agent' && addRole === 'admin') setAddRole('user')
                  }}
                  options={[
                    { value: 'person', label: 'Person', icon: 'user' },
                    { value: 'agent', label: 'Agent', icon: 'zap' },
                  ]}
                />
              </div>
              <div className="settings-add-user-form [display:flex] [gap:8px] [align-items:center]">
                <LimitedInput
                  limit={LIMITS.personName}
                  clean={cleanName}
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder={agentMode ? 'Agent name, e.g. Release Bot' : 'Full name'}
                  aria-label={agentMode ? 'New agent name' : 'New person name'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addUser()
                  }}
                  wrapperClassName="[flex:1.2]"
                  className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
                />
                {!agentMode && (
                  <Input
                    value={addEmail}
                    onChange={(e) => setAddEmail(e.target.value)}
                    placeholder="Email address"
                    data-add-email
                    aria-label="New person email address"
                    type="email"
                    required
                    spellCheck={false}
                    autoCapitalize="off"
                    title={emailBad ? emailWhy : 'The email address they will use to sign in'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addUser()
                    }}
                    aria-invalid={emailBad}
                    // an absent key, not undefined, keeps the tooltip's description
                    {...(emailNote ? { 'aria-describedby': emailNoteId } : {})}
                    className="h-control flex-[1.4] bg-surface-1 px-2.5 text-base font-sans"
                  />
                )}
                {/* Agents may be read-only but cannot be org admins. */}
                <NativeSelect
                  data-add-role
                  aria-label="New user role"
                  value={addRole}
                  onChange={(e) => setAddRole(e.target.value as NewUserInput['orgRole'])}
                  className="h-control w-[132px] shrink-0 bg-surface-1 font-sans text-sm"
                >
                  <option value="user">Standard user</option>
                  <option value="viewer">Viewer</option>
                  {!agentMode && <option value="admin">Org admin</option>}
                </NativeSelect>
                <Button
                  type="button"
                  data-add-user
                  disabled={!addName.trim() || nameTooLong || emailBad || emailMissing}
                  title={
                    emailBad
                      ? emailWhy
                      : emailMissing
                        ? 'Email address required'
                        : agentMode
                          ? 'Create the agent and its first key'
                          : undefined
                  }
                  onClick={addUser}
                >
                  <Icon name="plus" size={16} />
                  {agentMode ? 'Add agent' : 'Add'}
                </Button>
              </div>
              {/* always present, so a screen reader hears the note when it appears */}
              <div aria-live="polite">
                {emailNote && (
                  <p
                    id={emailNoteId}
                    data-add-email-refusal
                    className="mt-2 text-sm leading-normal text-danger"
                  >
                    {emailNote}
                  </p>
                )}
              </div>
              <FieldHint>
                Active users, including pending invitations, count toward the next monthly renewal.
              </FieldHint>
              {agentMode && <FieldHint>Setting an agent to Inactive stops all its keys.</FieldHint>}
            </SettingsGroup>
          )}
        </SettingsSection>
      </div>
    </InviteRows.Provider>
  )
}
