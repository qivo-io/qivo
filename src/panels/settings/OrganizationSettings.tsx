/* Organization identity, access rules and shared display defaults. */
import { useEffect as useEffectS, useRef as useRefS, useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { LIMITS, type Limit } from '../../../convex/lib/limits'
import { LimitedInput } from '../../components/LimitedField'
import { Seg } from '../../components/qivo'
import { PageTitle, SettingsField, SettingsSection } from '../../components/settingsPage'
import { DEMO_MODE } from '../../lib/demoMode'
import { limitSentence, overLimit, wholeIn } from '../../lib/fieldLimits'
import { useFieldUnsaved, useUnsaved } from '../../lib/leaveGuard'
import { creatorPhrase, projectCreatorsIn } from '../../lib/projectCreators'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { DEFAULT_PLANNABLE_HOURS } from '../../lib/workload'
import type { OrgPatch, OrgVM } from '../../store/planner'
import { P } from '../../store/planner'
import { OrganizationDeletion } from '../OrganizationDeletion'
import { OrganizationExport } from '../OrganizationExport'
import { TextField } from './controls'

// Address changes need an explicit save and an inline refusal. The store checks
// the format locally; reserved names remain a server-owned rule.
function OrgAddressField() {
  // from the live origin, so it reads truthfully in dev and on previews rather
  // than promising a production domain this build may not be served from
  const stem = `${location.host}/app/`
  const current = P.org.slug || ''
  const [v, setV] = useStateS(current)
  const [err, setErr] = useStateS('')
  const [busy, setBusy] = useStateS(false)
  useEffectS(() => {
    setV(P.org.slug || '')
    setErr('')
  }, [P.org.slug])
  // compared as the store will save it, so surrounding spaces are no change
  const next = v.trim()
  const dirty = next !== current
  const tooLong = overLimit(LIMITS.slug, next)
  useUpdateBlocker(dirty || busy)
  useUnsaved(dirty, 'address')
  const save = async () => {
    if (busy || !dirty || tooLong) return
    setBusy(true)
    const e = await P.setOrgSlug(next)
    setBusy(false)
    setErr(e || '')
    if (!e) window.showToast?.(`Address changed to ${stem}${next}`)
  }
  return (
    <SettingsField
      label="Address"
      width={470}
      hint="Changing this breaks existing links immediately and releases the old address for reuse."
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all text-base text-text-2 !font-mono">{stem}</span>
        <LimitedInput
          limit={LIMITS.slug}
          value={v}
          data-org-slug
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          // lowercased on the way in: organizations_slug_check REFUSES an
          // uppercase letter rather than folding it, so pasting the company
          // name would otherwise bounce for a reason the hint does not cover
          onChange={(e) => {
            setV(e.target.value.toLowerCase())
            setErr('')
          }}
          // show the saved address again when only spaces differ
          onBlur={() => {
            if (!dirty) setV(current)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            }
          }}
          wrapperClassName="w-[200px] max-w-full"
          className="h-control w-full bg-surface-1 px-2.5 !font-mono text-base"
        />
        <Button
          type="button"
          data-org-slug-save
          disabled={busy || !dirty || tooLong}
          onClick={() => void save()}
          className="shrink-0"
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {err && (
        <div
          data-org-slug-error
          className="[font-size:var(--fs-sm)] [color:var(--danger)] [margin-top:8px] [line-height:1.5]"
        >
          {err}
        </div>
      )}
    </SettingsField>
  )
}

/* The week-start save in flight for each organization. It outlives the
   field, so a field opened again before the answer stays disabled until that
   save settles, and its next choice is sent against the saved day. */
const weekStartSaves = new Map<string, Promise<boolean>>()

