/* Roster identity, invitation address, role and weekly capacity controls. */
import React, { useEffect as useEffectS, useState as useStateS } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { asciiEmail } from '../../../convex/lib/email'
import { LIMITS } from '../../../convex/lib/limits'
import { LimitedInput } from '../../components/LimitedField'
import { fmtTime } from '../../lib/dates'
import { DEMO_MODE } from '../../lib/demoMode'
import { cleanName, limitSentence, overLimit, wholeIn } from '../../lib/fieldLimits'
import {
  type InviteDelivery,
  type InviteDeliveryRow,
  inviteLabel,
  useInviteDeliveries,
  useRenderAt,
} from '../../lib/inviteDeliveries'
import { projectRightBox } from '../../lib/projectCreators'
import { EMAIL, PERSON_NAME, useSavedDraft, wholeNumber } from '../../lib/savedDraft'
import { DEFAULT_PLANNABLE_HOURS } from '../../lib/workload'
import type { UserPatch, UserVM } from '../../store/planner'
import { P } from '../../store/planner'
import { DraftConflictLine } from './controls'

// Roster renames commit on blur and affect this organization only. Account
// name changes use the explicit-save field and update the login's other seats.
// The typed name is a draft against the name it began from (lib/savedDraft.ts):
// a refused save keeps it, and a name changed elsewhere while it is typed
// shows under it, and nothing saves until Use saved or Keep mine. A name over
// the cap stays typed and invalid, with the cap's sentence, until it is
// shortened.
export function UserName({ user, isSelf }: { user: UserVM; isSelf: boolean }) {
  const canEdit = P.isAdmin()
  const draft = useSavedDraft(`${user.id}:name`, user.name, PERSON_NAME, 'name', !canEdit)
  const v = draft.text
  // Measure the proportional text so adjacent identity chips stay close.
  const mirror = React.useRef<HTMLSpanElement>(null)
  const [w, setW] = useStateS(0)
  useEffectS(() => {
    if (mirror.current) setW(mirror.current.offsetWidth)
  }, [v])
  const nameFace: React.CSSProperties = {
    fontSize: 'var(--fs-base)',
    fontWeight: 600,
    fontFamily: 'var(--sans)',
  }
  const commit = () => {
    const next = cleanName(v)
    if (!next || draft.isSaved(next)) return draft.showSaved()
    if (overLimit(LIMITS.personName, next)) {
      window.showToast?.(limitSentence(LIMITS.personName), 'error')
      return
    }
    // a conflict waits for Use saved or Keep mine; a paused rename keeps it
    if (draft.conflict || P.refusePausedEdit()) return
    P.updateUser(user.id, { name: next }, draft.save(next).as('name'))
    window.showToast?.(`${(user.isAgent ? 'Agent renamed to “' : 'Renamed to “') + next}”`)
  }
  const chips = (
    <>
      {isSelf && <span className="[color:var(--text-2)] [font-weight:500]"> (you)</span>}
      {user.isAgent && (
        <span
          data-agent-chip
          className="[margin-left:7px] [font-size:var(--fs-xs)] [font-weight:600] [color:var(--text-1)]"
        >
          agent
        </span>
      )}
      {user.orgRole === 'viewer' && (
        <span
          data-viewer-chip
          className="[margin-left:7px] [font-size:var(--fs-xs)] [font-weight:700] [color:var(--text-2)]"
        >
          read-only
        </span>
      )}
    </>
  )
  if (!canEdit) {
    return (
      <div className="[padding-left:6px] [font-size:var(--fs-base)] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
        <span data-user-name={user.id}>{user.name}</span>
        {chips}
      </div>
    )
  }
  return (
    <div className="min-w-0">
      <div className="[display:flex] [align-items:center] [min-width:0]">
        <span
          ref={mirror}
          aria-hidden="true"
          style={{ ...nameFace }}
          className="[position:absolute] [visibility:hidden] [white-space:pre] [pointer-events:none]"
        >
          {v || ' '}
        </span>
        <LimitedInput
          limit={LIMITS.personName}
          clean={cleanName}
          value={v}
          onChange={(e) => draft.edit(e.target.value)}
          data-user-name={user.id}
          aria-label={`Display name for ${user.name}`}
          aria-describedby={draft.conflict ? draft.conflictId : undefined}
          spellCheck={false}
          title={
            user.isAgent
              ? 'Rename this agent'
              : isSelf
                ? 'Renames you in this organization. Use Your preferences to change it across organizations.'
                : `Rename ${user.name} in this organization`
          }
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              // rendered before the blur, whose save then finds nothing typed
              flushSync(draft.discard)
              e.currentTarget.blur()
            }
          }}
          style={{ ...nameFace, width: Math.min(320, w + 13) }}
          wrapperClassName="flex-[0_1_auto]"
          // quiet until hovered (a hairline), and the standard active field look
          // from tokens.css once it has focus — like every other text box
          className="h-control-sm min-w-0 border-transparent bg-transparent px-[5px] py-0 text-ellipsis hover:border-border focus:bg-hover"
        />
        <span className="[font-size:var(--fs-base)] [font-weight:600] [white-space:nowrap]">
          {chips}
        </span>
      </div>
      <div className="pl-[5px]">
        <DraftConflictLine draft={draft} text={(name) => name} compact />
      </div>
    </div>
  )
}

