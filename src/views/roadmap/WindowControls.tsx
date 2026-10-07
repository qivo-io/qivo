import { useState as useStateR } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AnchoredPop, DateInput, Icon, MenuItem, Seg } from '../../components/qivo'
import type { RoadmapWin, WinEndpoint } from '../../lib/dates'
import { P } from '../../store/planner'

// Preset widths; Custom range supports any valid pair of endpoints.
const SPANS = [
  { n: 4, label: '4 weeks', note: 'a month' },
  { n: 8, label: '8 weeks', note: 'two months' },
  { n: 13, label: '13 weeks', note: 'a quarter' },
  { n: 26, label: '26 weeks', note: 'half a year' },
  { n: 52, label: '52 weeks', note: 'a year' },
]

/* two-tab endpoint field: relative weeks (follows today) or an exact date.
   One END of the window; the range picker below stacks two of them. */
function EndpointFields({
  which,
  ep,
  onApply,
}: {
  which: 'start' | 'end'
  ep: WinEndpoint
  onApply: (ep: WinEndpoint) => void
}) {
  const [tab, setTab] = useStateR(ep.mode === 'date' ? 'date' : 'weeks')
  const resolved = P.endpointWeek(ep)
  const [wv, setWv] = useStateR<number | ''>(
    ep.mode === 'weeks' ? ep.value : resolved - P.TODAY_WEEK,
  )
  const [dv, setDv] = useStateR(
    ep.mode === 'date' ? ep.value : P.isoFromDate(P.weekToDate(resolved)),
  )
  const applyWeeks = (n: number | '') => {
    setWv(n)
    if (n !== '' && Number.isFinite(Number(n)))
      onApply({ mode: 'weeks', value: Math.round(Number(n)) })
  }
  const applyDate = (s: string) => {
    if (s) {
      setDv(s)
      onApply({ mode: 'date', value: s })
    }
  }
  const wNum = Number(wv) || 0
  // a control inside a --surface-2 popover takes the --surface-3 step, matching
  // the Seg it sits under — on its own ground it would read as border alone
  return (
    <div data-win-endpoint={which} className="[display:flex] [flex-direction:column] [gap:8px]">
      <div className="text-md font-semibold text-text-1">
        Window {which === 'start' ? 'start' : 'end'}
      </div>
      {/* the one Seg that is NOT on the page: this picker is a --surface-2
          popover, where --surface-3 is the recess rather than a lit slab */}
      <Seg
        value={tab}
        ground="raised"
        onChange={(t) => {
          setTab(t)
          if (t === 'weeks') applyWeeks(wv)
          else applyDate(dv)
        }}
        options={[
          { value: 'weeks', label: 'Relative weeks' },
          { value: 'date', label: 'Exact date' },
        ]}
      />
      {tab === 'weeks' ? (
        <>
          <div className="[display:flex] [align-items:center] [gap:8px]">
            <Button
              type="button"
              className="grid size-control-sm cursor-pointer place-items-center rounded-sm border border-border bg-surface-3 p-0 text-md text-text-2"
              onClick={() => applyWeeks(wNum - 1)}
              aria-label="One week earlier"
              title="One week earlier"
              variant="unstyled"
            >
              −
            </Button>
            <Input
              type="number"
              value={wv}
              data-win-weeks={which}
              onChange={(e) => applyWeeks(e.target.value === '' ? '' : Number(e.target.value))}
              className="h-control-sm w-15 bg-surface-3 px-2 py-0 text-base !font-mono"
            />
            <Button
              type="button"
              className="grid size-control-sm cursor-pointer place-items-center rounded-sm border border-border bg-surface-3 p-0 text-md text-text-2"
              onClick={() => applyWeeks(wNum + 1)}
              aria-label="One week later"
              title="One week later"
              variant="unstyled"
            >
              +
            </Button>
            <span className="[font-size:var(--fs-sm)] [color:var(--text-2)]">weeks from today</span>
          </div>
          <div className="[font-size:var(--fs-xs)] [color:var(--text-3)] [line-height:1.5]">
            Week of {P.fmtFull(P.weekToDate(P.TODAY_WEEK + wNum))}. Moves with the current week.
          </div>
        </>
      ) : (
        <>
          <DateInput
            value={dv}
            onChange={(s) => applyDate(s)}
            clearable={false}
            className="[align-self:flex-start]"
          />
          <div className="[font-size:var(--fs-xs)] [color:var(--text-3)] [line-height:1.5]">
            Fixed to the week of {P.fmtFull(P.weekToDate(P.isoToWeek(dv)))}.
          </div>
        </>
      )}
    </div>
  )
}

