import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LIMITS } from '../../../convex/lib/limits'
import { LimitedInput } from '../../components/LimitedField'
import { Avatar, type AvatarSize, Icon, MenuItem, Popover } from '../../components/qivo'
import { SettingsField } from '../../components/settingsPage'
import { cleanName, overLimit } from '../../lib/fieldLimits'
import { PERSON_NAME, useSavedDraft } from '../../lib/savedDraft'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { P, type ToastTone, type UserVM } from '../../store/planner'
import { DraftConflictLine } from './controls'

// Account owners and organization admins share the same avatar controls.
function useAvatarUpload(user: UserVM) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  // The avatar mutators answer an error sentence, or nothing when they worked.
  const toast = (m: string, tone: ToastTone) => window.showToast?.(m, tone)
  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Clear first so choosing the same file triggers another change.
    e.target.value = ''
    if (!file || busy) return
    setBusy(true)
    const err = await P.setAvatar(user.id, file)
    setBusy(false)
    toast(err || 'Picture updated', err ? 'error' : 'success')
  }
  const clear = async () => {
    if (busy) return
    setBusy(true)
    const err = await P.clearAvatar(user.id)
    setBusy(false)
    toast(err || 'Picture removed', err ? 'error' : 'success')
  }
  const input = (
    <Input
      ref={ref}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      onChange={onChange}
      className="[display:none]"
    />
  )
  return { input, busy, clear, pick: () => ref.current?.click() }
}

// Keep the file input outside the closing menu and invoke pick() synchronously
// before close(): opening a file dialog requires the original user activation.
export function AvatarPicker({ user, size = 28 }: { user: UserVM; size?: AvatarSize }) {
  const canEdit = P.canSetAvatar(user.id)
  const { input, busy, clear, pick } = useAvatarUpload(user)
  const source = user.sampleAvatar ? 'Sample portrait' : null
  if (!canEdit) return <Avatar id={user.id} size={size} />
  return (
    <>
      {input}
      <Popover
        width={244}
        wrapStyle={{ display: 'flex', flexShrink: 0 }}
        button={(toggle, open: boolean) => (
          <Button
            type="button"
            className="avatarpick"
            data-avatar-pick={user.id}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={busy}
            title={busy ? 'Uploading…' : `Change ${user.name}’s picture`}
            aria-label={busy ? 'Uploading…' : `Change ${user.name}’s picture`}
            onClick={toggle}
            variant="unstyled"
          >
            <Avatar id={user.id} size={size} />
            <span className="avatarveil">
              <Icon name="camera" size={Math.max(11, Math.round(size * 0.46))} />
            </span>
          </Button>
        )}
      >
        {(close) => (
          <>
            <div className="[padding:4px_8px_8px] [border-bottom:1px_solid_var(--border)] [margin-bottom:4px]">
              <div className="[font-size:var(--fs-base)] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                {user.name}
              </div>
              {source && (
                <div className="[font-size:var(--fs-xs)] [color:var(--text-2)] [line-height:1.45] [margin-top:3px]">
                  {source}
                </div>
              )}
            </div>
            <MenuItem
              onClick={() => {
                pick()
                close()
              }}
            >
              <Icon name="camera" size={14} />
              {user.avatarPath ? 'Change picture…' : 'Upload a picture…'}
            </MenuItem>
            {/* Only private uploads can be removed; sample portraits are demo data. */}
            {user.avatarPath && !user.sampleAvatar && (
              <MenuItem
                danger
                data-avatar-clear={user.id}
                onClick={() => {
                  close()
                  void clear()
                }}
              >
                <Icon name="trash" size={14} />
                Remove picture
              </MenuItem>
            )}
          </>
        )}
      </Popover>
    </>
  )
}

export function AvatarField({ user }: { user: UserVM }) {
  return (
    <SettingsField label="Picture" width={430}>
      <AvatarPicker user={user} size={40} />
    </SettingsField>
  )
}

// An explicit save reports refusals inline and updates the name across seats.
// A draft stays against the name it began from (lib/savedDraft.ts), and Save
// waits while a name changed elsewhere shows under the field.
export function NameField({ me }: { me: Pick<UserVM, 'id' | 'name'> }) {
  const draft = useSavedDraft(`${me.id}:name`, me.name, PERSON_NAME, 'name')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // a refusal was about the name it found; a new one makes it old news
  useEffect(() => setErr(''), [me.name])
  // compared as the store will save it, with runs of spaces collapsed
  const next = cleanName(draft.text)
  const changed = !draft.isSaved(next)
  const tooLong = overLimit(LIMITS.personName, next)
  useUpdateBlocker(busy)
  const save = async () => {
    if (busy || !changed || tooLong || draft.conflict) return
    setBusy(true)
    const saving = draft.save(next)
    const e = await P.setDisplayName(next, saving.as('name'))
    setBusy(false)
    setErr(e || '')
    if (e) saving.refused()
    else {
      saving.accepted()
      window.showToast?.(`You are now “${next}”`)
    }
  }
  return (
    <SettingsField label="Your name" width={470}>
      <div className="flex min-h-10 items-center gap-2">
        <LimitedInput
          limit={LIMITS.personName}
          clean={cleanName}
          value={draft.text}
          data-account-name
          aria-label="Your name"
          aria-describedby={draft.conflict ? draft.conflictId : undefined}
          placeholder="Your name"
          autoComplete="name"
          onChange={(e) => {
            draft.edit(e.target.value)
            setErr('')
          }}
          // show the saved name again when only spaces differ
          onBlur={() => {
            if (!changed) draft.showSaved()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            }
            if (e.key === 'Escape') {
              draft.discard()
              setErr('')
            }
          }}
          wrapperClassName="[flex:1]"
          className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
        />
        <Button
          type="button"
          data-account-name-save
          disabled={busy || !changed || tooLong || !!draft.conflict}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {/* a choice ends the refusal the conflict answered */}
      <DraftConflictLine draft={draft} text={(name) => name} onChoose={() => setErr('')} />
      {/* a refusal is about the draft it kept, and the conflict line says
          what it would, with Use saved and Keep mine */}
      {err && draft.unsaved && !draft.conflict && (
        <div
          data-account-name-error
          className="[font-size:var(--fs-sm)] [color:var(--danger)] [margin-top:8px] [line-height:1.5]"
        >
          {err}
        </div>
      )}
    </SettingsField>
  )
}