/** A pending seat's marker. It says "invited", or that the invitation email
    did not go out, with the reason on hover (lib/inviteDeliveries), and
    offers SendAgain when it can go again. */
export function InviteLabel({ user, className }: { user: UserVM; className?: string }) {
  const row = useInviteDeliveries(user.org)?.get(user.id)
  const state = row?.state
  useRenderAt(row?.free_at ? Date.parse(row.free_at) : 0)
  const label = inviteLabel(state, row?.free_at)
  return (
    <>
      <HoverTooltip content={label.detail}>
        <span
          data-invite-for={user.id}
          data-invite-state={state ?? 'none'}
          className={cn(
            '[font-weight:700] [font-size:var(--fs-xs)]',
            label.failed ? '[color:var(--danger)]' : '[color:var(--warn)]',
            className,
          )}
        >
          {label.text}
        </span>
      </HoverTooltip>
      <SendAgain orgId={user.org} seat={user.id} row={row} />
    </>
  )
}

/** Send invitation, for a pending seat whose newest invitation email the
    hourly cap held back or that failed. It counts against the same cap, so
    until the hour frees a send it reads "Send after HH:MM" and is disabled,
    and unlocks by itself. Nothing for any other seat. The server lets only
    an org admin or whoever caused the send use it (invites.sendAgain), the
    people who see the seat's row. */
function SendAgain({
  orgId,
  seat,
  row,
}: {
  orgId: string
  seat: string
  row: InviteDeliveryRow | undefined
}) {
  const state = row?.state
  // a failed send waits for the hour too: it counts against the same cap
  const waitUntil = row?.free_at ? Date.parse(row.free_at) : 0
  const now = useRenderAt(waitUntil)
  const [sending, setSending] = useStateS(false)
  if (state !== 'held' && state !== 'unsent') return null
  const waiting = waitUntil > now
  return (
    <HoverTooltip
      content={
        waiting ? `Available after ${fmtTime(new Date(waitUntil))}` : 'Email the invitation again'
      }
    >
      <Button
        type="button"
        variant="unstyled"
        data-invite-again={seat}
        disabled={waiting || sending}
        onClick={() => {
          setSending(true)
          void P.sendInvitationAgain(orgId, seat).finally(() => setSending(false))
        }}
        className="[margin-left:6px] [flex-shrink:0] [font-size:var(--fs-xs)] [font-weight:600] [color:var(--primary)] [background:none] [border:none] [padding:0] [cursor:pointer] disabled:[color:var(--text-3)] disabled:[cursor:not-allowed]"
      >
        {waiting ? `Send after ${fmtTime(new Date(waitUntil))}` : 'Send invitation'}
      </Button>
    </HoverTooltip>
  )
}

const NO_ROW_WAIT_MS = 2 * 60_000

/** Under an invite form: whether the invitation email to the seat just
    created went out, live, in a full sentence. Only the send to `email`,
    compared in its stored form, counts, so a correction made elsewhere is
    not reported as this one. When the seat stops being pending (claimed or
    cancelled), the last result seen stays. Key it by seat. */
