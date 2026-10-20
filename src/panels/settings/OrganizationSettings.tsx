/* Organization identity, access rules and shared display defaults. */
import { useEffect as useEffectS, useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Seg } from '../../components/qivo'
import { PageTitle, SettingsField, SettingsSection } from '../../components/settingsPage'
import { DEMO_MODE } from '../../lib/demoMode'
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
  useUpdateBlocker(dirty || busy)
  useUnsaved(dirty)
  const save = async () => {
    if (busy || !dirty) return
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
        <Input
          value={v}
          data-org-slug
          maxLength={40}
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
          className="h-control w-[200px] max-w-full bg-surface-1 px-2.5 !font-mono text-base"
        />
        <Button
          type="button"
          data-org-slug-save
          disabled={busy || !dirty}
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
  const attachmentUnsaved = useFieldUnsaved(P.editsPaused)
  const plannableUnsaved = useFieldUnsaved(P.editsPaused)
  return (
    <>
      <PageTitle>Organization</PageTitle>
      <SettingsSection title="Name and address">
        <TextField
          label="Organization name"
          value={P.org.name}
          maxLength={P.NAME_MAX}
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
              ? '1–20 MiB, including description images. Existing files are unaffected.'
              : 'Only an organization admin can change the attachment limit.'
          }
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={20}
              step={1}
              data-org-attachment-limit
              aria-label="Max attachment size"
              {...attachmentUnsaved}
              key={`attachment${P.org.maxAttachmentMb}`}
              defaultValue={P.org.maxAttachmentMb ?? 20}
              disabled={!canManage}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={(e) => {
                if (!canManage) return
                const current = P.org.maxAttachmentMb ?? 20
                const raw = e.currentTarget.value.trim()
                const value = Number(raw)
                if (!raw || !Number.isFinite(value)) {
                  e.currentTarget.value = String(current)
                  return
                }
                const mib = Math.max(1, Math.min(20, Math.round(value)))
                e.currentTarget.value = String(mib)
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
        <SettingsField label="Workdays start on" width={330}>
          <NativeSelect
            value={P.org.weekStart ?? 1}
            aria-label="Workdays start on"
            data-week-start
            onChange={(e) => {
              const d = Number(e.target.value)
              void P.setOrg({ weekStart: d }).then((saved) => {
                if (saved) window.showToast?.(`Workdays now start on ${P.WEEKDAYS[d]}`)
              })
            }}
            className="h-control w-60 bg-surface-1 font-sans text-base"
          >
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <option key={d} value={d}>
                {P.WEEKDAYS[d]}
              </option>
            ))}
          </NativeSelect>
        </SettingsField>
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
              min={1}
              max={168}
              step={1}
              data-org-plannable
              aria-label="Default plannable hours per week"
              {...plannableUnsaved}
              key={`dph${P.org.defaultPlannableHours}`}
              defaultValue={P.org.defaultPlannableHours || DEFAULT_PLANNABLE_HOURS}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={(e) => {
                const cur = P.org.defaultPlannableHours || DEFAULT_PLANNABLE_HOURS
                const raw = e.target.value.trim()
                if (!raw || !Number(raw)) {
                  e.target.value = String(cur)
                  return
                }
                const h = Math.max(1, Math.min(168, Math.round(Number(raw))))
                e.target.value = String(h)
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
