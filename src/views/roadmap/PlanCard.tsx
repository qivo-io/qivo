import { Button } from '@/components/ui/button'
import { Avatar, Icon } from '../../components/qivo'
import type { captureWeekDates } from '../../lib/weekDrafts'
import {
  hasPlannableWeek,
  type LoadItem,
  loadByProject,
  plannableHoursOf,
} from '../../lib/workload'
import { type IssueVM, P } from '../../store/planner'

/* a small on/off switch for the PlanCard's auto-fit control; the off track
   reads the palette's --switch-off, else --surface-3 */
function PlanSwitch({
  on,
  disabled,
  onClick,
}: {
  on: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      aria-label="Auto-fit"
      title={on ? 'Auto-fit is on' : 'Auto-fit is off'}
      style={{
        background: on ? 'var(--primary)' : 'var(--switch-off, var(--surface-3))',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
      className="[width:34px] [height:20px] [border-radius:var(--r-pill)] [border:none] [padding:0] [flex-shrink:0] [position:relative] [transition:background-color_var(--dur-fast)_var(--ease-out)]"
      variant="unstyled"
    >
      <span
        style={{ left: on ? 16 : 2 }}
        className="[position:absolute] [top:2px] [width:16px] [height:16px] [border-radius:50%] [background:#fff] [box-shadow:var(--qivo-shadow-card)] [transition:left_var(--dur-fast)_var(--ease-out)]"
      />
    </Button>
  )
}

// Roadmap owns this session. Load belongs to the effective owner and grid epoch.
export type PlanSession = {
  issueId: string
  autoFit: boolean
  fitOnLoad: boolean
  orig: ReturnType<typeof captureWeekDates>
  loadOwner: string | null
  loadEpoch: number
  load: LoadItem[] | null
  loading: boolean
}

// Confirm keeps the planned dates; Cancel restores the captured originals.
// Hidden-project workload remains in the anonymous Other projects bucket.
export function PlanCard({
  issue,
  session,
  onToggleAutoFit,
  onConfirm,
  onCancel,
}: {
  issue: IssueVM
  session: PlanSession
  onToggleAutoFit: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const scheduled = issue.start != null && issue.end != null
  const dur = scheduled ? issue.end - issue.start + 1 : 0
  const owner = issue.owner ? P.user(issue.owner) : null
  // Parents use their subtask envelope; only leaf hours can auto-fit.
  const remaining = issue.remaining || 0
  const isParent = P.isGroup(issue)
  const shownRem = P.remainingOf(issue) || 0 // parents display the sub-issue sum
  const canFit = !isParent && !!owner && remaining > 0
  const first = owner ? owner.name.split(' ')[0] : ''
  // Match auto-fit: weeks before the measurement anchor cannot dilute load.
  const fitStart =
    scheduled && issue.remainingSet != null
      ? Math.max(issue.start, issue.remainingSet)
      : issue.start
  const fitDur = scheduled ? Math.max(1, issue.end - fitStart + 1) : 0
  const loadCurrent =
    session.loadOwner === (issue.owner ?? null) && session.loadEpoch === P.gridEpoch
  const loading = session.loading || !loadCurrent
  const buckets =
    loadCurrent && session.load && scheduled
      ? loadByProject(session.load, fitStart, issue.end, issue.uuid)
      : []
  const committedInWindow = buckets.reduce((s, b) => s + b.hours, 0)
  // Use the same owner for capacity and existing commitments.
  const cap = plannableHoursOf(owner)
  // Agents have no bounded capacity; auto-fit ends in the starting week.
  const bounded = hasPlannableWeek(cap)
  const freePerWk = scheduled ? Math.max(0, cap - committedInWindow / fitDur) : cap
  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 [position:fixed] [right:20px] [bottom:20px] [width:344px] [max-width:calc(100vw-40px)] [max-height:calc(100vh-40px)] [overflow-y:auto] [z-index:60] [background:var(--surface-2)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [box-shadow:var(--qivo-shadow-pop)] [display:flex] [flex-direction:column] [overflow-x:hidden]"
      data-plan-card={issue.id}
    >
      <div className="[display:flex] [align-items:center] [gap:8px] [padding:20px] [border-bottom:1px_solid_var(--border)]">
        <div className="[flex:1] [min-width:0]">
          <div className="[font-size:var(--fs-xs)] !font-mono [color:var(--text-3)]">
            {issue.key}, Plan on roadmap
          </div>
          <div className="[font-size:var(--fs-md)] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
            {issue.title}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="w-control-sm h-control-sm"
          aria-label="Cancel and restore the original dates"
          title="Cancel and restore the original dates"
          onClick={onCancel}
        >
          <Icon name="close" size={16} />
        </Button>
      </div>

      <div className="[padding:20px] [display:flex] [flex-direction:column] [gap:24px]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-base">
          <div className="flex min-w-0 items-center gap-2">
            {owner ? (
              <>
                <Avatar id={owner.id} size={28} />
                <span className="min-w-0 break-words font-medium text-text-1">{owner.name}</span>
              </>
            ) : (
              <span className="[color:var(--text-3)] [font-style:italic]">Unassigned</span>
            )}
          </div>
          <span className="ml-auto whitespace-nowrap !font-mono text-xs text-text-3">
            {scheduled
              ? P.fmtDate(P.weekToDate(issue.start)) +
                ' → ' +
                P.fmtDate(P.weekToDate(issue.end)) +
                ', ' +
                dur +
                'w'
              : '—'}
            {shownRem > 0 ? `, ${isParent ? 'Σ ' : ''}${shownRem}h` : ''}
          </span>
        </div>

        <div className="[display:flex] [align-items:center] [gap:8px]">
          <PlanSwitch on={session.autoFit && canFit} disabled={!canFit} onClick={onToggleAutoFit} />
          <div className="[flex:1] [min-width:0]">
            <div
              style={{ color: canFit ? 'var(--text-1)' : 'var(--text-3)' }}
              className="[font-size:var(--fs-sm)] [font-weight:500]"
            >
              Auto-fit end to workload
            </div>
            <div className="[font-size:var(--fs-xs)] [color:var(--text-3)]">
              {isParent
                ? 'Plan the subtasks; the parent follows their dates'
                : !owner
                  ? 'Assign someone to auto-fit'
                  : remaining <= 0
                    ? 'Add remaining time to auto-fit'
                    : session.autoFit
                      ? `End follows ${first}’s free time on drop`
                      : 'Drag the end freely'}
            </div>
          </div>
        </div>

        {canFit && (
          <div className="[border-top:1px_solid_var(--border)] [padding-top:24px] [display:flex] [flex-direction:column] [gap:8px]">
            <div className="text-md font-semibold text-text-1">{first}’s load in this window</div>
            {loading ? (
              <div className="[font-size:var(--fs-sm)] [color:var(--text-3)]">Loading…</div>
            ) : !session.load ? (
              <div className="text-sm text-text-3">
                Workload is unavailable. Auto-fit is paused.
              </div>
            ) : buckets.length === 0 ? (
              <div className="[font-size:var(--fs-sm)] [color:var(--text-3)]">
                No other planned work in this window.
              </div>
            ) : (
              buckets.map((b) => (
                <div
                  // one bucket per project id; the "Other projects" bucket is the
                  // only one without an id, and there is never more than one
                  key={b.projectId ?? 'other'}
                  className="[display:flex] [align-items:center] [gap:8px] [font-size:var(--fs-sm)]"
                >
                  <span className="[width:8px] [height:8px] [border-radius:var(--r-2xs)] [flex-shrink:0] [background:var(--text-3)]" />
                  <span
                    style={{
                      color: b.other ? 'var(--text-2)' : 'var(--text-1)',
                      fontStyle: b.other ? 'italic' : 'normal',
                    }}
                    className="[flex:1] [min-width:0] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]"
                  >
                    {b.name}
                  </span>
                  <span className="!font-mono text-text-1">{Math.round(b.hours)}h</span>
                </div>
              ))
            )}
            <div className="[font-size:var(--fs-xs)] [color:var(--text-3)] [margin-top:2px]">
              {loading
                ? 'Checking available time…'
                : !session.load
                  ? 'Reopen planning to try again.'
                  : bounded
                    ? '~' +
                      Math.round(freePerWk) +
                      'h/wk free of ' +
                      first +
                      '’s ' +
                      Math.round(cap) +
                      'h plannable'
                    : 'No weekly capacity limit for auto-fit'}
            </div>
          </div>
        )}
      </div>

      <div className="[display:flex] [gap:8px] [padding:16px_20px] [border-top:1px_solid_var(--border)]">
        <Button
          type="button"
          variant="ghost"
          className="[flex:1] [justify-content:center]"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="[flex:1] [justify-content:center] [background:var(--primary)] [border-color:var(--primary)] [color:#fff] [font-weight:600]"
          onClick={onConfirm}
        >
          <Icon name="check" size={16} />
          Confirm
        </Button>
      </div>
    </div>
  )
}