export function InviteOutcome({
  orgId,
  seat,
  email,
}: {
  orgId: string
  seat: string
  email: string
}) {
  const rows = useInviteDeliveries(orgId)
  const row = rows?.get(seat)
  // the row holds the address as stored (asciiEmail), so Anna@Bücher.DE
  // matches anna@xn--bcher-kva.de
  const current = row?.email === asciiEmail(email) ? row.state : undefined
  const [last, setLast] = useStateS<InviteDelivery>()
  useEffectS(() => {
    if (current !== undefined) setLast(current)
  }, [current])
  // a send that has not even been reserved after this long is not coming
  const [waited, setWaited] = useStateS(false)
  useEffectS(() => {
    const timer = setTimeout(() => setWaited(true), NO_ROW_WAIT_MS)
    return () => clearTimeout(timer)
  }, [])
  /* Nothing yet, or the seat's row is for another address: nothing to say.
     A send in flight whose row then vanished has no outcome either. */
  const state =
    current ??
    (last !== 'sending' ? last : undefined) ??
    (rows && !row && !last && !waited ? 'sending' : undefined)
  const freeAt = current === 'held' ? row?.free_at : undefined
  useRenderAt(freeAt ? Date.parse(freeAt) : 0)
  if (state === undefined) return null
  const label = inviteLabel(state, freeAt)
  const text = label.detail
    ? `${email}: ${label.detail}`
    : state === 'sent'
      ? `Invitation email sent to ${email}.`
      : `Sending the invitation email to ${email}…`
  return (
    <div
      data-invite-outcome={state}
      role="status"
      className={cn(
        '[font-size:var(--fs-sm)] [margin-top:8px]',
        label.failed ? '[color:var(--danger)]' : '[color:var(--text-2)]',
      )}
    >
      {text}
      {current !== undefined && <SendAgain orgId={orgId} seat={seat} row={row} />}
    </div>
  )
}

// Only unclaimed invitations can change email. Claimed seats retain the
// login address; empty or invalid edits restore the saved value, and an
// invalid one says why (P.updateUser). The typed address is a draft against
// the one it began from (lib/savedDraft.ts): the server's refusal keeps it,
// and an address changed elsewhere while it is typed shows under it, and
// nothing saves until Use saved or Keep mine.
export function UserEmail({ user }: { user: UserVM }) {
  const canEdit = !DEMO_MODE && P.isAdmin() && user.pending
  const draft = useSavedDraft(`${user.id}:email`, user.email, EMAIL, 'email', !canEdit)
  // Addresses are stored as asciiEmail writes them, so an edit that only
  // changes case or writes the domain in Unicode changes nothing.
  const commit = () => {
    const next = draft.text.trim()
    if (next === '' || draft.isSaved(next)) return draft.showSaved()
    // a conflict waits for Use saved or Keep mine; a paused change keeps it
    if (draft.conflict || P.refusePausedEdit()) return
    if (!P.updateUser(user.id, { email: next }, draft.save(next).as('email'))) draft.discard()
  }
  if (!canEdit) {
    return (
      <div
        data-user-email={user.id}
        className="[display:flex] [align-items:baseline] [min-width:0] [padding-left:6px] [font-size:var(--fs-xs)] [color:var(--text-2)] [white-space:nowrap]"
      >
        <span className="[min-width:0] [overflow:hidden] [text-overflow:ellipsis]">
          {DEMO_MODE ? 'Fictional teammate' : user.email || 'no email address'}
        </span>
        {user.pending && <InviteLabel user={user} className="[margin-left:6px] [flex-shrink:0]" />}
      </div>
    )
  }
  return (
    <div className="min-w-0">
      <div className="[display:flex] [align-items:center] [gap:6px]">
        <Input
          value={draft.text}
          onChange={(e) => draft.edit(e.target.value)}
          onBlur={commit}
          data-user-email={user.id}
          aria-label={`Email address for ${user.name}`}
          aria-describedby={draft.conflict ? draft.conflictId : undefined}
          type="email"
          spellCheck={false}
          autoCapitalize="off"
          placeholder="Email address"
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              // rendered before the blur, whose save then finds nothing typed
              flushSync(draft.discard)
              e.currentTarget.blur()
            }
          }}
          className="h-control-xs min-w-0 flex-1 border-transparent bg-transparent px-[5px] py-0 font-sans text-sm text-text-1 hover:border-border focus:bg-hover"
        />
        <InviteLabel user={user} className="[flex-shrink:0]" />
      </div>
      <div className="pl-[5px]">
        <DraftConflictLine draft={draft} text={EMAIL.text} compact />
      </div>
    </div>
  )
}