// The first day of each roadmap week. The server refuses a day that would
// put two milestones of one project in one week, or that it could not check
// against every milestone; the setting stays as it was and the refusal shows
// under it, long enough to read the projects and dates it names, until the
// next choice. The select waits for each answer, also across leaving and
// opening the page again, so an answer always belongs to the choice on screen
// and the next choice is sent against the saved day.
function WeekStartField() {
  const orgId = P.org.id
  const [refusal, setRefusal] = useStateS('')
  const [busy, setBusy] = useStateS(() => weekStartSaves.has(orgId))
  // a refusal that comes after the page has gone is toasted instead
  const mounted = useRefS(true)
  useEffectS(() => {
    mounted.current = true
    const pending = weekStartSaves.get(orgId)
    setBusy(pending !== undefined)
    void pending?.then(() => {
      if (mounted.current) setBusy(false)
    })
    return () => {
      mounted.current = false
    }
  }, [orgId])
  const refused = (sentence: string) => {
    if (!mounted.current) return false
    setRefusal(sentence)
    return true
  }
  // wide enough for the refusal; the select keeps its own width
  return (
    <SettingsField label="Workdays start on" width={560}>
      <NativeSelect
        value={P.org.weekStart ?? 1}
        aria-label="Workdays start on"
        aria-describedby={refusal ? 'week-start-refusal' : undefined}
        aria-busy={busy || undefined}
        disabled={busy}
        data-week-start
        onChange={(e) => {
          if (busy) return
          const d = Number(e.target.value)
          setRefusal('')
          setBusy(true)
          const save = P.setOrg({ weekStart: d }, refused).then((saved) => {
            if (weekStartSaves.get(orgId) === save) weekStartSaves.delete(orgId)
            if (mounted.current) setBusy(false)
            if (saved) window.showToast?.(`Workdays now start on ${P.WEEKDAYS[d]}`)
            return saved
          })
          weekStartSaves.set(orgId, save)
        }}
        className="h-control w-60 bg-surface-1 font-sans text-base"
      >
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <option key={d} value={d}>
            {P.WEEKDAYS[d]}
          </option>
        ))}
      </NativeSelect>
      {refusal && (
        <div
          id="week-start-refusal"
          role="alert"
          data-week-start-refusal
          className="[font-size:var(--fs-sm)] [color:var(--danger)] [margin-top:8px] [line-height:1.5]"
        >
          {refusal}
        </div>
      )}
    </SettingsField>
  )
}

/* The segments of "Who can create new projects?" and the toast after
   choosing each, keyed by the setting so a new value needs both. */
const CREATOR_SETTINGS: Record<OrgVM['projectCreators'], { label: string; toast: string }> = {
  admins: { label: 'Org admins', toast: 'Only org admins can create projects' },
  users: { label: 'Standard users', toast: 'All standard users can create projects' },
  selected: { label: 'Selected users', toast: 'Selected users can create projects' },
}

// Who may create top-level projects besides org admins. The line under the
// control names who can right now, by the rule projects.create enforces, so
// an admin never has to work out who a setting covers.
function ProjectCreatorsField({ setPage }: { setPage: (page: string) => void }) {
  const setting = P.org.projectCreators
  const question = 'Who can create new projects?'
  const names = creatorPhrase(projectCreatorsIn(P.homeUsers(), setting))
  return (
    <SettingsField
      label={question}
      width={560}
      hint={
        <span data-project-creators-summary>
          {names.map((part, i) =>
            part.name ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the phrase is re-derived each render and two people may share a name; position is a part's only identity
              <span key={i} className="text-text-1">
                {part.text}
              </span>
            ) : (
              part.text
            ),
          )}{' '}
          can create projects.
          {setting === 'admins' && ' Project leads still create sub-projects.'}
          {setting === 'selected' && (
            <>
              {' '}
              Choose who in{' '}
              <Button
                type="button"
                variant="unstyled"
                data-project-creators-users
                onClick={() => setPage('org-users')}
                className="align-baseline font-normal text-text-1 underline underline-offset-4"
              >
                Users
              </Button>
              .
            </>
          )}
        </span>
      }
    >
      <fieldset data-project-creators className="m-0 min-w-0 border-0 p-0" aria-label={question}>
        <Seg
          value={setting}
          onChange={(next) => {
            void P.setOrg({ projectCreators: next }).then((saved) => {
              if (saved) window.showToast?.(CREATOR_SETTINGS[next].toast)
            })
          }}
          options={Object.entries(CREATOR_SETTINGS).map(([value, { label }]) => ({
            value,
            label,
          }))}
        />
      </fieldset>
    </SettingsField>
  )
}

