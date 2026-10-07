/* Weekly remaining-time review across visible open, owned leaf tasks.
   Review tasks belong to their reviewer when set. Edits save on blur/Enter;
   close flushes the focused input. Reviewed ticks are session-local, and rows
   re-derive from the store so remote changes update owners and counts. */
import { useState as useStateU } from 'react'
import { Avatar, IssueKey, StatusDot } from '../components/qivo'
import {
  flushWalkInput,
  planHint,
  RemainingInput,
  ReviewTick,
  rowOrder,
  useReviewed,
  WalkFooter,
  WalkRail,
} from '../components/walk'
import { type IssueVM, P } from '../store/planner'
import { ModalShell } from './Modals'

const OPEN_STATUSES = new Set(['todo', 'progress', 'review'])

function UpdateEstimateModal({ onClose }: { onClose: () => void }) {
  // The server-scoped store contains only tasks the viewer can access.
  const scoped = P.issues.filter((it) => {
    if (!OPEN_STATUSES.has(it.status) || !it.owner) return false
    if (P.isGroup(it)) return false
    return true
  })
  const byOwner = new Map<string, IssueVM[]>()
  scoped.forEach((it) => {
    const l = byOwner.get(it.owner) || []
    l.push(it)
    byOwner.set(it.owner, l)
  })
  // person list: owners of ≥1 in-scope issue, alphabetical (the team
  // strip's sort); users with nothing open are skipped
  const people = P.users
    .filter((u) => byOwner.has(u.id))
    .sort((a, b) => a.name.localeCompare(b.name))

  // current person by id, with the last index as the fallback when a remote
  // edit removes them from the walk mid-session
  const [cur, setCur] = useStateU({ id: null as string | null, idx: 0 })
  let idx = people.findIndex((u) => u.id === cur.id)
  if (idx < 0) idx = Math.min(cur.idx, Math.max(0, people.length - 1))
  const person = people[idx] || null
  const goto = (i: number) => setCur({ id: people[i].id, idx: i })

  // reviewed = edited, or explicitly confirmed unchanged — session-local,
  // keyed by uuid; counts intersect the LIVE scope so they adjust when an
  // issue leaves the walk. An edit ticks its row (walk.tsx RemainingInput
  // writes nothing for a bare tab-through, so that earns no ✓).
  const reviewed = useReviewed()
  const allDone = (uid: string) => (byOwner.get(uid) || []).every((it) => reviewed.has(it.uuid))

  /* Escape and the scrim close the shell without the browser ever moving
     focus, and React fires no blur on unmount — a typed-but-uncommitted
     number would vanish. Flush the focused input first so "closing mid-walk
     never loses anything" holds on every path, not just the ones that
     happen to blur (the X button, Done, clicking another row). */
  const close = () => {
    flushWalkInput('ue')
    onClose()
  }

  const rows = person ? (byOwner.get(person.id) || []).slice().sort(rowOrder) : []
  const last = idx >= people.length - 1

  const footer = (
    <WalkFooter
      hook="ue"
      reviewed={reviewed.count(scoped)}
      total={scoped.length}
      showPrev={people.length > 0}
      atStart={idx === 0}
      last={last || !people.length}
      onPrev={() => goto(idx - 1)}
      onNext={() => (last || !people.length ? close() : goto(idx + 1))}
    />
  )

  return (
    <ModalShell icon="history" title="Update Estimate" onClose={close} width={640} footer={footer}>
      <div data-update-estimate>
        <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [margin-bottom:24px]">
          To Do, In Progress and In Review. All visible projects.
        </div>

        {people.length === 0 ? (
          <div
            data-ue-empty
            className="[padding:28px_0_34px] [text-align:center] [color:var(--text-3)] [font-size:var(--fs-base)]"
          >
            No open assigned tasks to review.
          </div>
        ) : (
          <>
            <div className="[display:flex] [align-items:center] [gap:8px] [margin-bottom:24px]">
              <Avatar id={person.id} size={40} />
              <div data-ue-person className="[font-size:var(--fs-base)] [font-weight:600]">
                {person.name}
                <span className="[font-weight:400] [color:var(--text-3)] [margin-left:8px] [font-size:var(--fs-sm)]">
                  ({idx + 1} of {people.length})
                </span>
              </div>
              <div className="[flex:1]" />
              {/* person rail — jump anywhere; a check marks everyone whose rows are all ✓ */}
              <WalkRail
                hook="ue"
                people={people}
                isCurrent={(id) => id === person.id}
                allDone={allDone}
                onPick={(_, i) => goto(i)}
                label={(name) => `Review ${name}'s estimates`}
              />
            </div>

            <div className="[border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [overflow:hidden] [margin-bottom:0]">
              {/* the FIELD stays "Remaining" everywhere (deviation #21) —
                  "Update Estimate" names the ritual, not the column */}
              {/* Match the rows below with --surface-1; their border separates
                  the header without introducing another neutral fill. */}
              <div className="grid grid-cols-[minmax(0,1fr)_64px_8px_32px] items-center gap-2 p-2 bg-surface-1 text-sm font-semibold text-text-1">
                <span className="[flex:1]">Task</span>
                <span>Remaining</span>
              </div>
              {rows.map((it) => {
                const st = P.statusOf(it.status)
                const hint = planHint(it)
                const proj = P.project(it.project)
                return (
                  <div
                    key={it.uuid}
                    data-ue-row={it.id}
                    className="grid grid-cols-[minmax(0,1fr)_64px_8px_32px] items-center gap-2 p-2 border-t border-border bg-surface-1"
                  >
                    <div className="[flex:1] [min-width:0]">
                      <div className="[display:flex] [align-items:center] [gap:8px] [min-width:0]">
                        <IssueKey id={it.key} />
                        {/* rows don't open the issue — this window is deliberately single-purpose */}
                        <span className="[font-size:var(--fs-base)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                          {it.title}
                        </span>
                      </div>
                      <div className="[display:flex] [align-items:center] [gap:8px] [margin-top:4px] [font-size:var(--fs-xs)] [color:var(--text-3)]">
                        <span className="[overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                          {proj ? proj.name : '—'},
                        </span>
                        <StatusDot status={it.status} size={11} />
                        <span>
                          {st ? st.name : it.status}
                          {hint ? ',' : ''}
                        </span>
                        {hint && <span className="!font-mono [white-space:nowrap]">{hint}</span>}
                      </div>
                    </div>
                    <RemainingInput
                      hook="ue"
                      it={it}
                      title="Remaining hours — empty means unset"
                      onCommit={(x) => reviewed.mark(x.uuid)}
                    />
                    <span className="[font-size:var(--fs-sm)] [color:var(--text-3)] [flex-shrink:0]">
                      h
                    </span>
                    <ReviewTick
                      hook="ue"
                      it={it}
                      on={reviewed.has(it.uuid)}
                      onToggle={() => reviewed.toggle(it.uuid)}
                    />
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </ModalShell>
  )
}

export { UpdateEstimateModal }