/** How the plannable hours field shows and compares hours: a seat that
    stores none plans the default week. */
const HOURS = wholeNumber<number | null>(DEFAULT_PLANNABLE_HOURS)

// Capacity commits whole hours on blur (LIMITS.plannableHours); an empty edit
// restores the saved value, and one outside the range stays typed and invalid
// with the range's sentence. The typed hours are a draft against the hours
// they began from (lib/savedDraft.ts): hours changed elsewhere meanwhile show
// under the field, and nothing saves until Use saved or Keep mine. Team
// leaders may edit this field, not other profile data.
export function PlannableHoursInput({
  user,
  canEdit,
  width = 48,
}: {
  user: UserVM
  canEdit: boolean
  width?: number
}) {
  const draft = useSavedDraft(
    `${user.id}:plannable_hours`,
    user.plannableHours,
    HOURS,
    'plannable hours',
    !canEdit || user.isAgent,
  )
  // a number refused on blur stays typed and marked until it changes
  const [refused, setRefused] = useStateS(false)
  // Agents have unlimited capacity and cannot receive a weekly-hour value.
  if (user.isAgent) {
    return (
      <span
        data-plannable-unbounded={user.id}
        className="[flex-shrink:0] [font-size:var(--fs-xs)] [color:var(--text-2)] [font-style:italic]"
      >
        no weekly limit
      </span>
    )
  }
  const inputId = `plannable-hours-${user.id}`
  const commit = () => {
    const raw = draft.text.trim()
    if (!raw || draft.isSaved(raw)) return draft.showSaved()
    const h = wholeIn(LIMITS.plannableHours, raw)
    if (h === null) {
      setRefused(true)
      window.showToast?.(limitSentence(LIMITS.plannableHours), 'error')
      return
    }
    // a conflict waits for Use saved or Keep mine; a pause keeps the hours
    if (draft.conflict || P.refusePausedEdit()) return
    P.updateUser(user.id, { plannableHours: h }, draft.save(h).as('plannable_hours'))
    window.showToast?.(`${user.name} plans ${h} h per week`)
  }
  return (
    <div className="flex max-w-[180px] shrink-0 flex-col items-end">
      <HoverTooltip
        content={
          canEdit
            ? 'Weekly time for project work, excluding meetings and other commitments. Shared across projects.'
            : 'Only an organization admin or one of this person’s team leaders can change these hours.'
        }
      >
        <label
          htmlFor={inputId}
          style={{ cursor: canEdit ? 'text' : 'default' }}
          className="[display:flex] [align-items:center] [gap:8px] [flex-shrink:0] [font-size:var(--fs-xs)] [color:var(--text-2)]"
        >
          <Input
            id={inputId}
            type="number"
            min={LIMITS.plannableHours.min}
            max={LIMITS.plannableHours.max}
            step={1}
            data-plannable-for={user.id}
            aria-label={`Plannable hours per week for ${user.name}`}
            aria-invalid={refused || undefined}
            aria-describedby={draft.conflict ? draft.conflictId : undefined}
            value={draft.text}
            disabled={!canEdit}
            onChange={(e) => {
              setRefused(false)
              draft.edit(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            onBlur={commit}
            style={{ width, opacity: canEdit ? 1 : 0.55 }}
            className="h-control-sm w-full bg-surface-1 px-1.5 text-right text-sm font-sans text-text-1"
          />
          h/wk
        </label>
      </HoverTooltip>
      <DraftConflictLine draft={draft} text={HOURS.text} compact end />
    </div>
  )
}

/* The roster's "Can create projects" column, shown only while the org's
   setting is Selected users. Every desktop row gets a cell of the same width
   right before the role select, so the column lines up under its one header
   label. An active standard user, person or agent, gets a checkbox in it,
   and an active org admin a ticked one that cannot be changed
   (projectRightBox). The phone's user page shows a single row without the
   header, so there the checkbox carries a visible label and the empty cell
   is left out. */
export function ProjectRightCell({ user, labelled }: { user: UserVM; labelled: boolean }) {
  const box = projectRightBox(user, P.org.projectCreators)
  if (labelled && box === null) return null
  const inputId = `can-create-projects-${user.id}`
  const locked = box === 'locked'
  return (
    <div
      data-project-right-cell={user.id}
      className={cn('flex shrink-0 justify-center', !labelled && 'w-[112px]')}
    >
      {box && (
        <label
          htmlFor={inputId}
          className={cn(
            'flex items-center gap-1.5 text-sm text-text-2',
            !locked && 'cursor-pointer',
          )}
        >
          <Input
            id={inputId}
            type="checkbox"
            data-can-create-projects={user.id}
            aria-label={`${user.name} can create projects`}
            checked={locked || user.canCreateProjects}
            disabled={locked}
            onChange={(e) => {
              const on = e.target.checked
              if (P.refusePausedEdit()) return
              P.updateUser(user.id, { canCreateProjects: on })
              window.showToast?.(
                on
                  ? `${user.name} can create projects`
                  : `${user.name} can no longer create projects`,
              )
            }}
            className={cn('[accent-color:var(--primary)]', !locked && 'cursor-pointer')}
          />
          {labelled && 'Can create projects'}
        </label>
      )}
    </div>
  )
}

/* The column's label, one row above the roster. It repeats a row's frame,
   padding and gap and the fixed widths right of the column (the role select
   and the remove button), so the label sits over every row's cell. Each
   checkbox names itself, so the label is hidden from assistive tech. */
export function ProjectRightHeader() {
  return (
    <div
      data-project-creators-header
      aria-hidden="true"
      className="-mb-0.5 flex items-end gap-2 px-[9px]"
    >
      <div className="min-w-0 flex-1" />
      <div className="w-[112px] shrink-0 text-center text-xs leading-none font-semibold text-text-2">
        Can create projects
      </div>
      <div className="w-[132px] shrink-0" />
      <div className="w-control-sm shrink-0" />
    </div>
  )
}

// Role and active status share one selector; deactivation removes access.
export function UserRoleSelect({
  user,
  isSelf,
  lastAdmin,
}: {
  user: UserVM
  isSelf: boolean
  lastAdmin: boolean
}) {
  const value = !user.active
    ? 'inactive'
    : user.orgRole === 'admin'
      ? 'admin'
      : user.orgRole === 'viewer'
        ? 'viewer'
        : 'user'
  // Agents can be viewers, but admin access would bypass project grants and
  // is refused by the server.
  const canBeAdmin = !user.isAgent
  const title = lastAdmin
    ? 'Add another organization admin before changing this role.'
    : isSelf
      ? 'You cannot deactivate your own account.'
      : user.isAgent
        ? 'Agents cannot be organization admins.'
        : undefined
  return (
    <NativeSelect
      data-user-role={user.id}
      aria-label={`Organization role for ${user.name}`}
      value={value}
      disabled={lastAdmin}
      title={title}
      onChange={(e) => {
        const v = e.target.value as UserPatch['orgRole'] | 'inactive'
        // The viewer guard refuses someone who leads a project or a team;
        // the toast names what to hand over first. Reactivation contributes
        // to the billable user count at the next monthly renewal.
        if (v === 'inactive') P.updateUser(user.id, { active: false })
        else P.updateUser(user.id, { orgRole: v, active: true })
      }}
      style={{ opacity: lastAdmin ? 0.55 : 1 }}
      className="h-control-sm w-[132px] shrink-0 bg-surface-1 text-sm font-sans"
    >
      {canBeAdmin && <option value="admin">Org admin</option>}
      <option value="user">Standard user</option>
      <option value="viewer">Viewer</option>
      {/* never offered on your own row: it takes effect at once and there is
          nobody left signed in to undo it */}
      {!isSelf && <option value="inactive">Inactive</option>}
    </NativeSelect>
  )
}