// Edit both relative-or-pinned endpoints together.
export function WinRangePicker({
  x,
  y,
  win,
  onApply,
  onClose,
}: {
  x: number
  y: number
  win: RoadmapWin
  onApply: (win: RoadmapWin) => void
  onClose: () => void
}) {
  return (
    // stayOnScroll: applying a shrink can clamp the pane's scrollLeft, and that
    // scroll event must not dismiss the picker mid-use
    <AnchoredPop x={x} y={y} width={344} onClose={onClose} stayOnScroll>
      <div
        data-win-picker
        className="[padding:20px] [display:flex] [flex-direction:column] [gap:24px]"
      >
        <EndpointFields
          which="start"
          ep={win.start}
          onApply={(ep) => onApply({ ...win, start: ep })}
        />
        <div className="[height:1px] [background:var(--border)]" />
        <EndpointFields which="end" ep={win.end} onApply={(ep) => onApply({ ...win, end: ep })} />
      </div>
    </AnchoredPop>
  )
}

// Save while away from the default; forget a custom default while viewing it.
// The stock default has nothing to forget, so that action is disabled there.
export function WinMenu({
  x,
  y,
  span,
  isDefault,
  defaultWin,
  defaultIsStock,
  onSpan,
  onDefault,
  onSaveDefault,
  onForgetDefault,
  onCustom,
  onClose,
}: {
  x: number
  y: number
  span: number
  isDefault: boolean
  defaultWin: RoadmapWin
  defaultIsStock: boolean
  onSpan: (n: number) => void
  onDefault: () => void
  onSaveDefault: () => void
  onForgetDefault: () => void
  onCustom: () => void
  onClose: () => void
}) {
  const canForget = isDefault && !defaultIsStock
  const canSave = !isDefault
  return (
    <AnchoredPop x={x} y={y} width={244} onClose={onClose} stayOnScroll>
      <div data-win-menu className="[padding:5px]">
        <div className="[padding:6px_9px_4px] [font-size:var(--fs-xs)] [font-weight:600] [color:var(--text-3)]">
          Weeks in view
        </div>
        {SPANS.map((s) => (
          <MenuItem
            key={s.n}
            data-win-span={s.n}
            active={span === s.n}
            onClick={() => {
              onSpan(s.n)
              onClose()
            }}
          >
            {s.label}
            <span className="[margin-left:auto] !font-mono [font-size:var(--fs-xs)] [color:var(--text-3)]">
              {s.note}
            </span>
          </MenuItem>
        ))}
        <div className="[height:1px] [background:var(--border)] [margin:5px_0]" />
        {/* the same act as the ⟲ beside the glyph, named. The glyph is the
            one-press version and only appears when there is something to
            undo; this row says what it does — and what it would go BACK to,
            which stopped being a constant the moment the default became
            yours to set. */}
        <MenuItem
          data-win-default
          disabled={isDefault}
          onClick={() => {
            if (!isDefault) {
              onDefault()
              onClose()
            }
          }}
        >
          <Icon name="rotateCcw" size={16} />
          Default window
          <span className="[margin-left:auto] !font-mono [font-size:var(--fs-xs)] [color:var(--text-3)]">
            {P.winLabel(defaultWin)}
          </span>
        </MenuItem>
        <MenuItem
          data-win-set-default={canForget ? 'forget' : 'save'}
          disabled={!canSave && !canForget}
          title={canForget ? `Restore the standard range: ${P.winLabel(P.DEFAULT_WIN)}` : undefined}
          onClick={() => {
            if (canForget) {
              onForgetDefault()
              onClose()
            } else if (canSave) {
              onSaveDefault()
              onClose()
            }
          }}
        >
          <Icon name="flag" size={14} />
          {canForget ? 'Forget my default' : 'Save this as my default'}
          {canForget && (
            <span className="[margin-left:auto] !font-mono [font-size:var(--fs-xs)] [color:var(--text-3)]">
              {P.winLabel(P.DEFAULT_WIN)}
            </span>
          )}
        </MenuItem>
        <div className="[height:1px] [background:var(--border)] [margin:5px_0]" />
        <MenuItem data-win-custom onClick={onCustom}>
          <Icon name="calendar" size={16} />
          Custom range…
        </MenuItem>
      </div>
    </AnchoredPop>
  )
}
