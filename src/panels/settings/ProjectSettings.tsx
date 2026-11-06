/* A project's Settings page. It reads the project, its parent, its lead
   and every right from the server (projectSettings.get,
   useProjectSettings), its access lists and pickers too
   (components/ProjectAccessEditor.tsx), and a top-level project's live
   sub-projects as Settings › Projects lists them (ProjectLists.tsx), and
   sends every write with what it showed, so it works the same for a
   project the workspace does not hold, whose address then names it by its
   uuid (lib/router.ts noteProjectPage). It reads the workspace only for
   the names the removal window and the Archive or delete window give, and
   the avatars. */
import React, { useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { LIMITS } from '../../../convex/lib/limits'
import { roundReviewHours } from '../../../convex/lib/review'
import type { NavChildRow } from '../../../convex/model/projectNavReads'
import { LeadPicker, ProjectAccessEditor } from '../../components/ProjectAccessEditor'
import { Icon } from '../../components/qivo'
import {
  FieldHint,
  PageTitle,
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '../../components/settingsPage'
import { DEMO_MODE } from '../../lib/demoMode'
import { limitSentence, sentence } from '../../lib/fieldLimits'
import { focusAround } from '../../lib/focusWhenGone'
import { useUnsaved } from '../../lib/leaveGuard'
import { listEnd } from '../../lib/pagedList'
import { noteProjectPage } from '../../lib/router'
import { REVIEW_HOURS, useSavedDraft } from '../../lib/savedDraft'
import { useUpdateBlocker } from '../../lib/updateSafety'
import type { AccessLevel } from '../../store/planner'
import { grantRemoval, P } from '../../store/planner'
import { ArchiveOrDeleteProjectModal } from '../Modals'
import { useAccessRemoval } from '../useAccessRemoval'
import { BackLink, DemoCapabilityNotice, DraftConflictLine, TextField, Toggle } from './controls'
import { BatchNotes, SubProjectsEnd, TaggedName } from './ProjectLists'
import { tagsOf, useLoadMore, useSubProjects } from './projectListReads'
import { InviteOutcome } from './UserControls'
import { type ProjectSettingsRead, type SettingsOk, useProjectSettings } from './useProjectSettings'

/** What the Archive or delete window holds of the project it opened with,
    from the page's answer. */
type RemovalShown = {
  id: string
  name: string
  type: SettingsOk['project']['type']
  orgId: string
  parent: string | null
}

export function ProjectPage({
  projectId,
  read: given,
  setPage,
  onBackPage = setPage,
  onProjectGone,
  onHolding,
}: {
  projectId: string
  /** the read of the project's settings that Settings holds for this page
      (useProjectSettings), so Try again subscribes afresh; a page rendered
      on its own reads its own */
  read?: ProjectSettingsRead
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
  onProjectGone?: (parent: string | null) => void
  /** told the project's id while its Archive or delete window is open, and
      null once the person closes it. The page stays while the window is
      open, also once the project left the board, so the window keeps what
      was typed in it. The delivery that drops the project usually lands
      before its own delete's answer. After its own archive or delete the
      window closes and the page moves on, and the hold stays until the page
      changes (Settings.tsx), because a move waits while the window's typed
      text lets go (lib/discardQuestion.ts closeOrAsk). */
  onHolding?: (projectId: string | null) => void
}) {
  /* The page reads its project, its parent, its lead and every right from
     the server, and shows nothing of the project until that answer comes
     (useProjectSettings). It keeps one watch of that read: a second one
     beside Settings' would join the subscription Settings holds, so its
     Try again would read back the failure Convex stored and never ask the
     server again. */
  const own = useProjectSettings(given ? null : projectId)
  const read = given ?? own
  /* The Archive or delete window, from the section at the end of the page.
     It holds the project as it was when the window opened, so it stays up
     when the project leaves, whether by a delete it sent before the
     server's answer, a refused one or someone else's change. It is the
     page's last child with or without the project, so React keeps the same
     window, still deleting, until that answer closes it. */
  const [removing, setRemovingState] = useStateS<RemovalShown | null>(null)
  const setRemoving = (shown: RemovalShown | null) => {
    setRemovingState(shown)
    onHolding?.(shown ? shown.id : null)
  }
  const removeButton = React.useRef<HTMLButtonElement>(null)
  const gone = read.state === 'unavailable' || read.state === 'archived'
  const removalWindow = (shown: RemovalShown) => {
    const showing = { orgId: shown.orgId }
    // Archiving lands on the Archived projects page rather than back on the
    // list, because the page that can take it back is where you should be
    // standing when the toast appears.
    const archive = () => {
      // a paused archive keeps the window open
      if (P.refusePausedEdit()) return
      // the hold stays until the page moves (onHolding)
      setRemovingState(null)
      P.archiveProject(shown.id, showing)
      window.showToast?.(`Archived “${shown.name}”`)
      onProjectGone?.(shown.parent)
      setPage('projects-archived')
    }
    // the window waits for the server, so a refusal leaves it open
    const del = async (reason: string) => {
      const parent = shown.parent
      if (!(await P.removeProject(shown.id, reason, showing))) return false
      setRemovingState(null)
      window.showToast?.(`Deleted “${shown.name}”`)
      onProjectGone?.(parent)
      // a sub-project falls back to its project while the workspace holds
      // it; a project back to the list it was opened from (never to some
      // other project the caller may not see)
      if (parent && P.project(parent)) setPage(`project:${parent}`)
      else setPage('projects')
      return true
    }
    return (
      <ArchiveOrDeleteProjectModal
        project={shown}
        gone={gone}
        onClose={() => setRemoving(null)}
        onArchive={archive}
        onDelete={del}
        focusAfterClose={() => removeButton.current}
      />
    )
  }
  const answer = read.answer
  /* The address names a project the workspace does not hold by its uuid
     under the organization this read found it in, so a reload, Back and
     Forward open it again (lib/router.ts noteProjectPage). The note stays
     as it was while the Archive or delete window is open, so the address
     under the window does not change. A project the workspace does not
     hold keeps its uuid there, and a held one that leaves meanwhile keeps
     its number until the window closes. */
  const unheldIn = answer && !gone && !P.project(answer.project.id) ? answer.project.org_id : null
  const holding = removing !== null
  React.useEffect(() => {
    if (answer && !holding) noteProjectPage(answer.project.id, unheldIn ? { org: unheldIn } : null)
  }, [answer?.project.id, unheldIn, holding])
  return (
    <div
      data-project-settings-state={read.state}
      aria-busy={read.state === 'loading' || read.state === 'refreshing' || undefined}
      className="contents"
    >
      <ProjectPageTitle answer={answer} onBackPage={onBackPage} />
      {answer ? (
        <ProjectSettingsFields
          answer={answer}
          read={read}
          setPage={setPage}
          removeButton={removeButton}
          onRemove={() =>
            setRemoving({
              id: answer.project.id,
              name: answer.project.name,
              type: answer.project.type,
              orgId: answer.project.org_id,
              parent: answer.parent?.id ?? null,
            })
          }
        />
      ) : (
        <SettingsFrame read={read} />
      )}
      {removing && removalWindow(removing)}
    </div>
  )
}

/* A project page's Back link and title. Until the first answer they read
   Projects and "Project settings"; then the title names the project, and
   a sub-project's Back goes to the project above it, where the delete
   also goes while the workspace holds that project. The heading stays one
   element through both, so the focus Settings gives it as it opens the
   page by keyboard stays once the fields come. */
function ProjectPageTitle({
  answer,
  onBackPage,
}: {
  answer: SettingsOk | null
  onBackPage: (page: string) => void
}) {
  const parent = answer?.parent ?? null
  const isMeta = answer?.project.type === 'meta'
  return (
    <>
      <BackLink
        to={parent ? parent.name : 'Projects'}
        onClick={() => onBackPage(parent ? `project:${parent.id}` : 'projects')}
      />
      <PageTitle
        sub={
          answer && !isMeta ? 'Controlled by its own lead; permissions can be shared.' : undefined
        }
      >
        {answer ? (
          <>
            {answer.project.name}
            <span className="[font-size:var(--fs-sm)] [font-weight:500] [color:var(--text-2)] [margin-left:10px]">
              {isMeta ? 'Project' : 'Sub-project'}
            </span>
          </>
        ) : (
          'Project settings'
        )}
      </PageTitle>
    </>
  )
}

/* A project page before its first answer, after a failure without one, or
   for a project the server no longer shows: one line under the title, and
   no field, right or list. */
function SettingsFrame({ read }: { read: ProjectSettingsRead }) {
  if (read.state === 'failed')
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-base text-text-2">
        Couldn't load project settings.
        <Button type="button" size="sm" onClick={read.retry}>
          Try again
        </Button>
      </div>
    )
  return (
    <p role="status" className="text-base text-text-2">
      {read.state === 'loading' || read.state === 'refreshing'
        ? 'Loading project settings…'
        : 'This project is no longer available.'}
    </p>
  )
}

/** Where focus goes once the access of team or user `id` may have left the
    access editor: that row's Remove while it is listed, as after Change to
    Viewer, else the next row's in its list, the previous row's, the list's
    empty line or the Add picker. Call it as the removal starts. */
function focusAfterAccessRemoval(kind: 'team' | 'user', id: string) {
  return focusAround(
    `data-project-access-${kind}`,
    id,
    (row) => row.querySelector<HTMLElement>('[data-project-access-remove]:not(:disabled)'),
    () =>
      document.querySelector<HTMLElement>(`[data-project-access-none="${kind}"]`) ??
      document.querySelector<HTMLElement>('[data-project-access-picker]'),
  )
}

/** A project's settings sections from the server's answer, for
    ProjectPage, which owns the Archive or delete window that `onRemove`
    opens and gives focus back to `removeButton`. Every right comes from the
    answer. While the answer is not current after a failure, or the project
    has gone, every control of the page that writes is off, and a typed text
    stays. A removal window or the Archive or delete window that is already
    open acts on its own server preview, and the server checks each of its
    writes again. */
function ProjectSettingsFields({
  answer,
  read,
  setPage,
  removeButton,
  onRemove,
}: {
  answer: SettingsOk
  read: ProjectSettingsRead
  setPage: (page: string) => void
  removeButton: React.RefObject<HTMLButtonElement | null>
  onRemove: () => void
}) {
  const { project } = answer
  const shown = { orgId: project.org_id }
  // after a failure, Try again's wait included, or for a project that
  // left, no control of the page writes until an answer is current again
  const gone = read.state === 'unavailable' || read.state === 'archived'
  const blocked = read.afterFailure || gone
  const [grantRole, setGrantRole] = useStateS<AccessLevel>('user')
  /* Removing a grant asks the server which open tasks it would take out of
     someone's sight, and when some, whether to keep them as Viewers or
     reassign their tasks (useAccessRemoval). Focus then goes to the target
     taken as the press starts (focusAfterAccessRemoval). */
  const removal = useAccessRemoval()
  // the choice controls' values on their way to the server: they keep no
  // draft (row 373), and show what was chosen until the write is answered
  const [delayChosen, setDelayChosen] = useStateS<boolean | null>(null)
  const [leadChosen, setLeadChosen] = useStateS<{ id: string; name: string } | null>(null)
  const accessHeading = React.useRef<HTMLDivElement>(null)
  const isMeta = project.type === 'meta'
  // a top-level project lists its live sub-projects from the server, held
  // by the workspace or not; a legacy project of type meta under another
  // has none to list (convex/lib/access.ts inMetaTree)
  const topLevel = isMeta && answer.parent === null
  const subs = useSubProjects(topLevel ? { org: project.org_id, project: project.id } : null)
  const subsEnd = listEnd(subs, false)
  // the archive sentence counts only a list read to its real end
  const subCount = subsEnd === 'end' ? subs.rows.length : null
  const subsMore = useLoadMore(
    subs,
    subsEnd,
    (id) => document.querySelector<HTMLElement>(`[data-project-subproject="${id}"]`),
    () => accessHeading.current,
  )
  const subTags = tagsOf(
    project.org_id,
    subs.rows.map((r) => ({ ...r, parent: project.id })),
  )
  const trackDelay = delayChosen ?? project.track_delay
  const lead = leadChosen ?? (answer.lead ? { id: answer.lead.id, name: answer.lead.name } : null)
  const grant = (kind: 'team' | 'user', id: string) =>
    grantRemoval(kind, project.id, id, project.org_id, isMeta)
  return (
    <>
      {read.afterFailure && !gone && (
        <div
          role="alert"
          data-project-settings-failed=""
          className="mb-6 flex flex-wrap items-center gap-3 text-base text-danger"
        >
          Couldn't load project settings. Changes are off until they load.
          <Button type="button" size="sm" onClick={read.retry}>
            Try again
          </Button>
        </div>
      )}

      <Button
        variant="outline"
        className="settings-mobile-people-jump"
        onClick={() => {
          accessHeading.current?.scrollIntoView({ block: 'start' })
          accessHeading.current?.focus({ preventScroll: true })
        }}
      >
        <Icon name="people" size={16} />
        {answer.can_manage_users ? 'Manage people' : 'View project access'}
        <Icon name="chevronDown" size={16} />
      </Button>

      <SettingsSection title={isMeta ? 'Project' : 'Sub-project'}>
        <TextField
          label="Name"
          record={project.id}
          value={project.name}
          limit={LIMITS.projectName}
          disabled={!answer.can_edit}
          readOnly={blocked}
          onCommit={(v, save) => {
            // the toast waits for the server, so a refusal never reads as done
            void P.updateProject(project.id, { name: v }, save.as('name'), shown).then((saved) => {
              if (saved) window.showToast?.(`Renamed to “${v}”`)
            })
          }}
        />
        {isMeta && (
          <TextField
            label="Description"
            record={project.id}
            multiline
            limit={LIMITS.projectDescription}
            value={project.description}
            disabled={!answer.can_edit}
            readOnly={blocked}
            onCommit={(v, save) =>
              P.updateProject(project.id, { description: v }, save.as('description'), shown)
            }
            width={520}
          />
        )}
        <SettingsField
          label="Delay tracking"
          hint={
            trackDelay ? (
              <>
                Yellow: projected to miss the planned end.
                <br />
                Red: projected to miss the due date.
              </>
            ) : (
              'Turn on to highlight tasks projected to miss their planned end or due date.'
            )
          }
        >
          <div className="[display:flex] [align-items:center] [gap:8px]">
            <span
              data-project-delay-toggle
              aria-busy={delayChosen !== null || undefined}
              className="[display:inline-flex]"
            >
              <Toggle
                on={trackDelay}
                disabled={!answer.can_edit || blocked || delayChosen !== null}
                title={trackDelay ? 'Delay tracking is on' : 'Delay tracking is off'}
                onClick={() => {
                  const v = !project.track_delay
                  setDelayChosen(v)
                  void P.updateProject(
                    project.id,
                    { trackDelay: v },
                    { seen: { track_delay: project.track_delay } },
                    shown,
                  ).then((saved) => {
                    setDelayChosen(null)
                    if (saved)
                      window.showToast?.(
                        v ? 'Projected delays are highlighted' : 'Tasks stay neutral',
                      )
                  })
                }}
              />
            </span>
            <span className="[font-size:var(--fs-base)] [color:var(--text-1)]">
              {trackDelay ? 'Projected delays highlighted' : 'Tasks stay neutral'}
            </span>
          </div>
        </SettingsField>
        <ReviewTimeField
          answer={answer}
          disabled={!answer.can_edit}
          readOnly={blocked}
          hint={
            isMeta
              ? 'Remaining time a task gets when it moves into Review. Sub-projects use it unless they set their own.'
              : "Remaining time a task gets when it moves into Review. Empty uses the project's time."
          }
        />
        <SettingsField label="Lead" hint="Controls this project's settings and access.">
          <LeadPicker
            on={{ org_id: project.org_id, project_id: project.id }}
            lead={
              lead && answer.lead?.inherited && !leadChosen
                ? { ...lead, name: `${lead.name} (from the project)` }
                : lead
            }
            disabled={!answer.can_change_lead || blocked}
            busy={leadChosen !== null}
            onPick={(person) => {
              // a pick of the lead shown changes nothing, a legacy
              // sub-project's inherited lead included, which a write would
              // pin to the sub-project, dropping that person's grant on it
              if (person.id === project.lead_id || person.id === answer.lead?.id) return
              setLeadChosen(person)
              void P.updateProject(
                project.id,
                { lead: person.id },
                { seen: { lead_id: project.lead_id } },
                shown,
              ).then(() => setLeadChosen(null))
            }}
          />
        </SettingsField>
      </SettingsSection>
      {topLevel && (
        <SettingsSection title="Sub-projects">
          <div
            data-project-subprojects=""
            className="[display:flex] [flex-direction:column] [gap:6px]"
          >
            {subs.batches.map((batch, i) => (
              <React.Fragment key={batch.id}>
                {batch.rows.map((sp) => (
                  <ProjectSubProject
                    key={sp.id}
                    sp={sp}
                    tag={subTags.get(sp.id)}
                    onOpen={() => setPage(`project:${sp.id}`)}
                  />
                ))}
                <BatchNotes
                  list={subs}
                  batch={batch}
                  last={i === subs.batches.length - 1}
                  what="sub-projects"
                />
              </React.Fragment>
            ))}
            <div ref={subsMore.marker} aria-hidden="true" className="h-px" />
            <SubProjectsEnd
              list={subs}
              end={subsEnd}
              place="page"
              shown={subs.rows.length > 0}
              onMore={subsMore.more}
              hooks={{ end: 'data-project-subprojects-end', more: 'data-project-subprojects-more' }}
              emptyLine="No sub-projects yet."
            />
          </div>
        </SettingsSection>
      )}
      {/* where the phone's Manage people jump lands: just above the box */}
      <div ref={accessHeading} tabIndex={-1} className="settings-access-heading" />
      <SettingsSection
        title="Project access"
        description={
          isMeta
            ? undefined
            : 'Parent project permissions also apply. Changes here affect only this sub-project.'
        }
      >
        <div className="settings-project-members">
          <ProjectAccessEditor
            project={{ id: project.id, org_id: project.org_id }}
            canManageUsers={answer.can_manage_users}
            canManageTeams={answer.can_manage_teams}
            canChangeLead={answer.can_change_lead}
            current={!blocked}
            role={grantRole}
            onRoleChange={setGrantRole}
            onLevel={(kind, id, level, was) =>
              kind === 'team'
                ? P.setProjectTeamAccess(project.id, id, level === 'viewer' ? 'viewer' : 'user', {
                    ...shown,
                    level: was,
                  })
                : P.setProjectAccess(project.id, id, level, {
                    ...shown,
                    level: was,
                    leadId: project.lead_id,
                  })
            }
            onRemove={(kind, id) =>
              removal.press(grant(kind, id), focusAfterAccessRemoval(kind, id))
            }
            checking={(kind, id) => removal.checking(grant(kind, id))}
            removing={(kind, id) => P.removingAccess(grant(kind, id))}
          />
          {removal.window}
          {/* External invitees gain a guest seat with access to this project. */}
          {DEMO_MODE ? (
            <DemoCapabilityNotice>Inviting people is unavailable in the demo.</DemoCapabilityNotice>
          ) : (
            <InviteForm answer={answer} blocked={blocked} />
          )}
          <FieldHint>
            Organization admins retain access. Assigning a new Lead changes the previous Lead to
            User.
          </FieldHint>
        </div>
      </SettingsSection>

      {/* Archive is the answer to almost every reason someone opens this, and
          the window offers it first; the counts come with the window, because
          only the lead may read them and the store holds no archived tasks. */}
      <SettingsSection title="Archive or delete" data-project-removal={project.id}>
        <div className="flex items-center gap-4">
          <p className="min-w-0 flex-1 text-sm leading-normal text-text-2">
            {archiveSentence(topLevel, answer.can_archive, subCount)}
          </p>
          <Button
            ref={removeButton}
            type="button"
            data-remove-project={project.id}
            disabled={!answer.can_archive || blocked}
            title={
              answer.can_archive ? undefined : "Only the project's lead can archive or delete it"
            }
            onClick={onRemove}
          >
            <Icon name="archive" size={16} />
            Archive or delete…
          </Button>
        </div>
      </SettingsSection>
    </>
  )
}

/** What the Archive or delete section says the archive takes along: a
    top-level project names how many sub-projects go with it only once its
    list read to its real end, with nothing stopped or failed, and only for
    someone who may archive it; else it says "its sub-projects". Anything
    else, a sub-project included, goes alone. */
function archiveSentence(topLevel: boolean, canArchive: boolean, count: number | null): string {
  const alone = 'Archive hides it. Delete moves it and its tasks to Deleted items.'
  if (!topLevel || (canArchive && count === 0)) return alone
  if (canArchive && count !== null)
    return `Archive hides it and its ${count} sub-project${count === 1 ? '' : 's'}. Delete moves them and their tasks to Deleted items.`
  return 'Archive hides it and its sub-projects. Delete moves them and their tasks to Deleted items.'
}

/* One sub-project in a project page's Sub-projects section: a bordered
   button that opens its page. */
function ProjectSubProject({
  sp,
  tag,
  onOpen,
}: {
  sp: NavChildRow
  tag?: string
  onOpen: () => void
}) {
  return (
    <Button
      type="button"
      data-project-subproject={sp.id}
      onClick={onOpen}
      title={`Open settings for ${sp.name}`}
      className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [text-align:left] [border:1px_solid_var(--border)] [background:var(--surface-1)] [color:var(--text-1)] [cursor:pointer] [transition:background-color_var(--dur-fast)_var(--ease-out),_border-color_var(--dur-fast)_var(--ease-out)] [font-family:var(--sans)]"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--hover)'
        e.currentTarget.style.borderColor = 'var(--border-strong)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--surface-1)'
        e.currentTarget.style.borderColor = 'var(--border)'
      }}
      variant="unstyled"
    >
      <span className="[font-size:var(--fs-base)] [font-weight:500] [flex:1] [min-width:0]">
        <TaggedName name={sp.name} tag={tag} />
      </span>
      <Icon name="chevronRight" size={16} color="var(--text-2)" />
    </Button>
  )
}

