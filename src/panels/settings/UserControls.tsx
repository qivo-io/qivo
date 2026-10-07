/* Roster identity, invitation address, role and weekly capacity controls. */
import React, { useEffect as useEffectS, useState as useStateS } from 'react'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { DEMO_MODE } from '../../lib/demoMode'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { DEFAULT_PLANNABLE_HOURS } from '../../lib/workload'
import type { UserPatch, UserVM } from '../../store/planner'
import { P } from '../../store/planner'

// Roster renames commit on blur and affect this organization only. Account
// name changes use the explicit-save field and update the login's other seats.
// Refusals restore the server value through the store.
export function UserName({ user, isSelf }: { user: UserVM; isSelf: boolean }) {
  const canEdit = P.isAdmin()
  const [v, setV] = useStateS(user.name)
  useUpdateBlocker(canEdit && v !== user.name)
  useEffectS(() => {
    setV(user.name)
  }, [user.name])
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
    const next = v.replace(/\s+/g, ' ').trim()
    if (next === user.name) {
      setV(user.name)
      return
    }
    if (!next || [...next].length > P.NAME_MAX) {
      setV(user.name)
      return
    }
    P.updateUser(user.id, { name: next })
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
    <div className="[display:flex] [align-items:center] [min-width:0]">
      <span
        ref={mirror}
        aria-hidden="true"
        style={{ ...nameFace }}
        className="[position:absolute] [visibility:hidden] [white-space:pre] [pointer-events:none]"
      >
        {v || ' '}
      </span>
      <Input
        value={v}
        onChange={(e) => setV(e.target.value)}
        data-user-name={user.id}
        aria-label={`Display name for ${user.name}`}
        maxLength={P.NAME_MAX}
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
            setV(user.name)
            e.currentTarget.blur()
          }
        }}
        style={{ ...nameFace, width: Math.min(320, w + 13) }}
        // quiet until hovered (a hairline), and the standard active field look
        // from tokens.css once it has focus — like every other text box
        className="h-control-sm min-w-0 flex-[0_1_auto] border-transparent bg-transparent px-[5px] py-0 text-ellipsis hover:border-border focus:bg-hover"
      />
      <span className="[font-size:var(--fs-base)] [font-weight:600] [white-space:nowrap]">
        {chips}
      </span>
    </div>
  )
}

// Only unclaimed invitations can change email. Claimed seats retain the
// login address; empty or invalid edits restore the saved value.
export function UserEmail({ user }: { user: UserVM }) {
  const canEdit = !DEMO_MODE && P.isAdmin() && user.pending
  const [v, setV] = useStateS(user.email || '')
  useUpdateBlocker(canEdit && v !== (user.email || ''))
  useEffectS(() => {
    setV(user.email || '')
  }, [user.email])
  const commit = () => {
    const next = v.trim()
    if (next === (user.email || '')) return
    if (!P.emailLooksValid(next)) {
      setV(user.email || '')
      return
    }
    P.updateUser(user.id, { email: next })
  }
  if (!canEdit) {
    return (
      <div
        data-user-email={user.id}
        className="[padding-left:6px] [font-size:var(--fs-xs)] [color:var(--text-2)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]"
      >
        {DEMO_MODE ? 'Fictional teammate' : user.email || 'no email address'}
        {user.pending && (
          <span className="[color:var(--warn)] [font-weight:700] [margin-left:6px] [font-size:var(--fs-xs)]">
            invited
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="[display:flex] [align-items:center] [gap:6px]">
      <Input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        data-user-email={user.id}
        aria-label={`Email address for ${user.name}`}
        type="email"
        spellCheck={false}
        autoCapitalize="off"
        placeholder="Email address"
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setV(user.email || '')
            e.currentTarget.blur()
          }
        }}
        className="h-control-xs min-w-0 flex-1 border-transparent bg-transparent px-[5px] py-0 font-sans text-sm text-text-1 hover:border-border focus:bg-hover"
      />
      <span className="[color:var(--warn)] [font-weight:700] [font-size:var(--fs-xs)] [flex-shrink:0]">
        invited
      </span>
    </div>
  )
}

// Capacity commits whole hours on blur (1–168); an empty or invalid edit
// restores the saved value. Team leaders may edit this field, not other profile data.
export function PlannableHoursInput({
  user,
  canEdit,
  width = 48,
}: {
  user: UserVM
  canEdit: boolean
  width?: number
}) {
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
  const stored = user.plannableHours || DEFAULT_PLANNABLE_HOURS
  const inputId = `plannable-hours-${user.id}`
  return (
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
          min={1}
          max={168}
          step={1}
          data-plannable-for={user.id}
          aria-label={`Plannable hours per week for ${user.name}`}
          key={`ph${user.id}${stored}`}
          defaultValue={stored}
          disabled={!canEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onBlur={(e) => {
            const raw = e.target.value.trim()
            if (!raw || !Number(raw)) {
              e.target.value = String(stored)
              return
            }
            const h = Math.max(1, Math.min(168, Math.round(Number(raw))))
            e.target.value = String(h)
            if (h === stored) return
            P.updateUser(user.id, { plannableHours: h })
            window.showToast?.(`${user.name} plans ${h} h per week`)
          }}
          style={{ width, opacity: canEdit ? 1 : 0.55 }}
          className="h-control-sm w-full bg-surface-1 px-1.5 text-right text-sm font-sans text-text-1"
        />
        h/wk
      </label>
    </HoverTooltip>
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
      className="h-control-sm w-[132px] shrink-0 bg-surface-1 px-1.5 text-sm font-sans"
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
