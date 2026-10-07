/* The Archive — a separate full-screen page (0070). Archived issues are not
   part of the working snapshot: nothing is fetched until this page opens, and
   then only ONE project's archive at a time (P.fetchArchived). Restoring goes
   through P.unarchiveIssue and re-fetches the list, because the server also
   restores the ancestor chain — rows other than the clicked one can leave. */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { Avatar, Icon } from '../components/qivo'
import { WorkspacePageHeader, WorkspaceShell } from '../components/WorkspaceShell'
import { type ArchivedIssueVM, type IssueVM, P } from '../store/planner'
import '../styles/settings-layout.css'
import { useMobile } from '../lib/useMobile'

function ArchivePage({
  initialProject,
  onExit,
}: {
  initialProject?: string | null
  onExit: () => void
}) {
  const mobile = useMobile()
  // groups: every visible project in the organization (navigation is flat
  // since 0078) — viewing the archive needs only visibility; restoring is
  // gated per row below
  const groups = P.visibleProjects().map((m) => ({
    meta: m,
    subs: (m.children || [])
      .map((c: string) => P.project(c))
      .filter((sp) => !!sp && P.canSee(sp.id)),
  }))
  const validInit =
    initialProject &&
    groups.some(
      (g) => g.meta.id === initialProject || g.subs.some((sp) => sp.id === initialProject),
    )
  const [project, setProject] = useState(validInit ? initialProject : '')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState(null as ArchivedIssueVM[] | null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reloadN, setReloadN] = useState(0)
  const [restoring, setRestoring] = useState(() => new Set<string>())
  const seqRef = useRef(0)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onExit()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onExit])

  useEffect(() => {
    if (!project) {
      setRows(null)
      setFailed(false)
      return
    }
    const seq = ++seqRef.current
    setLoading(true)
    setFailed(false)
    P.fetchArchived(project).then((r) => {
      if (seqRef.current !== seq) return // a newer selection owns the list
      setLoading(false)
      // a failed fetch must not masquerade as an authoritatively empty
      // archive — it gets its own state with a Retry
      if (!r) {
        setRows(null)
        setFailed(true)
        return
      }
      setRows(r)
    })
  }, [project, reloadN])

  const restore = (row: ArchivedIssueVM) => {
    if (restoring.has(row.uuid)) return // one restore per row until the list reloads
    setRestoring((s) => new Set(s).add(row.uuid))
    void P.unarchiveIssue(row.uuid, row.title, row.project).then((ok: boolean) => {
      if (!ok) {
        setRestoring((s) => {
          const n = new Set(s)
          n.delete(row.uuid)
          return n
        })
        return
      } // unarchiveIssue toasted
      window.showToast?.(`Restored ${row.key}`)
      setRestoring(() => new Set<string>())
      setReloadN((n) => n + 1) // ancestors may have been restored with it
    })
  }

  const q = mobile ? '' : search.trim()
  // archived rows are "shaped enough like snapshot issues for matchesSearch
  // to work on them" (the store's own contract on fetchArchived) — only the
  // signature names the snapshot shape, hence the assertion
  const visible = (rows || []).filter((r) => !q || P.matchesSearch(r as unknown as IssueVM, q))
  const projObj = project ? P.project(project) : null
  const back = (
    <Button
      type="button"
      variant="ghost"
      onClick={onExit}
      title="Back to the planner (esc)"
      className="w-full justify-start"
    >
      <Icon name="chevronLeft" size={16} />
      Back
    </Button>
  )

  return (
    <WorkspaceShell
      className="archive-shell"
      header={<WorkspacePageHeader label="Archive" icon="archive" />}
      navigation={<div className="planner-mobile-navigation archive-mobile-navigation">{back}</div>}
    >
      <aside className="archive-navigation" aria-label="Archive navigation">
        {back}
      </aside>
      <main data-archive-page data-screen-label="Archive" className="archive-main">
        <div className="archive-content-frame">
          <div className="archive-content-scroll">
            <div className="[font-size:var(--fs-base)] [color:var(--text-3)] [line-height:1.5] [margin-bottom:24px] [max-width:640px]">
              Done tasks auto-archive after the team's configured period. Restoring a task also
              restores its archived parent tasks.
            </div>

            <div className="[display:flex] [align-items:center] [gap:8px] [margin-bottom:8px] [flex-wrap:wrap]">
              <NativeSelect
                data-archive-project
                aria-label="Project archive"
                value={project}
                onChange={(e) => {
                  setSearch('')
                  setProject(e.target.value)
                }}
                className="[min-width:240px] [max-width:100%] [cursor:pointer]"
              >
                <option value="" disabled hidden>
                  Choose a project…
                </option>
                {groups.map((g) => (
                  <optgroup key={g.meta.id} label={g.meta.name}>
                    <option value={g.meta.id}>{g.meta.name} — whole project</option>
                    {g.subs.map((sp) => (
                      // native <option>s take no cross-browser padding — indent
                      // sub-projects under their "whole project" row with NBSPs,
                      // one visual step like options under an <optgroup> label
                      <option key={sp.id} value={sp.id}>
                        {'    '}
                        {sp.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
              {!mobile && (
                <div
                  data-archive-search-box
                  className="[display:flex] [align-items:center] [gap:8px] h-control [padding:0_8px] [background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-md)] [width:220px]"
                >
                  <Icon name="search" size={16} color="var(--text-3)" />
                  <Input
                    data-archive-search
                    aria-label="Filter archived tasks"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter archived tasks…"
                    disabled={!rows}
                    onKeyDown={(e) => {
                      // Escape clears a live filter first; only an empty field
                      // lets it bubble up to the page-level close
                      if (e.key === 'Escape' && search) {
                        e.stopPropagation()
                        setSearch('')
                      }
                    }}
                    className="h-full min-w-0 flex-1 rounded-none border-none bg-transparent p-0 text-base text-text-1 shadow-none focus-visible:ring-0"
                  />
                  {search && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0"
                      aria-label="Clear archive filter"
                      onClick={() => setSearch('')}
                    >
                      <Icon name="close" size={12} />
                    </Button>
                  )}
                </div>
              )}
              {rows && !loading && (
                <span
                  data-archive-count
                  className="[font-size:var(--fs-sm)] [color:var(--text-3)] !font-mono"
                >
                  {q ? `${visible.length} of ${rows.length}` : rows.length} archived
                </span>
              )}
            </div>

            {project && loading && (
              <div className="[font-size:var(--fs-base)] [color:var(--text-3)] [font-style:italic] [padding:18px_2px]">
                Loading archived tasks…
              </div>
            )}
            {project && !loading && failed && (
              <div className="[display:flex] [align-items:center] [gap:8px] [padding:18px_2px] [font-size:var(--fs-base)] [color:var(--text-2)]">
                Couldn't load the archive.
                <Button
                  type="button"
                  variant="ghost"
                  className="h-control-sm [font-size:var(--fs-sm)]"
                  onClick={() => setReloadN((n) => n + 1)}
                >
                  <Icon name="rotateCcw" size={16} />
                  Retry
                </Button>
              </div>
            )}
            {project && !loading && rows && rows.length === 0 && (
              <div className="[font-size:var(--fs-base)] [color:var(--text-3)] [font-style:italic] [padding:18px_2px]">
                No archived tasks in {projObj ? `“${projObj.name}”` : 'this project'}.
              </div>
            )}
            {project && !loading && rows && rows.length > 0 && visible.length === 0 && (
              <div className="[font-size:var(--fs-base)] [color:var(--text-3)] [font-style:italic] [padding:18px_2px]">
                No archived tasks match the filter.
              </div>
            )}

            <div className="[display:flex] [flex-direction:column] [gap:8px]">
              {!loading &&
                visible.map((r) => {
                  const st = P.statusOf(r.status) || { name: r.status, tone: 'var(--text-3)' }
                  const sp = P.project(r.project)
                  const canRestore = ['lead', 'user'].includes(P.levelOn(r.project) || '')
                  return (
                    <div
                      key={r.uuid}
                      data-archive-row
                      className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-lg)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
                    >
                      <span className="min-w-0 flex-1">
                        <HoverTooltip content={r.title}>
                          <span className="line-clamp-2 break-words text-base font-medium leading-[1.4]">
                            {r.title}
                          </span>
                        </HoverTooltip>
                        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
                          <span className="!font-mono">{r.key}</span>
                          {sp && <span className="max-w-36 truncate">{sp.name}</span>}
                          {!P.isGroup(r) && (
                            <span className="inline-flex items-center gap-1 font-semibold text-text-1">
                              <span
                                style={{ background: st.tone }}
                                className="size-[7px] shrink-0 rounded-full"
                              />
                              {st.name}
                            </span>
                          )}
                          <HoverTooltip content={new Date(r.archivedAt).toLocaleString()}>
                            <span className="!font-mono">archived {P.fmtAgo(r.archivedAt)}</span>
                          </HoverTooltip>
                        </span>
                      </span>
                      {r.owner && <Avatar id={r.owner} size={28} />}
                      {canRestore && (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-control-sm [font-size:var(--fs-sm)] [color:var(--text-1)] [flex-shrink:0]"
                          disabled={restoring.has(r.uuid)}
                          onClick={() => restore(r)}
                        >
                          <Icon name="rotateCcw" size={16} />
                          {restoring.has(r.uuid) ? 'Restoring…' : 'Restore'}
                        </Button>
                      )}
                    </div>
                  )
                })}
            </div>
          </div>
        </div>
      </main>
    </WorkspaceShell>
  )
}

export { ArchivePage }