/* The remaining time a task gets on entering Review (#314), as a draft
   against the saved value it began from (lib/savedDraft.ts REVIEW_HOURS),
   saved on blur and Enter. Empty inherits: a sub-project takes its
   project's value, a project the default, which the placeholder shows.
   0 is a real setting, so the parse is never tested for truth. On blur:
   an unparsable entry, and an empty field over an empty saved value, show
   the saved value; a number outside LIMITS.reviewHours stays typed and
   marked with the limit's sentence; a number that rounds to the saved
   value shows it; a value changed elsewhere waits for Use saved or Keep
   mine, and a paused save keeps the text; else it saves, null for an
   empty field, the rounded number otherwise. */
function ReviewTimeField({
  answer,
  disabled,
  readOnly,
  hint,
}: {
  answer: SettingsOk
  disabled: boolean
  readOnly: boolean
  hint: string
}) {
  const { project } = answer
  const draft = useSavedDraft(
    `${project.id}:review_hours`,
    project.review_hours,
    REVIEW_HOURS,
    'review time',
    disabled,
  )
  // a number refused on blur stays typed and marked until the field changes
  const [refused, setRefused] = useStateS(false)
  const inherited = answer.inherited_review_hours
  const save = (hours: number | null, toast: number) => {
    void P.updateProject(project.id, { reviewHours: hours }, draft.save(hours).as('review_hours'), {
      orgId: project.org_id,
    }).then((saved) => {
      if (saved) window.showToast?.(`Review time set to ${toast} h`)
    })
  }
  const commit = (el: HTMLInputElement) => {
    if (disabled || readOnly) return
    const raw = draft.text.trim()
    // an unparsable entry reads as '' too, so it is caught before the
    // empty case would take it for a clear
    const n = Number(raw)
    if (el.validity.badInput || !Number.isFinite(n)) return draft.showSaved()
    if (!raw) {
      if (project.review_hours === null) return draft.showSaved()
      if (draft.conflict || P.refusePausedEdit()) return
      return save(null, inherited)
    }
    // the typed number against the range, as the server checks it, so
    // -0.04 is refused rather than saved as 0
    if (n < LIMITS.reviewHours.min || n > LIMITS.reviewHours.max) {
      setRefused(true)
      window.showToast?.(limitSentence(LIMITS.reviewHours), 'error')
      return
    }
    const h = roundReviewHours(n)
    if (draft.isSaved(String(h))) return draft.showSaved()
    if (draft.conflict || P.refusePausedEdit()) return
    draft.edit(String(h))
    save(h, h)
  }
  return (
    <SettingsField label="Review time" hint={hint}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={LIMITS.reviewHours.min}
          max={LIMITS.reviewHours.max}
          step={0.5}
          data-project-review-hours
          aria-label="Review time"
          aria-invalid={(refused && draft.unsaved) || undefined}
          aria-describedby={draft.conflict ? draft.conflictId : undefined}
          value={draft.text}
          placeholder={String(inherited)}
          disabled={disabled}
          readOnly={readOnly || undefined}
          onChange={(e) => {
            setRefused(false)
            draft.edit(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onBlur={(e) => commit(e.currentTarget)}
          className="h-control w-15 bg-surface-1 px-2.5 text-base font-sans"
        />
        <span className="text-base text-text-2">hours</span>
      </div>
      <DraftConflictLine draft={draft} text={REVIEW_HOURS.text} />
    </SettingsField>
  )
}

/* Invite by email. The press asks the server which seat the address names
   and the level that seat holds on the project (P.projectInviteTarget),
   then sends the invitation with that level as its `expected`, so a seat or
   grant made in between refuses it. Inviting… covers both calls, and the
   field, the level and the button stay off until both answer. The form's
   own level is User or Viewer; once the lookup finds an organization
   viewer for the address, only Viewer for that address, which it says
   rather than change the level unseen. The chosen level stays as it was,
   so another address, or the next invitation, goes out with it again. A
   lookup that fails or refuses sends nothing and says why. */
function InviteForm({ answer, blocked }: { answer: SettingsOk; blocked: boolean }) {
  const { project } = answer
  const [email, setEmail] = useStateS('')
  const [level, setLevel] = useStateS<'user' | 'viewer'>('user')
  // the address the lookup found an organization viewer for
  const [viewerAddress, setViewerAddress] = useStateS<string | null>(null)
  const [inviting, setInviting] = useStateS(false)
  const [note, setNote] = useStateS<string | null>(null)
  /* The seats this form's invitations emailed, newest last, for
     InviteOutcome. Each stays until the page closes, so a later invitation
     does not hide an earlier one's result. */
  const [emailed, setEmailed] = useStateS<{ seat: string; email: string }[]>([])
  useUpdateBlocker(!!email || inviting)
  useUnsaved(!!email.trim(), 'email')
  const typed = email.trim()
  const viewerOnly = viewerAddress !== null && viewerAddress === typed.toLowerCase()
  const sending = viewerOnly ? 'viewer' : level
  const canInvite = answer.can_invite && !blocked
  const invite = async () => {
    if (!canInvite || !typed || inviting) return
    // the lookup would wait for the connection a pause lost
    if (P.refusePausedEdit()) return
    setInviting(true)
    setNote(null)
    const found = await P.projectInviteTarget(project.org_id, project.id, typed)
    if (found === null || found.state !== 'ready') {
      setInviting(false)
      setNote(
        found === null
          ? "Couldn't check this address. Nothing was sent."
          : found.state === 'refused'
            ? sentence(found.message)
            : 'This project is no longer available.',
      )
      return
    }
    if (found.person?.org_role === 'viewer' && sending !== 'viewer') {
      setInviting(false)
      setViewerAddress(typed.toLowerCase())
      setNote(
        `${found.person.name} is an organization viewer, so they can only be given Viewer. Invite again to give them Viewer.`,
      )
      return
    }
    const invited = await P.inviteToProject(project.id, typed, sending, {
      orgId: project.org_id,
      level: found.level,
    })
    setInviting(false)
    if (!invited) return
    window.showToast?.(`${typed} was added to “${project.name}”`)
    const seat = invited.emailed
    if (seat) setEmailed((all) => [...all.filter((e) => e.seat !== seat), { seat, email: typed }])
    setEmail('')
  }
  return (
    <SettingsGroup legend="Invite by email" className="settings-project-invite">
      <div className="[display:flex] [gap:8px]">
        <Input
          data-invite-email
          disabled={!canInvite || inviting}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setNote(null)
          }}
          placeholder="Email address"
          aria-label="Invite by email"
          type="email"
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="h-control w-full bg-surface-1 px-2.5 text-base font-sans [flex:1]"
        />
        <NativeSelect
          data-invite-level
          aria-label="Invitation role"
          disabled={!canInvite || inviting}
          value={sending}
          onChange={(e) => setLevel(e.target.value === 'viewer' ? 'viewer' : 'user')}
          className="h-control w-28 shrink-0 bg-surface-1 text-base font-sans"
        >
          {!viewerOnly && <option value="user">User</option>}
          <option value="viewer">Viewer</option>
        </NativeSelect>
        <Button
          type="button"
          data-invite-send
          aria-busy={inviting || undefined}
          disabled={!canInvite || !typed || inviting}
          onClick={() => void invite()}
        >
          <Icon name="plus" size={16} />
          {inviting ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
      {note && (
        <p role="status" data-invite-note="" className="mt-2 text-sm text-text-2">
          {note}
        </p>
      )}
      {emailed.map((e) => (
        <InviteOutcome key={e.seat} orgId={project.org_id} seat={e.seat} email={e.email} />
      ))}
    </SettingsGroup>
  )
}