export function OrgGeneralPage({ setPage }: { setPage: (page: string) => void }) {
  const canManage = P.isAdmin()
  // numbers typed and not yet saved (the fields save on blur)
  const attachmentUnsaved = useFieldUnsaved(
    P.editsPaused,
    `${P.org.maxAttachmentMb}`,
    'attachment size',
  )
  const plannableUnsaved = useFieldUnsaved(
    P.editsPaused,
    `${P.org.defaultPlannableHours}`,
    'plannable hours',
  )
  // a number refused on blur stays typed and marked until that field changes
  const [attachmentRefused, setAttachmentRefused] = useStateS(false)
  const [plannableRefused, setPlannableRefused] = useStateS(false)
  const refuse = (mark: (refused: boolean) => void, limit: Limit) => {
    mark(true)
    window.showToast?.(limitSentence(limit), 'error')
  }
  return (
    <>
      <PageTitle>Organization</PageTitle>
      <SettingsSection title="Name and address">
        <TextField
          label="Organization name"
          value={P.org.name}
          limit={LIMITS.orgName}
          probe="data-org-name"
          onCommit={(v) => {
            // the toast waits for the server, so a refusal never reads as done
            void P.setOrg({ name: v }).then((saved) => {
              if (saved) window.showToast?.('Organization renamed')
            })
          }}
        />
        <OrgAddressField />
      </SettingsSection>
      <SettingsSection title="Access and limits">
        <SettingsField
          label="Max attachment size"
          width={400}
          hint={
            canManage
              ? `${LIMITS.attachmentLimit.min}–${LIMITS.attachmentLimit.max} MiB, including description images. Existing files are unaffected.`
              : 'Only an organization admin can change the attachment limit.'
          }
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={LIMITS.attachmentLimit.min}
              max={LIMITS.attachmentLimit.max}
              step={1}
              data-org-attachment-limit
              aria-label="Max attachment size"
              aria-invalid={attachmentRefused || undefined}
              {...attachmentUnsaved}
              key={`attachment${P.org.maxAttachmentMb}`}
              defaultValue={P.org.maxAttachmentMb ?? LIMITS.attachmentLimit.max}
              disabled={!canManage}
              onChange={() => setAttachmentRefused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={(e) => {
                if (!canManage) return
                const current = P.org.maxAttachmentMb ?? LIMITS.attachmentLimit.max
                const raw = e.currentTarget.value.trim()
                if (!raw) {
                  e.currentTarget.value = String(current)
                  return
                }
                const mib = wholeIn(LIMITS.attachmentLimit, raw)
                if (mib === null) return refuse(setAttachmentRefused, LIMITS.attachmentLimit)
                if (mib === current) return
                void P.setOrg({ maxAttachmentMb: mib }).then((saved) => {
                  if (saved) window.showToast?.(`Attachment limit set to ${mib} MiB`)
                })
              }}
              className="h-control w-15 bg-surface-1 px-2.5 text-base font-sans"
            />
            <span className="text-base text-text-2">MiB per file</span>
          </div>
        </SettingsField>
      </SettingsSection>
      <SettingsSection title="Calendar">
        <SettingsField label="Date format" width={330}>
          <NativeSelect
            value={P.org.dateFormat || 'YYYY-MM-DD'}
            onChange={(e) => {
              const format = e.target.value as OrgPatch['dateFormat']
              void P.setOrg({ dateFormat: format }).then((saved) => {
                if (saved) window.showToast?.(`Date format set to ${format}`)
              })
            }}
            className="h-control w-60 bg-surface-1 font-sans text-base"
          >
            {P.DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}, {P.fmtFullWith(f, new Date())}
              </option>
            ))}
          </NativeSelect>
        </SettingsField>
        <WeekStartField />
        <SettingsField label="Week 1 of the year" width={330}>
          <NativeSelect
            value={P.org.weekOneRule || 'first4day'}
            aria-label="Week 1 of the year"
            data-week-one
            onChange={(e) => {
              const rule = e.target.value as OrgPatch['weekOneRule']
              void P.setOrg({ weekOneRule: rule }).then((saved) => {
                if (saved) window.showToast?.('Week numbering updated')
              })
            }}
            className="h-control w-60 bg-surface-1 font-sans text-base"
          >
            <option value="first4day">First 4-day week (ISO 8601)</option>
            <option value="jan1">Week containing Jan 1</option>
            <option value="firstfull">First full week</option>
          </NativeSelect>
        </SettingsField>
      </SettingsSection>
      <SettingsSection title="People">
        <ProjectCreatorsField setPage={setPage} />
        <SettingsField label="Default plannable hours per week" width={400}>
          <div className="[display:flex] [align-items:center] [gap:8px]">
            <Input
              type="number"
              min={LIMITS.plannableHours.min}
              max={LIMITS.plannableHours.max}
              step={1}
              data-org-plannable
              aria-label="Default plannable hours per week"
              aria-invalid={plannableRefused || undefined}
              {...plannableUnsaved}
              key={`dph${P.org.defaultPlannableHours}`}
              defaultValue={P.org.defaultPlannableHours || DEFAULT_PLANNABLE_HOURS}
              onChange={() => setPlannableRefused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={(e) => {
                const cur = P.org.defaultPlannableHours || DEFAULT_PLANNABLE_HOURS
                const raw = e.target.value.trim()
                if (!raw) {
                  e.target.value = String(cur)
                  return
                }
                const h = wholeIn(LIMITS.plannableHours, raw)
                if (h === null) return refuse(setPlannableRefused, LIMITS.plannableHours)
                if (h === cur) return
                void P.setOrg({ defaultPlannableHours: h }).then((saved) => {
                  if (saved) window.showToast?.(`New users start on ${h} h per week`)
                })
              }}
              className="h-control w-15 bg-surface-1 px-2.5 text-base font-sans"
            />
            <span className="[font-size:var(--fs-base)] [color:var(--text-2)]">
              h per week, for new users
            </span>
          </div>
        </SettingsField>
      </SettingsSection>
      {canManage && <OrganizationExport key={P.org.id} orgId={P.org.id} />}
      {canManage && !DEMO_MODE && (
        <OrganizationDeletion key={`deletion:${P.org.id}`} orgId={P.org.id} orgName={P.org.name} />
      )}
    </>
  )
}
