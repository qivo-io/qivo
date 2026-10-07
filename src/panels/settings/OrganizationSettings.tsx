/* Organization identity, access rules and shared display defaults. */
import { useEffect as useEffectS, useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { PageTitle, SettingsField, SettingsSection } from '../../components/settingsPage'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { DEFAULT_PLANNABLE_HOURS } from '../../lib/workload'
import type { OrgPatch } from '../../store/planner'
import { P } from '../../store/planner'
import { OrganizationExport } from '../OrganizationExport'
import { TextField, Toggle } from './controls'

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
  const dirty = v !== current
  useUpdateBlocker(dirty || busy)
  const save = async () => {
    if (busy || !dirty) return
    setBusy(true)
    const e = await P.setOrgSlug(v)
    setBusy(false)
    setErr(e || '')
    if (!e) window.showToast?.(`Address changed to ${stem}${v}`)
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
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            }
          }}
          className="h-control w-[200px] max-w-full bg-surface-1 px-[11px] !font-mono text-base"
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

export function OrgGeneralPage() {
  const canManage = P.isAdmin()
  return (
    <>
      <PageTitle>Organization</PageTitle>
      <SettingsSection title="Name and address">
        <TextField
          label="Organization name"
          value={P.org.name}
          probe="data-org-name"
          onCommit={(v) => {
            P.setOrg({ name: v })
            window.showToast?.('Organization renamed')
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
                P.setOrg({ maxAttachmentMb: mib })
                window.showToast?.(`Attachment limit set to ${mib} MiB`)
              }}
              className="h-control w-15 bg-surface-1 px-[11px] text-base font-sans"
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
              P.setOrg({ dateFormat: e.target.value as OrgPatch['dateFormat'] })
              window.showToast?.(`Date format set to ${e.target.value}`)
            }}
            className="h-control w-60 bg-surface-1 px-[11px] font-sans text-base"
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
              P.setOrg({ weekStart: d })
              window.showToast?.(`Workdays now start on ${P.WEEKDAYS[d]}`)
            }}
            className="h-control w-60 bg-surface-1 px-[11px] font-sans text-base"
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
              P.setOrg({ weekOneRule: e.target.value as OrgPatch['weekOneRule'] })
              window.showToast?.('Week numbering updated')
            }}
            className="h-control w-60 bg-surface-1 px-[11px] font-sans text-base"
          >
            <option value="first4day">First 4-day week (ISO 8601)</option>
            <option value="jan1">Week containing Jan 1</option>
            <option value="firstfull">First full week</option>
          </NativeSelect>
        </SettingsField>
      </SettingsSection>
      <SettingsSection title="People">
        <SettingsField label="Default plannable hours per week" width={400}>
          <div className="[display:flex] [align-items:center] [gap:8px]">
            <Input
              type="number"
              min={1}
              max={168}
              step={1}
              data-org-plannable
              aria-label="Default plannable hours per week"
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
                P.setOrg({ defaultPlannableHours: h })
                window.showToast?.(`New users start on ${h} h per week`)
              }}
              className="h-control w-15 bg-surface-1 px-[11px] text-base font-sans"
            />
            <span className="[font-size:var(--fs-base)] [color:var(--text-2)]">
              h per week, for new users
            </span>
          </div>
        </SettingsField>
        <SettingsField
          label="Profile pictures from Gravatar"
          width={470}
          hint="Sends hashed email addresses to Gravatar for users without an uploaded picture."
        >
          <div className="[display:flex] [align-items:center] [gap:8px]">
            <span data-gravatar-toggle className="[display:inline-flex]">
              <Toggle
                on={P.org.gravatarAvatars}
                title={
                  P.org.gravatarAvatars ? 'Gravatar lookups are on' : 'Gravatar lookups are off'
                }
                onClick={() => {
                  const v = !P.org.gravatarAvatars
                  P.setOrg({ gravatarAvatars: v })
                  window.showToast?.(
                    v ? 'Pictures may come from Gravatar' : 'Gravatar lookups are off',
                  )
                }}
              />
            </span>
            <span className="[font-size:var(--fs-base)] [color:var(--text-1)]">
              {P.org.gravatarAvatars ? 'look pictures up by email address' : 'Do not use Gravatar'}
            </span>
          </div>
        </SettingsField>
      </SettingsSection>
      {canManage && <OrganizationExport key={P.org.id} orgId={P.org.id} />}
    </>
  )
}
